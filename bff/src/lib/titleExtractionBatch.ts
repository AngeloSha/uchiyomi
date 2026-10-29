// Durable local cover-title generation. The existing extraction worker remains the only inference consumer.
import{randomUUID}from'node:crypto';
import{q,one,tx}from'./db';
import{runtime}from'./runtime';
import{SYSTEM_CTX,visibleToAll,visible,Params,type ViewCtx}from'./visibility';
import{FIRST_PAGE}from'./seriesArt';
import{readTitleLogo}from'./titleArt';
import{msUntilHour}from'./backup';
import{titleExtractorHealth,ExtractionError}from'./titleExtractionWorker';
import{titleExtractionCapabilities,titleExtractionCover,createTitleExtraction,titleExtractionsSettled,titleExtractionJobSettled,titleExtractionWorkerBusy,
  titleExtractionJobInFlight,titleExtractionVerificationContext,recoverCompletedBatchJob,cancelBatchTitleExtraction,collectBatchTitleExtractions,BATCH_RETENTION_DAYS,type JobRow}from'./titleExtraction';

const LOCK=91826525,HOUR=3,MAX_ATTEMPTS=3;
type ItemStatus='pending'|'processing'|'ready'|'applied'|'skipped'|'failed'|'cancelled';
interface RunRow{id:string;origin:'manual'|'nightly';status:'running'|'completed'|'cancelled'|'error';started_at:Date;finished_at:Date|null;retry_errors:boolean}
interface ItemRow{id:string;run_id:string;series_id:string|null;status:ItemStatus;job_id:string|null;attempts:number;retry_at:Date;reason:string|null}
interface Settings{automatic_cover_title_generation:boolean;automatic_cover_title_apply:boolean;cover_title_next_run_at:Date|null}
export interface TitleExtractionBatchStatus{
 enabled:boolean;applyEnabled:boolean;available:boolean;checkedApplyAvailable:boolean;running:boolean;
 schedule:{hour:number;timezone:string;nextRunAt:string|null};retentionDays:number;nextRetryAt:string|null;pausedReason:string|null;
 run:null|{id:string;origin:'manual'|'nightly';status:RunRow['status'];startedAt:string;finishedAt:string|null;
 counts:{total:number;pending:number;processing:number;ready:number;applied:number;skipped:number;failed:number;cancelled:number};currentSeries:{id:string;title:string}|null};
 reviewCount:number;reviewSeries:Array<{id:string;title:string;jobId:string}>;
}
const iso=(date:Date|string|null|undefined)=>date?new Date(date).toISOString():null;
const settings=()=>one<Settings>('SELECT automatic_cover_title_generation,automatic_cover_title_apply,cover_title_next_run_at FROM server_settings WHERE id=1');
let stopped=false,driving:Promise<void>|null=null,timer:ReturnType<typeof setTimeout>|null=null;
let clock=()=>Date.now(),model=async()=>(await titleExtractorHealth())?.modelFingerprint??null;
/** Deterministic time/model seams; production never supplies metadata or identity from a request. */
export function setTitleExtractionBatchForTests(deps?:{now?:()=>number;model?:()=>Promise<string|null>}){clock=deps?.now??(()=>Date.now());model=deps?.model??(async()=>(await titleExtractorHealth())?.modelFingerprint??null);}
export const nextTitleExtractionNight=(now=Date.now())=>new Date(now+msUntilHour(HOUR,new Date(now)));
export const titleExtractionBatchSettled=()=>driving??Promise.resolve();

