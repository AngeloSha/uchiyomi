// A local cutout is a private draft until an administrator applies it, or calibrated opt-in checks pass.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { env } from '../env';
import { q, one, tx } from './db';
import { automaticAniListAllowed, withAniListMutation, type ScopedQuery } from './anilistPolicy';
import { fetchVerifiedAniListTitles } from './anilist';
import { runtime } from './runtime';
import { ART_MAX_BYTES, FIRST_PAGE } from './seriesArt';
import { coverSelectionKey, coverSelectionSql, coverSelectionHashSql } from './coverSelection';
import { SYSTEM_CTX, Params, seriesVisible, viewCtxFor, visible, visibleToAll, type ViewCtx } from './visibility';
import { changeTitleArt, applyAutomaticCoverTitle, normalizeTitleLogo, TitleArtError } from './titleArt';
import { ExtractionError, extractCoverTitle, titleExtractorReady, titleExtractorHealth, type ExtractionRect } from './titleExtractionWorker';
import { assessCoverTitleCandidate, coverTitleOcrCapability, stopCoverTitleOcr } from './coverTitleOcr';
import type { CoverTitleQualityResult } from './coverTitleQuality';
import { projectTitleAlpha, sourceRgba } from './titleMaskProjection';
import { rasterizeTitleMask, type MaskStroke } from './titleMaskRaster';