export async function titleExtractionBatchStatus(viewer:ViewCtx=SYSTEM_CTX):Promise<TitleExtractionBatchStatus>{
 const[s,cap,run]=await Promise.all([settings(),titleExtractionCapabilities(),one<RunRow>(`SELECT * FROM title_extraction_runs ORDER BY(status='running') DESC,started_at DESC LIMIT 1`)]);
 let detail:TitleExtractionBatchStatus['run']=null,nextRetryAt:null|string=null,pausedReason:string|null=null;
 if(run){
  const[totals]=await q<any>(`SELECT count(*)::int total,count(*)FILTER(WHERE status='pending')::int pending,count(*)FILTER(WHERE status='processing')::int processing,
   count(*)FILTER(WHERE status='ready')::int ready,count(*)FILTER(WHERE status='applied')::int applied,count(*)FILTER(WHERE status='skipped')::int skipped,
   count(*)FILTER(WHERE status='failed')::int failed,count(*)FILTER(WHERE status='cancelled')::int cancelled,
   min(retry_at)FILTER(WHERE status='pending' AND retry_at>now()) next_retry FROM title_extraction_items WHERE run_id=$1`,[run.id]);
  const p=new Params(),rid=p.add(run.id),allowed=visible('s',viewer,p);
  const current=await one<{id:string;title:string}>(`SELECT s.id,s.title FROM title_extraction_items i JOIN lib_series s ON s.id=i.series_id WHERE i.run_id=${rid} AND i.status='processing' AND ${allowed} LIMIT 1`,p.values);
  const{next_retry,...counts}=totals;nextRetryAt=iso(next_retry);detail={id:run.id,origin:run.origin,status:run.status,startedAt:iso(run.started_at)!,finishedAt:iso(run.finished_at),counts,currentSeries:current};
  if(run.status==='running')pausedReason=!cap.available?'worker_unavailable':(await one<{reason:string}>(`SELECT reason FROM title_extraction_items WHERE run_id=$1 AND status='pending' AND reason='extraction_storage_full' LIMIT 1`,[run.id]))?.reason??null;
 }
 const p=new Params(),allowed=visible('s',viewer,p);
 const reviews=await q<{id:string;title:string;jobId:string;total:number}>(`SELECT s.id,s.title,j.id AS "jobId",count(*)OVER()::int total FROM series_title_extractions j JOIN lib_series s ON s.id=j.series_id
  WHERE j.batch_item_id IS NOT NULL AND j.status='ready' AND j.expires_at>now() AND ${allowed} ORDER BY j.created_at DESC LIMIT 10`,p.values);
 return{enabled:!!s?.automatic_cover_title_generation,applyEnabled:!!s?.automatic_cover_title_apply,available:cap.available,checkedApplyAvailable:cap.checkedApplyAvailable,
  running:run?.status==='running',schedule:{hour:HOUR,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,nextRunAt:s?.automatic_cover_title_generation?iso(s.cover_title_next_run_at):null},
  run:detail,retentionDays:BATCH_RETENTION_DAYS,nextRetryAt,pausedReason,reviewCount:reviews[0]?.total??0,reviewSeries:reviews.map(({id,title,jobId})=>({id,title,jobId}))};
}

/** Starting a run snapshots target IDs only. Cover reads/model work happen later, one at a time. */
export async function runTitleExtractionBatch(userId:string|null,options:{retryErrors?:boolean;origin?:'manual'|'nightly'}={}){
 if(!(await titleExtractionCapabilities()).available)throw new ExtractionError('worker_unavailable');
 const id=await tx(async qq=>{
  await qq('SELECT pg_advisory_xact_lock($1)',[LOCK]);
  const[existing]=await qq<{id:string}>("SELECT id FROM title_extraction_runs WHERE status='running' FOR UPDATE");if(existing)return existing.id;
  if(options.origin==='nightly'){
   const[s]=await qq<Settings>('SELECT automatic_cover_title_generation FROM server_settings WHERE id=1 FOR SHARE');
   if(!s?.automatic_cover_title_generation)throw new ExtractionError('generation_disabled',409);
  }
  const id=randomUUID();await qq('INSERT INTO title_extraction_runs(id,origin,created_by,retry_errors)VALUES($1,$2,$3,$4)',[id,options.origin??'manual',userId,!!options.retryErrors]);
  await qq(`INSERT INTO title_extraction_items(id,run_id,series_id,series_key) SELECT gen_random_uuid(),$1,s.id,s.id FROM lib_series s WHERE ${visibleToAll('s')}`,[id]);
  return id;
 });
 wakeTitleExtractionBatch();return id;
}