export const EXTRACTION_DIR = join(env.CACHE_DIR,'title-extractions');
const MAX_JOBS = 32, MAX_QUEUED = 8, TIMEOUT_MS = 90_000;
export const BATCH_RETENTION_DAYS=14,BATCH_ASSET_BUDGET=2*1024*1024*1024;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const validJob = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const jobAsset=/^([a-f0-9-]{36})\.(?:png|webp|candidate\.png|mask-base\.png|revision\.[1-9][0-9]{0,9}\.[a-f0-9-]{36}\.webp)(?:\.[a-f0-9-]{36}\.part)?$/;
type FileKind='cover'|'preview'|'candidate'|'mask-base';
const file = (id: string, kind: FileKind) => {
  if (!validJob(id)) throw new ExtractionError('not_found',404);
  return join(EXTRACTION_DIR,`${id.toLowerCase()}${kind==='mask-base'?'.mask-base':kind==='candidate'?'.candidate':''}.${kind==='preview'?'webp':'png'}`);
};
function revisedFile(id:string,name:string):string {
  if(!validJob(id)||!new RegExp('^'+id.toLowerCase()+'\\.revision\\.[1-9][0-9]{0,9}\\.[a-f0-9-]{36}\\.webp$').test(name))throw new ExtractionError('not_found',404);
  return join(EXTRACTION_DIR,name);
}
type Status = 'queued'|'running'|'ready'|'rejected'|'error'|'applied';
export interface JobRow {
  id:string; series_id:string; owner_id:string|null; automatic:boolean; status:Status; snapshot:string;
  cover_fingerprint:string; source_sha256:string; candidate_sha256:string|null; title_version:number|string; region:ExtractionRect|null; exclusions:ExtractionRect[];
  quality:CoverTitleQualityResult|null; reasons:string[]; error:string|null; created_at:Date; expires_at:Date;
  selection_mode:'manual'|'automatic'|'legacy';result_region:ExtractionRect|null;candidate_region:ExtractionRect|null;model_fingerprint:string|null;
  mask_revision:number;mask_strokes:MaskStroke[];mask_width:number|null;mask_height:number|null;mask_baseline_sha256:string|null;
  mask_original_sha256:string|null;mask_preview_file:string|null;
  mask_bounds:ExtractionRect|null;
  batch_item_id:string|null;asset_bytes:number|string;
}
export interface TitleExtractionJob {
  id:string; seriesId:string; automatic:boolean; status:Status|'expired'; createdAt:string; expiresAt:string;
  previewUrl:string|null; coverPreviewUrl:string|null; coverFingerprint:string; region:ExtractionRect|null;
  exclusions:ExtractionRect[]; quality:CoverTitleQualityResult|null; reasons:string[]; error:string|null;
  selectionMode:'manual'|'automatic'|'legacy';resultRegion:ExtractionRect|null;candidateRegion:ExtractionRect|null;modelFingerprint:string|null;
  mask:{revision:number;strokes:MaskStroke[];previewRegion:ExtractionRect|null;canvas:{width:number;height:number;sourceUrl:string;baselineUrl:string}}|null;
}
interface Snapshot {
  id:string; selection:string; version:string|number|null; mode:string|null; anilist_id:string|null;
  english:string|null; romaji:string|null; native:string|null; aliases_id:string|null;
}
async function snapshotFor(id:string, viewer:ViewCtx, qq:ScopedQuery=q):Promise<Snapshot> {
  const p=new Params(); const sid=p.add(id); const allowed=visible('s',viewer,p);
  const [row]=await qq<Snapshot>(`SELECT s.id,${coverSelectionSql('s')} AS selection,a.version,a.mode,t.external_id AS anilist_id,
    ot.english,ot.romaji,ot.native,ot.anilist_id AS aliases_id FROM lib_series s
    LEFT JOIN series_title_art a ON a.series_id=s.id
    LEFT JOIN series_trackers t ON t.series_id=s.id AND t.provider='anilist' AND(t.checked_at IS NOT NULL OR t.linked_by IS NOT NULL)
    LEFT JOIN series_other_titles ot ON ot.series_id=s.id WHERE s.id=${sid} AND ${allowed}`,p.values);
  if (!row) throw new ExtractionError('not_found',404);
  return row;
}
async function currentCover(id:string,viewer:ViewCtx) {
  const before=await snapshotFor(id,viewer);
  let bytes:Buffer;
  try {
    // Loading the image route only when a cover is requested avoids a startup cycle through library retirement.
    const {seriesCoverInput}=require('../routes/images') as typeof import('../routes/images');
    const raw=await seriesCoverInput(id,viewer);
    if (!raw.length||raw.length>ART_MAX_BYTES) throw new Error('size');
    const img=sharp(raw,{limitInputPixels:12_000_000,animated:false}); const meta=await img.metadata();
    if (!['png','webp','jpeg','avif','heif'].includes(meta.format??'')||(meta.pages??1)>1) throw new Error('format');
    bytes=await img.rotate().resize({width:1800,height:2400,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).png().toBuffer();
    if(bytes.length>ART_MAX_BYTES) throw new Error('size');
  } catch { throw new ExtractionError('cover_unavailable',422); }
  const after=await snapshotFor(id,viewer); const selection=coverSelectionKey(after.selection);
  if(selection!==coverSelectionKey(before.selection)) throw new ExtractionError('stale_cover',409);
  return {bytes,snapshot:after,key:selection,sha256:hash(bytes),fingerprint:hash(selection+'\0'+hash(bytes))};
}
export const titleExtractionCover=currentCover;
export const titleExtractionSnapshot=snapshotFor;
async function writePrivateFile(path:string,bytes:Buffer) {
  if(bytes.length>ART_MAX_BYTES) throw new ExtractionError('extract_failed',502);
  await mkdir(EXTRACTION_DIR,{recursive:true,mode:0o700});
  const part=path+'.'+randomUUID()+'.part';
  try {await writeFile(part,bytes,{flag:'wx',mode:0o600});await rename(part,path);}
  finally {await rm(part,{force:true}).catch(()=>{});}
}
async function writeJobFile(id:string,kind:FileKind,bytes:Buffer) {return writePrivateFile(file(id,kind),bytes);}
async function readPrivateFile(path:string):Promise<Buffer> {
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    handle=await open(path,constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const meta=await handle.stat(); if(!meta.isFile()||meta.size<1||meta.size>ART_MAX_BYTES) throw new Error('size');
    const bytes=Buffer.alloc(meta.size+1); const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    const after=await handle.stat(); if(bytesRead!==meta.size||after.size!==meta.size||after.mtimeMs!==meta.mtimeMs) throw new Error('changed');
    return bytes.subarray(0,bytesRead);
  } catch {throw new ExtractionError('not_found',404);} finally {await handle?.close().catch(()=>{});}
}
async function readJobFile(id:string,kind:FileKind) {return readPrivateFile(file(id,kind));}
async function readPreview(row:JobRow) {return row.mask_preview_file?readPrivateFile(revisedFile(row.id,row.mask_preview_file)):readJobFile(row.id,'preview');}
async function initialMask(source:Buffer,candidate:Buffer,region:ExtractionRect,preparedWidth:number,preparedHeight:number) {
  const info=await sharp(source,{limitInputPixels:4_320_000,animated:false}).metadata();
  const {data:alpha,info:cut}=await sharp(candidate,{limitInputPixels:12_000_000,animated:false}).extractChannel('alpha').raw().toBuffer({resolveWithObject:true});
  const projected=projectTitleAlpha(alpha,cut.width,cut.height,region,preparedWidth,preparedHeight,info.width!,info.height!);
  // Only alpha belongs in the baseline. Do not duplicate high-entropy cover RGB or exceed the input byte cap.
  const rgba=Buffer.alloc(projected.length*4);for(let n=0;n<projected.length;n++)rgba[n*4+3]=projected[n];
  const bytes=await sharp(rgba,{raw:{width:info.width!,height:info.height!,channels:4}}).png().toBuffer();
  return {bytes,width:info.width!,height:info.height!};
}
async function removeFiles(id:string) {
  if(!validJob(id))return;
  const names=await readdir(EXTRACTION_DIR).catch(()=>[] as string[]);
  await Promise.all(names.filter(name=>jobAsset.exec(name)?.[1]===id.toLowerCase())
    .map(name=>rm(join(EXTRACTION_DIR,name),{force:true}).catch(()=>{})));
}
function dto(row:JobRow):TitleExtractionJob {
  const expired=new Date(row.expires_at).getTime()<=Date.now(); const base=`/api/admin/series/${encodeURIComponent(row.series_id)}/title-extraction/${row.id}`;
  return {id:row.id,seriesId:row.series_id,automatic:row.automatic,status:expired?'expired':row.status,
    createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),
    previewUrl:!expired&&row.status==='ready'?base+'/preview?revision='+Number(row.mask_revision??0):null,coverPreviewUrl:!expired?base+'/cover':null,
    coverFingerprint:row.cover_fingerprint,region:row.selection_mode==='manual'?row.region:null,
    selectionMode:row.selection_mode??'legacy',resultRegion:row.result_region??(row.selection_mode==='legacy'?row.region:null),
    candidateRegion:row.candidate_region??null,modelFingerprint:row.model_fingerprint??null,
    exclusions:row.exclusions,quality:row.quality,reasons:row.reasons,error:row.error,
    mask:!expired&&row.status==='ready'&&row.mask_baseline_sha256&&row.mask_width&&row.mask_height
      ?{revision:Number(row.mask_revision??0),strokes:row.mask_strokes??[],previewRegion:row.mask_bounds??null,
        canvas:{width:row.mask_width,height:row.mask_height,sourceUrl:base+'/cover',baselineUrl:base+'/mask/baseline'}}:null};
}
async function ownedJob(seriesId:string,jobId:string,userId:string,viewer:ViewCtx,qq:ScopedQuery=q):Promise<JobRow> {
  if(!validJob(jobId)||!(await seriesVisible(seriesId,viewer))) throw new ExtractionError('not_found',404);
  const [row]=await qq<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1 AND series_id=$2 AND(owner_id=$3 OR automatic)',[jobId,seriesId,userId]);
  if(!row) throw new ExtractionError('not_found',404);return row;
}
export async function getTitleExtraction(seriesId:string,jobId:string,userId:string,viewer:ViewCtx) {return dto(await ownedJob(seriesId,jobId,userId,viewer));}
export async function latestTitleExtraction(seriesId:string,userId:string,viewer:ViewCtx) {
  if(!(await seriesVisible(seriesId,viewer))) throw new ExtractionError('not_found',404);
  const row=await one<JobRow>(`SELECT * FROM series_title_extractions WHERE series_id=$1 AND(owner_id=$2 OR automatic)
    AND expires_at>now() AND status<>'applied' ORDER BY created_at DESC LIMIT 1`,[seriesId,userId]);return row?dto(row):null;
}
export async function titleExtractionImage(seriesId:string,jobId:string,userId:string,viewer:ViewCtx,kind:'cover'|'preview'|'mask-base',expectedRevision?:number) {
  const row=await ownedJob(seriesId,jobId,userId,viewer);
  if(new Date(row.expires_at).getTime()<=Date.now()) throw new ExtractionError('expired',410);
  if(kind!=='cover'&&row.status!=='ready') throw new ExtractionError('not_ready',409);
  if(kind==='preview'&&expectedRevision!==undefined&&expectedRevision!==Number(row.mask_revision??0))throw new ExtractionError('stale_mask',409);
  const bytes=kind==='preview'?await readPreview(row):await readJobFile(jobId,kind);
  if(hash(bytes)!==(kind==='cover'?row.source_sha256:kind==='mask-base'?row.mask_baseline_sha256:row.candidate_sha256))throw new ExtractionError('extract_failed',409);
  return {bytes,fingerprint:row.cover_fingerprint};
}
let worker=extractCoverTitle,ready=titleExtractorReady,assess=assessCoverTitleCandidate,ocrCapability=coverTitleOcrCapability;
let timeoutMs=TIMEOUT_MS;
/** Deterministic local worker seams; production never replaces these. */
export function setTitleExtractionForTests(deps?:{worker?:typeof worker;ready?:typeof ready;assess?:typeof assess;ocrCapability?:typeof ocrCapability;timeoutMs?:number}) {
  worker=deps?.worker??extractCoverTitle;ready=deps?.ready??titleExtractorReady;assess=deps?.assess??assessCoverTitleCandidate;
  ocrCapability=deps?.ocrCapability??coverTitleOcrCapability;timeoutMs=deps?.timeoutMs??TIMEOUT_MS;
}
export async function titleExtractionCapabilities() {
  const [available,health]=await Promise.all([ready(),titleExtractorHealth()]);
  const ocr=await ocrCapability(health?.modelFingerprint??undefined);
  return {available,reason:available?null:'worker_unavailable',automaticAvailable:available&&ocr.available&&ocr.calibrated,
    automaticApplyAvailable:available&&ocr.available&&ocr.calibrated,
    checkedApplyAvailable:available&&ocr.available,checkedApplyReason:!available?'worker_unavailable':!ocr.available?'ocr_unavailable':null,
    automaticReason:!available?'worker_unavailable':!ocr.available?'ocr_unavailable':!ocr.calibrated?'automatic_verification_unvalidated':null,
    maxExclusions:8,timeoutSeconds:90,maskCorrection:true,maxMaskStrokes:128,maxMaskPoints:8192};
}
const waiting:string[]=[];let active:{id:string;abort:AbortController}|null=null;let draining:Promise<void>|null=null;let stopped=false;
export const titleExtractionsSettled=()=>draining??Promise.resolve();
export const titleExtractionWorkerBusy=()=>!!active||waiting.length>0;
export async function createTitleExtraction(seriesId:string,userId:string|null,viewer:ViewCtx,
  selection:{region?:ExtractionRect;exclusions:ExtractionRect[];coverFingerprint?:string},automatic=false,
  batch?:{itemId:string;cover:Awaited<ReturnType<typeof currentCover>>}):Promise<TitleExtractionJob> {
  if(stopped||runtime.stopping) throw new ExtractionError('worker_unavailable');
  if(!(await ready())) throw new ExtractionError('worker_unavailable');
  if(waiting.length+(active?1:0)>=MAX_QUEUED) throw new ExtractionError('extract_busy',429);
  const cover=batch?.cover??await currentCover(seriesId,viewer);
  if(selection.coverFingerprint&&selection.coverFingerprint!==cover.fingerprint) throw new ExtractionError('stale_cover',409);
  const jobId=randomUUID();
  await writeJobFile(jobId,'cover',cover.bytes);
  try {
    await tx(async(qq)=>{
      // Serialize the global storage cap without holding a lock during image fetching or model inference.
      await qq('SELECT pg_advisory_xact_lock(91826524)');
      const [count]=await qq<{n:number;pending:number;batch_n:number;batch_bytes:string}>(`SELECT count(*)FILTER(WHERE batch_item_id IS NULL)::int n,
        count(*)FILTER(WHERE status IN('queued','running'))::int pending,count(*)FILTER(WHERE batch_item_id IS NOT NULL AND status='ready')::int batch_n,
        COALESCE(sum(asset_bytes)FILTER(WHERE batch_item_id IS NOT NULL),0)::text batch_bytes
        FROM series_title_extractions WHERE expires_at>now()`);
      if((!batch&&count.n>=MAX_JOBS)||count.pending>=MAX_QUEUED) throw new ExtractionError('extract_busy',429);
      if(batch){
        if(count.batch_n>=2048||Number(count.batch_bytes)+4*ART_MAX_BYTES>BATCH_ASSET_BUDGET)throw new ExtractionError('extraction_storage_full',507);
        const [item]=await qq('SELECT i.id FROM title_extraction_items i JOIN title_extraction_runs r ON r.id=i.run_id WHERE i.id=$1 AND i.series_id=$2 AND i.status=\'processing\' AND r.status=\'running\' FOR UPDATE OF i,r',[batch.itemId,seriesId]);
        if(!item)throw new ExtractionError('batch_cancelled',409);
      }
      const current=await snapshotFor(seriesId,viewer,qq);
      if(coverSelectionKey(current.selection)!==cover.key||Number(current.version??0)!==Number(cover.snapshot.version??0)) throw new ExtractionError('stale_candidate',409);
      if(batch&&(current.mode&&current.mode!=='automatic'||(await qq(`SELECT id FROM series_title_extractions WHERE series_id=$1 AND expires_at>now()
        AND status IN('queued','running','ready') AND(NOT automatic OR mask_revision>0) LIMIT 1`,[seriesId])).length))throw new ExtractionError('batch_protected',409);
      await qq(`INSERT INTO series_title_extractions(id,series_id,owner_id,automatic,status,snapshot,cover_fingerprint,source_sha256,title_version,region,exclusions,selection_mode,batch_item_id,asset_bytes,expires_at)
        VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+($14::int*interval '1 minute'))`,[jobId,seriesId,userId,automatic,cover.key,cover.fingerprint,cover.sha256,Number(current.version??0),
        selection.region?JSON.stringify(selection.region):null,JSON.stringify(selection.exclusions),selection.region?'manual':'automatic',batch?.itemId??null,cover.bytes.length,batch?BATCH_RETENTION_DAYS*1440:30]);
      if(batch)await qq('UPDATE title_extraction_items SET job_id=$2 WHERE id=$1',[batch.itemId,jobId]);
      if(automatic)await qq(`INSERT INTO series_title_extraction_state(series_id,automatic_key,retry_at)VALUES($1,$2,now()+interval '7 days')
        ON CONFLICT(series_id)DO UPDATE SET automatic_key=$2,retry_at=EXCLUDED.retry_at`,[seriesId,cover.key]);
    });
  } catch(error) {await removeFiles(jobId);throw error;}
  if(automatic)waiting.push(jobId);else waiting.unshift(jobId);
  if(!draining)draining=Promise.resolve().then(drain);
  return dto((await one<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1',[jobId]))!);
}
async function drain() {
  try {while(waiting.length&&!stopped&&!runtime.stopping) {
    const jobId=waiting.shift()!;const abort=new AbortController();active={id:jobId,abort};
    try {await runJob(jobId,abort.signal);} catch {/* An individual database/shutdown failure leaves the original art intact. */}
    finally {active=null;}
  }} finally {draining=null;}
}
async function freshJob(row:JobRow,viewer:ViewCtx,qq:ScopedQuery=q) {
  const current=await snapshotFor(row.series_id,viewer,qq);
  if(Number(current.version??0)!==Number(row.title_version)||coverSelectionKey(current.selection)!==row.snapshot) throw new ExtractionError('stale_candidate',409);
  return current;
}
async function warmCanonicalAliases(row:JobRow,current:Snapshot,viewer:ViewCtx,signal:AbortSignal) {
  if(!current.anilist_id||current.aliases_id===current.anilist_id||!(await automaticAniListAllowed({id:row.series_id})))return;
  const cover=await one<{cover:string|null}>('SELECT cover FROM series_overrides WHERE series_id=$1',[row.series_id]);
  const id=Number(current.anilist_id);if(cover?.cover===FIRST_PAGE||!Number.isSafeInteger(id)||id<=0||id>2_147_483_647)return;
  try {
    const titles=await fetchVerifiedAniListTitles(id);if(!titles||signal.aborted)return;
    await withAniListMutation({id:row.series_id},'automatic',async(qq)=>{
      await qq('SELECT series_id FROM series_trackers WHERE series_id=$1 FOR SHARE',[row.series_id]);
      const [chosen]=await qq<{cover:string|null}>('SELECT cover FROM series_overrides WHERE series_id=$1 FOR SHARE',[row.series_id]);
      if(chosen?.cover===FIRST_PAGE||signal.aborted||stopped||runtime.stopping)return;
      const latest=await freshJob(row,viewer,qq);if(latest.anilist_id!==current.anilist_id)return;
      await qq(`INSERT INTO series_other_titles(series_id,anilist_id,english,romaji,native)VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(series_id)DO UPDATE SET anilist_id=$2,english=$3,romaji=$4,native=$5,fetched_at=now()`,
        [row.series_id,current.anilist_id,titles.english,titles.romaji,titles.native]);
    });
  }catch{/* Alias outages leave manual review usable; no guessed title is introduced. */}
}
async function runJob(jobId:string,parentSignal:AbortSignal) {
  const row=await one<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1',[jobId]);if(!row)return;
  if(new Date(row.expires_at).getTime()<=Date.now()){await q('DELETE FROM series_title_extractions WHERE id=$1',[jobId]);await removeFiles(jobId);return;}
  let timer:ReturnType<typeof setTimeout>|undefined;
  const timeout=new AbortController(); const signal=AbortSignal.any([parentSignal,timeout.signal]);
  try {
    const viewer=row.automatic?SYSTEM_CTX:await viewCtxFor(row.owner_id);
    if(!row.automatic&&!(await one("SELECT id FROM users WHERE id=$1 AND role='admin' AND NOT disabled",[row.owner_id])))throw new ExtractionError('not_found',404);
    let current=await freshJob(row,viewer);await q("UPDATE series_title_extractions SET status='running' WHERE id=$1",[jobId]);
    const source=await readJobFile(jobId,'cover');if(hash(source)!==row.source_sha256)throw new ExtractionError('extract_failed',502);
    timer=setTimeout(()=>timeout.abort(),timeoutMs);timer.unref();
    const aborted=new Promise<never>((_,reject)=>{
      const fail=()=>{stopCoverTitleOcr();reject(new ExtractionError('extract_timeout',504));};
      if(signal.aborted)fail();else signal.addEventListener('abort',fail,{once:true});
    });
    // Nightly local generation never initiates an external identity/metadata lookup.
    if(!row.batch_item_id)await Promise.race([warmCanonicalAliases(row,current,viewer,signal),aborted]);
    current=await freshJob(row,viewer);
    const result=await Promise.race([worker(source,{region:row.selection_mode==='manual'?row.region??undefined:undefined,exclusions:row.exclusions},
      current.aliases_id===current.anilist_id?[current.english,current.romaji,current.native].filter((s):s is string=>!!s):[],signal),
      aborted]);
    if(signal.aborted||stopped||runtime.stopping)return;
    const meta=await sharp(result.bytes,{limitInputPixels:12_000_000,animated:false}).metadata();
    const stats=await sharp(result.bytes,{limitInputPixels:12_000_000,animated:false}).stats();
    if(result.bytes.length>ART_MAX_BYTES||meta.format!=='png'||(meta.pages??1)>1||!meta.hasAlpha||stats.isOpaque||stats.channels.at(-1)?.max!==255
      ||meta.width!==result.width||meta.height!==result.height||result.sourceSha256!==row.source_sha256)throw new ExtractionError('extract_failed',502);
    const inputMeta=await sharp(source).metadata();
    if(result.sourceWidth*result.sourceHeight>12_000_000||Math.abs(result.sourceWidth*inputMeta.height!-result.sourceHeight*inputMeta.width!)>2*Math.max(inputMeta.width!,inputMeta.height!))
      throw new ExtractionError('extract_failed',502);
    const aliases=current.aliases_id===current.anilist_id?[current.english,current.romaji,current.native].filter((s):s is string=>!!s):[];
    const quality=await Promise.race([assess({sourceBytes:source,candidateBytes:result.bytes,sourceSha256:row.source_sha256,lang:aliases.some((s)=>/[\uac00-\ud7af]/u.test(s))?'ko':'',
      modelFingerprint:result.modelFingerprint??String(result.evidence.modelFingerprint??''),
      evidence:{...result.evidence,region:[result.region.left,result.region.top,result.region.left+result.region.width,result.region.top+result.region.height],
        sourceWidth:result.sourceWidth,sourceHeight:result.sourceHeight,candidateWidth:result.width,candidateHeight:result.height,
        maskScore:typeof result.evidence.maskScore==='number'?result.evidence.maskScore:null,
        foregroundFraction:Number(result.evidence.foregroundFraction),edgeInkFraction:Number(result.evidence.edgeInkFraction),aliases,
        linkedAnilistId:current.anilist_id,aliasesAnilistId:current.aliases_id}}),aborted]);
    if(signal.aborted||stopped||runtime.stopping)return;
    await freshJob(row,viewer);
    const mask=result.candidateRegion?await initialMask(source,result.bytes,result.candidateRegion,result.sourceWidth,result.sourceHeight):null;
    if(mask){await writeJobFile(jobId,'candidate',result.bytes);await writeJobFile(jobId,'mask-base',mask.bytes);}
    const bytes=await normalizeTitleLogo(result.bytes);
    if((await sharp(bytes).stats()).isOpaque)throw new ExtractionError('extract_failed',502);
    await writeJobFile(jobId,'preview',bytes);
    const updated=await q(`UPDATE series_title_extractions SET status=$2,quality=$3,reasons=$4,result_region=$5,candidate_sha256=$6,candidate_region=$7,model_fingerprint=$8,
      mask_width=$9,mask_height=$10,mask_baseline_sha256=$11,mask_original_sha256=$12,asset_bytes=$13
      WHERE id=$1 AND status='running' RETURNING id`,
      [jobId,quality.manualApplyAllowed?'ready':'rejected',JSON.stringify(quality),JSON.stringify(quality.reasons.map((r)=>r.code)),JSON.stringify(result.region),hash(bytes),
        result.candidateRegion?JSON.stringify(result.candidateRegion):null,result.modelFingerprint??null,
        mask?.width??null,mask?.height??null,mask?hash(mask.bytes):null,mask?hash(result.bytes):null,
        source.length+bytes.length+(mask?mask.bytes.length+result.bytes.length:0)]);
    if(!updated.length){await removeFiles(jobId);return;}
    if(row.automatic&&quality.manualApplyAllowed&&(quality.safeToApply||row.batch_item_id&&quality.availableChecksPassed===true)){
      if(!row.batch_item_id||await batchPublicationEnabled())await applySystemDraft({...row,status:'ready',quality},bytes);
    }
  } catch(error) {
    const code=error instanceof ExtractionError?error.code:error instanceof TitleArtError?error.code:'extract_failed';
    await q("UPDATE series_title_extractions SET status='error',error=$2 WHERE id=$1 AND mask_revision=0 AND status IN ('queued','running','ready')",[jobId,code]).catch(()=>{});
    if(row.automatic&&['extract_timeout','worker_unavailable','extract_busy'].includes(code))
      await q("UPDATE series_title_extraction_state SET retry_at=now()+interval '5 minutes' WHERE series_id=$1 AND automatic_key=$2",[row.series_id,row.snapshot]).catch(()=>{});
    await rm(file(jobId,'preview'),{force:true}).catch(()=>{});
  } finally {if(timer)clearTimeout(timer);}
}
async function batchPublicationEnabled() {
  const settings=await one<{automatic_cover_title_generation:boolean;automatic_cover_title_apply:boolean}>('SELECT automatic_cover_title_generation,automatic_cover_title_apply FROM server_settings WHERE id=1');
  return !!settings?.automatic_cover_title_generation&&!!settings.automatic_cover_title_apply;
}
async function assertAutomatic(row:JobRow,qq:ScopedQuery) {
  const [settings]=await qq<{automatic_cover_titles:boolean;automatic_cover_title_generation:boolean;automatic_cover_title_apply:boolean}>('SELECT automatic_cover_titles,automatic_cover_title_generation,automatic_cover_title_apply FROM server_settings WHERE id=1 FOR SHARE');
  const [gate]=await qq<{allowed:boolean;first_page:boolean;mode:string;anilist_id:string;lookup_status:string;lookup_anilist_id:string;provider_logo:boolean}>(
    `SELECT l.anilist_lookup AS allowed,COALESCE(o.cover=$2,false) first_page,COALESCE(a.mode,'automatic') mode,t.external_id anilist_id,
      a.lookup_status,a.lookup_anilist_id,(a.auto_file IS NOT NULL AND a.auto_cover_key IS NULL) provider_logo FROM lib_series s
      JOIN libraries l ON l.id=s.library_id LEFT JOIN series_overrides o ON o.series_id=s.id LEFT JOIN series_title_art a ON a.series_id=s.id
      LEFT JOIN series_trackers t ON t.series_id=s.id AND t.provider='anilist' AND(t.checked_at IS NOT NULL OR t.linked_by IS NOT NULL)
      WHERE s.id=$1`,[row.series_id,FIRST_PAGE]);
  if(row.batch_item_id){
    const [run]=await qq(`SELECT r.id FROM title_extraction_items i JOIN title_extraction_runs r ON r.id=i.run_id WHERE i.id=$1 AND r.status='running' FOR SHARE OF r`,[row.batch_item_id]);
    if(!settings?.automatic_cover_title_generation||!settings.automatic_cover_title_apply||!run)throw new ExtractionError('publication_disabled',409);
    if(!gate||gate.first_page||gate.mode!=='automatic'||!gate.anilist_id)throw new ExtractionError('stale_candidate',409);
  }else if(!settings?.automatic_cover_titles||!gate?.allowed||gate.first_page||gate.mode!=='automatic'||gate.provider_logo||gate.lookup_status!=='missing'
    ||gate.lookup_anilist_id!==gate.anilist_id||!gate.anilist_id)throw new ExtractionError('stale_candidate',409);
  return gate.anilist_id;
}
async function applySystemDraft(row:JobRow,bytes:Buffer) {
  await freshJob(row,SYSTEM_CTX);
  const cover=await currentCover(row.series_id,SYSTEM_CTX);if(cover.fingerprint!==row.cover_fingerprint)throw new ExtractionError('stale_candidate',409);
  const current=await freshJob(row,SYSTEM_CTX);
  if(!current.anilist_id)throw new ExtractionError('stale_candidate',409);
  try{await applyAutomaticCoverTitle(row.series_id,bytes,Number(row.title_version),current.anilist_id,row.snapshot,async(qq)=>{
    await assertAutomatic(row,qq);
    const rows=await qq(`UPDATE series_title_extractions SET status='applied' WHERE id=$1 AND automatic AND status='ready'
      AND mask_revision=0 AND candidate_sha256=$2 AND (quality->>'safeToApply'='true' OR($3::boolean AND quality->>'availableChecksPassed'='true')) AND expires_at>now() RETURNING id`,[row.id,hash(bytes),!!row.batch_item_id]);
    if(!rows.length)throw new ExtractionError('stale_candidate',409);
  },!!row.batch_item_id);}catch(error){if(row.batch_item_id&&error instanceof ExtractionError&&error.code==='publication_disabled')return;throw error;}
  await removeFiles(row.id);
}
export async function correctTitleExtractionMask(seriesId:string,jobId:string,userId:string,viewer:ViewCtx,
  input:{expectedRevision:number;strokes:MaskStroke[]}) {
  const row=await ownedJob(seriesId,jobId,userId,viewer);
  if(new Date(row.expires_at).getTime()<=Date.now())throw new ExtractionError('expired',410);
  if(row.status!=='ready')throw new ExtractionError('not_ready',409);
  if(!row.mask_baseline_sha256||!row.mask_original_sha256||!row.mask_width||!row.mask_height)throw new ExtractionError('mask_unavailable',409);
  if(Number(row.mask_revision)!==input.expectedRevision)throw new ExtractionError('stale_mask',409);
  await freshJob(row,viewer);
  const cover=await currentCover(seriesId,viewer);if(cover.fingerprint!==row.cover_fingerprint)throw new ExtractionError('stale_candidate',409);
  const[source,baseline,original]=await Promise.all([readJobFile(jobId,'cover'),readJobFile(jobId,'mask-base'),readJobFile(jobId,'candidate')]);
  if(hash(source)!==row.source_sha256||hash(baseline)!==row.mask_baseline_sha256||hash(original)!==row.mask_original_sha256)throw new ExtractionError('extract_failed',409);
  const {data:rgb,info}=await sharp(source,{limitInputPixels:4_320_000,animated:false}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const {data:baseAlpha,info:baseInfo}=await sharp(baseline,{limitInputPixels:4_320_000,animated:false}).extractChannel('alpha').raw().toBuffer({resolveWithObject:true});
  if(info.width!==row.mask_width||info.height!==row.mask_height||baseInfo.width!==info.width||baseInfo.height!==info.height)throw new ExtractionError('extract_failed',409);
  let alpha:Uint8Array;
  try{alpha=rasterizeTitleMask(baseAlpha,info.width,info.height,input.strokes);}catch(error){
    throw new ExtractionError((error as {code?:string}).code==='mask_too_complex'?'mask_too_complex':'invalid_mask',400);
  }
  let left=info.width,top=info.height,right=0,bottom=0,hasTransparency=false;
  for(let n=0;n<alpha.length;n++){if(alpha[n]<255)hasTransparency=true;if(alpha[n]>0){const x=n%info.width,y=Math.floor(n/info.width);left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x+1);bottom=Math.max(bottom,y+1);}}
  if(right<=left||bottom<=top||!hasTransparency)throw new ExtractionError('invalid_mask',422);
  const bounds={left:left/info.width,top:top/info.height,width:(right-left)/info.width,height:(bottom-top)/info.height};
  // Crop and cap final title dimensions before encoding: a valid source PNG can grow past 11 MiB as full RGBA.
  const png=await sharp(sourceRgba(rgb,alpha),{raw:{width:info.width,height:info.height,channels:4}})
    .extract({left,top,width:right-left,height:bottom-top}).resize({width:1600,height:800,fit:'inside',withoutEnlargement:true}).png().toBuffer();
  const bytes=await normalizeTitleLogo(png);
  const revision=input.expectedRevision+1;
  const name=`${jobId.toLowerCase()}.revision.${revision}.${randomUUID()}.webp`,path=revisedFile(jobId,name);
  await writePrivateFile(path,bytes);
  let committed=false;
  try {
    const updated=await tx(async(qq)=>{
      await qq("SET LOCAL lock_timeout='5s'");
      // Match title-art publisher lock order. A cover edit, title edit, cancellation or Apply wins atomically.
      const p=new Params(),id=p.add(seriesId),allowed=visible('s',viewer,p);
      if(!(await qq(`SELECT s.id FROM lib_series s WHERE s.id=${id} AND ${allowed} FOR UPDATE OF s`,p.values)).length)throw new ExtractionError('not_found',404);
      await qq('SELECT series_id FROM series_title_art WHERE series_id=$1 FOR UPDATE',[seriesId]);
      await qq('SELECT series_id FROM series_trackers WHERE series_id=$1 FOR SHARE',[seriesId]);
      await qq('SELECT series_id FROM series_overrides WHERE series_id=$1 FOR SHARE',[seriesId]);
      await qq('SELECT series_id FROM series_art WHERE series_id=$1 FOR SHARE',[seriesId]);
      const[current]=await qq<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1 AND series_id=$2 AND(owner_id=$3 OR automatic) FOR UPDATE',[jobId,seriesId,userId]);
      if(!current)throw new ExtractionError('not_found',404);
      if(new Date(current.expires_at).getTime()<=Date.now())throw new ExtractionError('expired',410);
      if(current.status!=='ready')throw new ExtractionError('not_ready',409);
      if(Number(current.mask_revision)!==input.expectedRevision||current.mask_baseline_sha256!==row.mask_baseline_sha256)throw new ExtractionError('stale_mask',409);
      await freshJob(current,viewer,qq);
      const quality:CoverTitleQualityResult={policyVersion:'strict-v1',safeToApply:false,availableChecksPassed:false,manualApplyAllowed:true,needsReview:true,
        reasons:[{code:'manual_mask_edit',severity:'warning'}],sourceTitleMatched:null,candidateTitleMatched:null,matchedAlias:null};
      const [saved]=await qq<JobRow>(`UPDATE series_title_extractions SET mask_revision=$2,mask_strokes=$3,mask_preview_file=$4,candidate_sha256=$5,
        quality=$6,reasons=$7,mask_bounds=$8 WHERE id=$1 RETURNING *`,[jobId,revision,JSON.stringify(input.strokes),name,hash(bytes),JSON.stringify(quality),JSON.stringify(['manual_mask_edit']),JSON.stringify(bounds)]);
      return saved;
    });
    committed=true;
    if(row.mask_preview_file)await rm(revisedFile(jobId,row.mask_preview_file),{force:true}).catch(()=>{});
    return dto(updated);
  } finally {if(!committed)await rm(path,{force:true}).catch(()=>{});}
}
export async function applyTitleExtraction(seriesId:string,jobId:string,userId:string,viewer:ViewCtx,expectedMaskRevision?:number) {
  const row=await ownedJob(seriesId,jobId,userId,viewer);if(new Date(row.expires_at).getTime()<=Date.now())throw new ExtractionError('expired',410);
  if(row.status!=='ready'||row.quality?.manualApplyAllowed!==true)throw new ExtractionError('not_ready',409);
  if((Number(row.mask_revision)>0&&expectedMaskRevision===undefined)||(expectedMaskRevision!==undefined&&expectedMaskRevision!==Number(row.mask_revision)))throw new ExtractionError('stale_mask',409);
  await freshJob(row,viewer);
  const cover=await currentCover(seriesId,viewer);if(cover.fingerprint!==row.cover_fingerprint)throw new ExtractionError('stale_candidate',409);
  const bytes=await readPreview(row);
  if(hash(bytes)!==row.candidate_sha256)throw new ExtractionError('extract_failed',409);
  const titleArt=await changeTitleArt(seriesId,{mode:'upload',bytes},viewer,{expectedVersion:Number(row.title_version),
    attribution:{source:'Cover lettering',sourceUrl:null,artist:null,license:null,licenseUrl:null},assertCurrent:async(qq)=>{
    await qq('SELECT series_id FROM series_trackers WHERE series_id=$1 FOR SHARE',[seriesId]);
    await qq('SELECT series_id FROM series_overrides WHERE series_id=$1 FOR SHARE',[seriesId]);
    await qq('SELECT series_id FROM series_art WHERE series_id=$1 FOR SHARE',[seriesId]);
    await freshJob(row,viewer,qq);
    const [current]=await qq<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1 AND series_id=$2 AND(owner_id=$3 OR automatic) FOR UPDATE',[jobId,seriesId,userId]);
    if(!current||current.status!=='ready'||new Date(current.expires_at).getTime()<=Date.now())throw new ExtractionError('stale_candidate',409);
    if(Number(current.mask_revision)!==Number(row.mask_revision)||current.candidate_sha256!==row.candidate_sha256||current.mask_preview_file!==row.mask_preview_file)throw new ExtractionError('stale_mask',409);
    await qq("UPDATE series_title_extractions SET status='applied' WHERE id=$1",[jobId]);
  }});
  await removeFiles(jobId);return titleArt;
}
export async function discardTitleExtraction(seriesId:string,jobId:string,userId:string,viewer:ViewCtx) {
  await ownedJob(seriesId,jobId,userId,viewer);if(active?.id===jobId)active.abort.abort();
  for(let at=waiting.indexOf(jobId);at>=0;at=waiting.indexOf(jobId))waiting.splice(at,1);
  await q('DELETE FROM series_title_extractions WHERE id=$1',[jobId]);await removeFiles(jobId);
}
/** Batch cancellation is confined to its own uncompleted system draft, never a user's preview or title artwork. */
export async function cancelBatchTitleExtraction(itemId:string) {
  const rows=await q<{id:string}>(`DELETE FROM series_title_extractions WHERE batch_item_id=$1 AND automatic AND status IN('queued','running','error') RETURNING id`,[itemId]);
  for(const{id}of rows){if(active?.id===id)active.abort.abort();for(let at=waiting.indexOf(id);at>=0;at=waiting.indexOf(id))waiting.splice(at,1);await removeFiles(id);}
}
export async function collectBatchTitleExtractions(seriesId:string,keepId:string) {
  const rows=await q<{id:string}>(`DELETE FROM series_title_extractions WHERE series_id=$1 AND id<>$2 AND batch_item_id IS NOT NULL AND mask_revision=0
    AND status IN('ready','rejected','error') RETURNING id`,[seriesId,keepId]);
  for(const{id}of rows)await removeFiles(id);
}
export async function dropTitleExtractions(seriesId:string) {
  const rows=await q<{id:string}>('DELETE FROM series_title_extractions WHERE series_id=$1 RETURNING id',[seriesId]);
  for(const {id}of rows){if(active?.id===id)active.abort.abort();await removeFiles(id);}
  await q('DELETE FROM series_title_extraction_state WHERE series_id=$1',[seriesId]);
}
export async function cleanupTitleExtractions() {
  const rows=await q<{id:string}>('DELETE FROM series_title_extractions WHERE expires_at<=now() OR status=\'applied\' RETURNING id');
  for(const {id}of rows)await removeFiles(id);
  const keep=new Map((await q<{id:string;mask_preview_file:string|null}>('SELECT id,mask_preview_file FROM series_title_extractions')).map((r)=>[r.id,r.mask_preview_file]));
  for(const name of await readdir(EXTRACTION_DIR).catch(()=>[] as string[])) {
    const match=jobAsset.exec(name);
    if(match&&(!keep.has(match[1])||name.endsWith('.part')||(name.includes('.revision.')&&keep.get(match[1])!==name))){
      // A cover is atomically written just before its job INSERT. Never collect that in-progress snapshot.
      const meta=await lstat(join(EXTRACTION_DIR,name)).catch(()=>null);
      if(meta&&meta.mtimeMs<Date.now()-60_000)await rm(join(EXTRACTION_DIR,name),{force:true}).catch(()=>{});
    }
  }
}
export async function scanAutomaticTitleExtractions() {
  if(stopped||runtime.stopping||active||waiting.length)return;
  const setting=await one<{automatic_cover_titles:boolean}>('SELECT automatic_cover_titles FROM server_settings WHERE id=1');
  if(!setting?.automatic_cover_titles||!(await titleExtractionCapabilities()).automaticAvailable)return;
  const rows=await q<{id:string}>(`SELECT s.id FROM lib_series s JOIN libraries l ON l.id=s.library_id
    JOIN series_trackers t ON t.series_id=s.id AND t.provider='anilist' AND(t.checked_at IS NOT NULL OR t.linked_by IS NOT NULL)
    JOIN series_title_art a ON a.series_id=s.id LEFT JOIN series_overrides o ON o.series_id=s.id
    LEFT JOIN series_title_extraction_state st ON st.series_id=s.id
    WHERE ${visibleToAll('s')} AND l.anilist_lookup AND COALESCE(o.cover<>$1,true) AND a.mode='automatic'
      AND a.lookup_status='missing' AND a.lookup_anilist_id=t.external_id AND t.external_id~'^[1-9][0-9]{0,15}$'
      AND(a.auto_file IS NULL OR(a.auto_cover_key IS NOT NULL AND a.auto_cover_key<>${coverSelectionHashSql('s')}))
      AND(st.series_id IS NULL OR st.automatic_key<>${coverSelectionHashSql('s')} OR st.retry_at<=now())
      AND NOT EXISTS(SELECT 1 FROM series_title_extractions j WHERE j.series_id=s.id AND j.expires_at>now() AND j.status IN('queued','running','ready'))
    ORDER BY st.retry_at NULLS FIRST,s.id LIMIT 1`,[FIRST_PAGE]);
  if(rows[0])try{await createTitleExtraction(rows[0].id,null,SYSTEM_CTX,{exclusions:[]},true);}catch(error){
    const source=await snapshotFor(rows[0].id,SYSTEM_CTX).catch(()=>null);
    if(source)await q(`INSERT INTO series_title_extraction_state(series_id,automatic_key,retry_at)VALUES($1,$2,now()+interval '5 minutes')
      ON CONFLICT(series_id)DO UPDATE SET automatic_key=$2,retry_at=EXCLUDED.retry_at`,[source.id,coverSelectionKey(source.selection)]);
    throw error;
  }
}
let timer:ReturnType<typeof setTimeout>|null=null;
export async function initializeTitleExtractions() {
  await q("UPDATE series_title_extractions SET status='error',error='extract_interrupted' WHERE status IN('queued','running')");
  for(const row of await q<JobRow>("SELECT * FROM series_title_extractions WHERE status='ready'")){
    const present=await Promise.all([file(row.id,'cover'),row.mask_preview_file?revisedFile(row.id,row.mask_preview_file):file(row.id,'preview')].map(async path=>{
      const meta=await lstat(path).catch(()=>null);return!!meta?.isFile()&&meta.size>0&&meta.size<=ART_MAX_BYTES;
    }));
    if(present.some(ok=>!ok))await q("UPDATE series_title_extractions SET status='error',error='extract_interrupted' WHERE id=$1",[row.id]);
    if(row.mask_baseline_sha256){const present=await Promise.all((['candidate','mask-base']as const).map(async kind=>{const meta=await lstat(file(row.id,kind)).catch(()=>null);return!!meta?.isFile()&&meta.size>0&&meta.size<=ART_MAX_BYTES;}));
      if(present.some(ok=>!ok))await q('UPDATE series_title_extractions SET mask_baseline_sha256=NULL WHERE id=$1',[row.id]);}
  }
  await cleanupTitleExtractions();stopped=false;
}
export function startTitleExtractions(log:{warn(message:string):void}) {
  stopped=false;
  const tick=async()=>{if(stopped||runtime.stopping)return;try{await cleanupTitleExtractions();await scanAutomaticTitleExtractions();}catch{log.warn('cover title previews: retrying later');}
    finally{if(!stopped&&!runtime.stopping){timer=setTimeout(()=>void tick(),30_000);timer.unref();}}};
  timer=setTimeout(()=>void tick(),30_000);timer.unref();return stopTitleExtractions;
}
export function stopTitleExtractions() {stopped=true;if(timer)clearTimeout(timer);timer=null;waiting.length=0;active?.abort.abort();stopCoverTitleOcr();}