export async function cancelTitleExtractionBatch(runId:string){
 const active=await tx(async qq=>{
  await qq('SELECT pg_advisory_xact_lock($1)',[LOCK]);
  const[run]=await qq<RunRow>('SELECT * FROM title_extraction_runs WHERE id=$1 FOR UPDATE',[runId]);
  if(!run)throw new ExtractionError('not_found',404);
  if(run.status!=='running')return []as string[];
  const items=await qq<{id:string;status:string}>(`UPDATE title_extraction_items i SET status=COALESCE((SELECT j.status FROM series_title_extractions j
    WHERE j.id=i.job_id AND j.status IN('ready','applied')),'cancelled'),reason='cancelled' WHERE i.run_id=$1 AND i.status IN('pending','processing') RETURNING i.id,i.status`,[runId]);
  await qq("UPDATE title_extraction_runs SET status='cancelled',finished_at=now() WHERE id=$1",[runId]);return items.filter(i=>i.status==='cancelled').map(i=>i.id);
 });
 for(const id of active)await cancelBatchTitleExtraction(id);
}

async function protectedReason(id:string):Promise<string|null>{
 const row=await one<{mode:string;first_page:boolean;provider:boolean}>(`SELECT COALESCE(a.mode,'automatic') mode,COALESCE(o.cover=$2,false) first_page,
  (a.auto_file IS NOT NULL AND a.auto_cover_key IS NULL) provider FROM lib_series s LEFT JOIN series_title_art a ON a.series_id=s.id LEFT JOIN series_overrides o ON o.series_id=s.id
  WHERE s.id=$1 AND ${visibleToAll('s')}`,[id,FIRST_PAGE]);
 if(!row)return'series_unavailable';if(row.mode!=='automatic')return'manual_choice';if(row.first_page)return'first_page';
 if(row.provider&&await readTitleLogo(id))return'existing_logo';
 if(await one(`SELECT id FROM series_title_extractions WHERE series_id=$1 AND expires_at>now() AND status IN('queued','running','ready') AND(NOT automatic OR mask_revision>0) LIMIT 1`,[id]))return'manual_preview';
 return null;
}
async function finish(item:ItemRow,status:ItemStatus,reason:string|null=null){
 await q("UPDATE title_extraction_items SET status=$2,reason=$3 WHERE id=$1 AND status='processing'",[item.id,status,reason]);
}
async function claim():Promise<(ItemRow&{retry_errors:boolean})|null>{
 return tx(async qq=>{
  await qq('SELECT pg_advisory_xact_lock($1)',[LOCK]);
  const[run]=await qq<RunRow>("SELECT * FROM title_extraction_runs WHERE status='running' FOR UPDATE");if(!run)return null;
  if((await qq("SELECT id FROM title_extraction_items WHERE run_id=$1 AND status='processing' LIMIT 1",[run.id])).length)return null;
  const[item]=await qq<ItemRow>("SELECT * FROM title_extraction_items WHERE run_id=$1 AND status='pending' AND retry_at<=now() ORDER BY retry_at,id LIMIT 1 FOR UPDATE",[run.id]);
  if(!item){
   if(!(await qq("SELECT id FROM title_extraction_items WHERE run_id=$1 AND status='pending' LIMIT 1",[run.id])).length)
    await qq("UPDATE title_extraction_runs SET status='completed',finished_at=now() WHERE id=$1",[run.id]);
   return null;
  }
  await qq("UPDATE title_extraction_items SET status='processing',attempts=attempts+1,reason=NULL WHERE id=$1",[item.id]);
  return{...item,attempts:item.attempts+1,retry_errors:run.retry_errors};
 });
}

async function processItem(item:ItemRow&{retry_errors:boolean}){
 let fingerprint:string|null=null,modelFingerprint:string|null=null;
 let context:{key:string;publicationRequested:boolean}|null=null;
 try{
  if(!item.series_id){await finish(item,'skipped','series_unavailable');return;}
  await cancelBatchTitleExtraction(item.id);
  const reason=await protectedReason(item.series_id);if(reason){await finish(item,'skipped',reason);return;}
  const cover=await titleExtractionCover(item.series_id,SYSTEM_CTX);fingerprint=cover.fingerprint;modelFingerprint=await model();
  if(!modelFingerprint)throw new ExtractionError('worker_unavailable');
  context=await titleExtractionVerificationContext(cover.snapshot,modelFingerprint);
  const previous=await one<{source_fingerprint:string;model_fingerprint:string;outcome:string;retry_at:Date|null;verification_key:string;publication_requested:boolean}>('SELECT * FROM series_title_extraction_history WHERE series_id=$1',[item.series_id]);
  if(previous?.source_fingerprint===fingerprint&&previous.model_fingerprint===modelFingerprint){
   const failed=['failed','no_text','rejected'].includes(previous.outcome);
   const sameChecks=previous.verification_key===context.key;
   if(previous.outcome==='applied'||sameChecks&&(!failed&&(!context.publicationRequested||previous.publication_requested)
      ||failed&&!item.retry_errors&&previous.retry_at&&new Date(previous.retry_at).getTime()>clock())){
    await finish(item,'skipped',failed?'previous_failure_cooldown':'unchanged');return;
   }
  }
  const created=await createTitleExtraction(item.series_id,null,SYSTEM_CTX,{exclusions:[]},true,{itemId:item.id,cover});
  await titleExtractionJobSettled(created.id);
  if(stopped||runtime.stopping)return;
  const job=await one<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1',[created.id]);
  const current=await one<{status:string}>('SELECT status FROM title_extraction_items WHERE id=$1',[item.id]);if(current?.status!=='processing')return;
  if(!job)throw new ExtractionError('extract_interrupted');
  if(job.status==='ready'||job.status==='applied'){
   await recoverCompletedBatchJob(job.id);
   await finish(item,job.status);await storeHistory(item.series_id,fingerprint,job.model_fingerprint??modelFingerprint,job.status,null,context);
   await collectBatchTitleExtractions(item.series_id,job.id);return;
  }
  throw new ExtractionError(job.error??(job.status==='rejected'?'rejected':'extract_failed'));
 }catch(error){
  if(stopped||runtime.stopping)return;
  const code=error instanceof ExtractionError?error.code:'extract_failed';
  const current=await one<{status:string}>('SELECT status FROM title_extraction_items WHERE id=$1',[item.id]);if(current?.status!=='processing')return;
  await cancelBatchTitleExtraction(item.id);
  if(['batch_protected','stale_candidate','stale_cover','batch_cancelled'].includes(code)){await finish(item,'skipped',code);return;}
  const transient=['worker_unavailable','extract_busy','extract_timeout','extract_interrupted'].includes(code);
  if(code==='extraction_storage_full'||transient&&item.attempts<MAX_ATTEMPTS){
   const delay=code==='extraction_storage_full'?60*60_000:5*60_000*2**(item.attempts-1);
   await q("UPDATE title_extraction_items SET status='pending',reason=$2,retry_at=now()+($3::int*interval '1 millisecond') WHERE id=$1 AND status='processing'",[item.id,code,delay]);return;
  }
  await finish(item,'failed',code);
  if(item.series_id&&fingerprint&&modelFingerprint)await storeHistory(item.series_id,fingerprint,modelFingerprint,code==='no_text'?'no_text':code==='rejected'?'rejected':'failed',new Date(clock()+(transient?6*60*60_000:7*24*60*60_000)),context);
 }
}
async function storeHistory(seriesId:string,fingerprint:string,modelFingerprint:string,outcome:string,retryAt:Date|null,context:{key:string;publicationRequested:boolean}|null){
 await q(`INSERT INTO series_title_extraction_history(series_id,source_fingerprint,model_fingerprint,outcome,retry_at,verification_key,publication_requested)VALUES($1,$2,$3,$4,$5,$6,$7)
  ON CONFLICT(series_id)DO UPDATE SET source_fingerprint=$2,model_fingerprint=$3,outcome=$4,retry_at=$5,verification_key=$6,publication_requested=$7,processed_at=now()`,
  [seriesId,fingerprint,modelFingerprint,outcome,retryAt,context?.key??'',context?.publicationRequested??false]);
}

export function wakeTitleExtractionBatch(){
 if(stopped||runtime.stopping||driving)return;
 driving=Promise.resolve().then(async()=>{
  await reconcileStrandedItems();
  while(!stopped&&!runtime.stopping){
   if(titleExtractionWorkerBusy())await titleExtractionsSettled();
   if(stopped||runtime.stopping||!(await titleExtractionCapabilities()).available)break;
   if(await one(`SELECT i.id FROM title_extraction_items i JOIN title_extraction_runs r ON r.id=i.run_id WHERE r.status='running'
    AND i.status='pending' AND i.reason='extraction_storage_full' AND i.retry_at>now() LIMIT 1`))break;
   const item=await claim();if(!item)break;
   const run=await one<RunRow>('SELECT * FROM title_extraction_runs WHERE id=$1',[item.run_id]);
   if(run?.origin==='nightly'&&!(await settings())?.automatic_cover_title_generation){await cancelTitleExtractionBatch(run.id);break;}
   await processItem(item);
  }
 }).catch(()=>{}).finally(()=>{driving=null;});
}

/** After an infrastructure failure, retry orphaned work without requiring an application restart. */
async function reconcileStrandedItems(){
 const items=await q<ItemRow>(`SELECT i.* FROM title_extraction_items i JOIN title_extraction_runs r ON r.id=i.run_id
  WHERE r.status='running' AND i.status='processing'`);
 for(const item of items){
  if(item.job_id&&titleExtractionJobInFlight(item.job_id))continue;
  if(item.job_id){try{if(await recoverCompletedBatchJob(item.job_id))continue;}catch(error){
    if(error instanceof ExtractionError){await finish(item,error.code.startsWith('stale_')?'skipped':'failed',error.code);continue;}
    throw error;
  }}
  await cancelBatchTitleExtraction(item.id);
  await q("UPDATE title_extraction_items SET status='pending',reason='interrupted',retry_at=now() WHERE id=$1 AND status='processing'",[item.id]);
 }
}

export async function initializeTitleExtractionBatch(){
 // Leave committed ready/applied jobs processing until the post-start reconciler can replay guarded publication.
 // Boot performs no cover fetch or inference, and never converts an unperformed publication into a completed outcome.
 await q(`UPDATE title_extraction_items i SET status='pending',reason='interrupted',retry_at=now() WHERE i.status='processing'
  AND NOT EXISTS(SELECT 1 FROM series_title_extractions j WHERE j.id=i.job_id AND j.status IN('ready','applied'))`);
 const s=await settings();if(s?.automatic_cover_title_generation&&!s.cover_title_next_run_at)
  await q('UPDATE server_settings SET cover_title_next_run_at=$1 WHERE id=1',[nextTitleExtractionNight(clock())]);
 stopped=false;
}
export async function titleExtractionBatchTick(){
 if(stopped||runtime.stopping)return;
 const s=await settings();
 if(s?.automatic_cover_title_generation){
  if(!s.cover_title_next_run_at)await q('UPDATE server_settings SET cover_title_next_run_at=$1 WHERE id=1',[nextTitleExtractionNight(clock())]);
  else if(new Date(s.cover_title_next_run_at).getTime()<=clock()&&(await titleExtractionCapabilities()).available){
   await runTitleExtractionBatch(null,{origin:'nightly'});
   await q('UPDATE server_settings SET cover_title_next_run_at=$1 WHERE id=1',[nextTitleExtractionNight(clock())]);
  }
 }else{
  const run=await one<RunRow>("SELECT * FROM title_extraction_runs WHERE status='running' AND origin='nightly'");if(run)await cancelTitleExtractionBatch(run.id);
 }
 wakeTitleExtractionBatch();
}
export function startTitleExtractionBatch(log:{warn(message:string):void}){
 stopped=false;
 const tick=async()=>{try{await titleExtractionBatchTick();}catch{log.warn('cover title generation: retrying later');}
  finally{if(!stopped&&!runtime.stopping){timer=setTimeout(()=>void tick(),30_000);timer.unref();}}};
 timer=setTimeout(()=>void tick(),1000);timer.unref();return stopTitleExtractionBatch;
}
export function stopTitleExtractionBatch(){stopped=true;if(timer)clearTimeout(timer);timer=null;}
