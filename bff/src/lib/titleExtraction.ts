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

export const EXTRACTION_DIR = join(env.CACHE_DIR,'title-extractions');
const MAX_JOBS = 32, MAX_QUEUED = 8, TIMEOUT_MS = 90_000;
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const validJob = (id: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id);
const file = (id: string, kind: 'cover'|'preview') => {
  if (!validJob(id)) throw new ExtractionError('not_found',404);
  return join(EXTRACTION_DIR,`${id.toLowerCase()}.${kind==='cover'?'png':'webp'}`);
};
type Status = 'queued'|'running'|'ready'|'rejected'|'error'|'applied';
interface JobRow {
  id:string; series_id:string; owner_id:string|null; automatic:boolean; status:Status; snapshot:string;
  cover_fingerprint:string; source_sha256:string; candidate_sha256:string|null; title_version:number|string; region:ExtractionRect|null; exclusions:ExtractionRect[];
  quality:CoverTitleQualityResult|null; reasons:string[]; error:string|null; created_at:Date; expires_at:Date;
}
export interface TitleExtractionJob {
  id:string; seriesId:string; automatic:boolean; status:Status|'expired'; createdAt:string; expiresAt:string;
  previewUrl:string|null; coverPreviewUrl:string|null; coverFingerprint:string; region:ExtractionRect|null;
  exclusions:ExtractionRect[]; quality:CoverTitleQualityResult|null; reasons:string[]; error:string|null;
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
async function writeJobFile(id:string,kind:'cover'|'preview',bytes:Buffer) {
  if(bytes.length>ART_MAX_BYTES) throw new ExtractionError('extract_failed',502);
  await mkdir(EXTRACTION_DIR,{recursive:true,mode:0o700});
  const path=file(id,kind),part=path+'.'+randomUUID()+'.part';
  try {await writeFile(part,bytes,{flag:'wx',mode:0o600});await rename(part,path);}
  finally {await rm(part,{force:true}).catch(()=>{});}
}
async function readJobFile(id:string,kind:'cover'|'preview'):Promise<Buffer> {
  let handle:Awaited<ReturnType<typeof open>>|undefined;
  try {
    handle=await open(file(id,kind),constants.O_RDONLY|(constants.O_NOFOLLOW||0));
    const meta=await handle.stat(); if(!meta.isFile()||meta.size<1||meta.size>ART_MAX_BYTES) throw new Error('size');
    const bytes=Buffer.alloc(meta.size+1); const {bytesRead}=await handle.read(bytes,0,bytes.length,0);
    const after=await handle.stat(); if(bytesRead!==meta.size||after.size!==meta.size||after.mtimeMs!==meta.mtimeMs) throw new Error('changed');
    return bytes.subarray(0,bytesRead);
  } catch {throw new ExtractionError('not_found',404);} finally {await handle?.close().catch(()=>{});}
}
async function removeFiles(id:string) {await Promise.all(['cover','preview'].map((kind)=>rm(file(id,kind as 'cover'|'preview'),{force:true}).catch(()=>{})));}
function dto(row:JobRow):TitleExtractionJob {
  const expired=new Date(row.expires_at).getTime()<=Date.now(); const base=`/api/admin/series/${encodeURIComponent(row.series_id)}/title-extraction/${row.id}`;
  return {id:row.id,seriesId:row.series_id,automatic:row.automatic,status:expired?'expired':row.status,
    createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString(),
    previewUrl:!expired&&row.status==='ready'?base+'/preview':null,coverPreviewUrl:!expired?base+'/cover':null,
    coverFingerprint:row.cover_fingerprint,region:row.region,exclusions:row.exclusions,quality:row.quality,reasons:row.reasons,error:row.error};
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
export async function titleExtractionImage(seriesId:string,jobId:string,userId:string,viewer:ViewCtx,kind:'cover'|'preview') {
  const row=await ownedJob(seriesId,jobId,userId,viewer);
  if(new Date(row.expires_at).getTime()<=Date.now()) throw new ExtractionError('expired',410);
  if(kind==='preview'&&row.status!=='ready') throw new ExtractionError('not_ready',409);
  const bytes=await readJobFile(jobId,kind);
  if(hash(bytes)!==(kind==='cover'?row.source_sha256:row.candidate_sha256))throw new ExtractionError('extract_failed',409);
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
    automaticReason:!available?'worker_unavailable':!ocr.available?'ocr_unavailable':!ocr.calibrated?'automatic_verification_unvalidated':null,
    maxExclusions:8,timeoutSeconds:90};
}
const waiting:string[]=[];let active:{id:string;abort:AbortController}|null=null;let draining:Promise<void>|null=null;let stopped=false;
export const titleExtractionsSettled=()=>draining??Promise.resolve();
export async function createTitleExtraction(seriesId:string,userId:string|null,viewer:ViewCtx,
  selection:{region?:ExtractionRect;exclusions:ExtractionRect[];coverFingerprint?:string},automatic=false):Promise<TitleExtractionJob> {
  if(stopped||runtime.stopping) throw new ExtractionError('worker_unavailable');
  if(!(await ready())) throw new ExtractionError('worker_unavailable');
  if(waiting.length+(active?1:0)>=MAX_QUEUED) throw new ExtractionError('extract_busy',429);
  const cover=await currentCover(seriesId,viewer);
  if(selection.coverFingerprint&&selection.coverFingerprint!==cover.fingerprint) throw new ExtractionError('stale_cover',409);
  const jobId=randomUUID();
  await writeJobFile(jobId,'cover',cover.bytes);
  try {
    await tx(async(qq)=>{
      // Serialize the global storage cap without holding a lock during image fetching or model inference.
      await qq('SELECT pg_advisory_xact_lock(91826524)');
      const [count]=await qq<{n:number;pending:number}>(`SELECT count(*)::int n,count(*)FILTER(WHERE status IN('queued','running'))::int pending
        FROM series_title_extractions WHERE expires_at>now()`);
      if(count.n>=MAX_JOBS||count.pending>=MAX_QUEUED) throw new ExtractionError('extract_busy',429);
      const current=await snapshotFor(seriesId,viewer,qq);
      if(coverSelectionKey(current.selection)!==cover.key||Number(current.version??0)!==Number(cover.snapshot.version??0)) throw new ExtractionError('stale_candidate',409);
      await qq(`INSERT INTO series_title_extractions(id,series_id,owner_id,automatic,status,snapshot,cover_fingerprint,source_sha256,title_version,region,exclusions)
        VALUES($1,$2,$3,$4,'queued',$5,$6,$7,$8,$9,$10)`,[jobId,seriesId,userId,automatic,cover.key,cover.fingerprint,cover.sha256,Number(current.version??0),
        selection.region?JSON.stringify(selection.region):null,JSON.stringify(selection.exclusions)]);
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
    await Promise.race([warmCanonicalAliases(row,current,viewer,signal),aborted]);
    current=await freshJob(row,viewer);
    const result=await Promise.race([worker(source,{region:row.region??undefined,exclusions:row.exclusions},
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
    const bytes=await normalizeTitleLogo(result.bytes);
    if((await sharp(bytes).stats()).isOpaque)throw new ExtractionError('extract_failed',502);
    await writeJobFile(jobId,'preview',bytes);
    const updated=await q(`UPDATE series_title_extractions SET status=$2,quality=$3,reasons=$4,region=$5,candidate_sha256=$6 WHERE id=$1 AND status='running' RETURNING id`,
      [jobId,quality.manualApplyAllowed?'ready':'rejected',JSON.stringify(quality),JSON.stringify(quality.reasons.map((r)=>r.code)),JSON.stringify(result.region),hash(bytes)]);
    if(!updated.length){await removeFiles(jobId);return;}
    if(row.automatic&&quality.safeToApply&&quality.manualApplyAllowed)await applySystemDraft({...row,status:'ready',quality},bytes);
  } catch(error) {
    const code=error instanceof ExtractionError?error.code:error instanceof TitleArtError?error.code:'extract_failed';
    await q("UPDATE series_title_extractions SET status='error',error=$2 WHERE id=$1 AND status IN ('queued','running','ready')",[jobId,code]).catch(()=>{});
    if(row.automatic&&['extract_timeout','worker_unavailable','extract_busy'].includes(code))
      await q("UPDATE series_title_extraction_state SET retry_at=now()+interval '5 minutes' WHERE series_id=$1 AND automatic_key=$2",[row.series_id,row.snapshot]).catch(()=>{});
    await rm(file(jobId,'preview'),{force:true}).catch(()=>{});
  } finally {if(timer)clearTimeout(timer);}
}
async function assertAutomatic(row:JobRow,qq:ScopedQuery) {
  const [settings]=await qq<{automatic_cover_titles:boolean}>('SELECT automatic_cover_titles FROM server_settings WHERE id=1 FOR SHARE');
  const [gate]=await qq<{allowed:boolean;first_page:boolean;mode:string;anilist_id:string;lookup_status:string;lookup_anilist_id:string;provider_logo:boolean}>(
    `SELECT l.anilist_lookup AS allowed,COALESCE(o.cover=$2,false) first_page,COALESCE(a.mode,'automatic') mode,t.external_id anilist_id,
      a.lookup_status,a.lookup_anilist_id,(a.auto_file IS NOT NULL AND a.auto_cover_key IS NULL) provider_logo FROM lib_series s
      JOIN libraries l ON l.id=s.library_id LEFT JOIN series_overrides o ON o.series_id=s.id LEFT JOIN series_title_art a ON a.series_id=s.id
      LEFT JOIN series_trackers t ON t.series_id=s.id AND t.provider='anilist' AND(t.checked_at IS NOT NULL OR t.linked_by IS NOT NULL)
      WHERE s.id=$1`,[row.series_id,FIRST_PAGE]);
  if(!settings?.automatic_cover_titles||!gate?.allowed||gate.first_page||gate.mode!=='automatic'||gate.provider_logo||gate.lookup_status!=='missing'
    ||gate.lookup_anilist_id!==gate.anilist_id||!gate.anilist_id)throw new ExtractionError('stale_candidate',409);
  return gate.anilist_id;
}
async function applySystemDraft(row:JobRow,bytes:Buffer) {
  await freshJob(row,SYSTEM_CTX);
  const cover=await currentCover(row.series_id,SYSTEM_CTX);if(cover.fingerprint!==row.cover_fingerprint)throw new ExtractionError('stale_candidate',409);
  const current=await freshJob(row,SYSTEM_CTX);
  if(!current.anilist_id)throw new ExtractionError('stale_candidate',409);
  await applyAutomaticCoverTitle(row.series_id,bytes,Number(row.title_version),current.anilist_id,row.snapshot,async(qq)=>{
    await assertAutomatic(row,qq);
    const rows=await qq("UPDATE series_title_extractions SET status='applied' WHERE id=$1 AND status='ready' AND expires_at>now() RETURNING id",[row.id]);
    if(!rows.length)throw new ExtractionError('stale_candidate',409);
  });
  await removeFiles(row.id);
}
export async function applyTitleExtraction(seriesId:string,jobId:string,userId:string,viewer:ViewCtx) {
  const row=await ownedJob(seriesId,jobId,userId,viewer);if(new Date(row.expires_at).getTime()<=Date.now())throw new ExtractionError('expired',410);
  if(row.status!=='ready'||row.quality?.manualApplyAllowed!==true)throw new ExtractionError('not_ready',409);
  await freshJob(row,viewer);
  const cover=await currentCover(seriesId,viewer);if(cover.fingerprint!==row.cover_fingerprint)throw new ExtractionError('stale_candidate',409);
  const bytes=await readJobFile(jobId,'preview');
  if(hash(bytes)!==row.candidate_sha256)throw new ExtractionError('extract_failed',409);
  const titleArt=await changeTitleArt(seriesId,{mode:'upload',bytes},viewer,{expectedVersion:Number(row.title_version),
    attribution:{source:'Cover lettering',sourceUrl:null,artist:null,license:null,licenseUrl:null},assertCurrent:async(qq)=>{
    await qq('SELECT series_id FROM series_trackers WHERE series_id=$1 FOR SHARE',[seriesId]);
    await qq('SELECT series_id FROM series_overrides WHERE series_id=$1 FOR SHARE',[seriesId]);
    await qq('SELECT series_id FROM series_art WHERE series_id=$1 FOR SHARE',[seriesId]);
    await freshJob(row,viewer,qq);
    const [current]=await qq<JobRow>('SELECT * FROM series_title_extractions WHERE id=$1 AND series_id=$2 AND(owner_id=$3 OR automatic) FOR UPDATE',[jobId,seriesId,userId]);
    if(!current||current.status!=='ready'||new Date(current.expires_at).getTime()<=Date.now())throw new ExtractionError('stale_candidate',409);
    await qq("UPDATE series_title_extractions SET status='applied' WHERE id=$1",[jobId]);
  }});
  await removeFiles(jobId);return titleArt;
}
export async function discardTitleExtraction(seriesId:string,jobId:string,userId:string,viewer:ViewCtx) {
  await ownedJob(seriesId,jobId,userId,viewer);if(active?.id===jobId)active.abort.abort();
  for(let at=waiting.indexOf(jobId);at>=0;at=waiting.indexOf(jobId))waiting.splice(at,1);
  await q('DELETE FROM series_title_extractions WHERE id=$1',[jobId]);await removeFiles(jobId);
}
export async function dropTitleExtractions(seriesId:string) {
  const rows=await q<{id:string}>('DELETE FROM series_title_extractions WHERE series_id=$1 RETURNING id',[seriesId]);
  for(const {id}of rows){if(active?.id===id)active.abort.abort();await removeFiles(id);}
  await q('DELETE FROM series_title_extraction_state WHERE series_id=$1',[seriesId]);
}
export async function cleanupTitleExtractions() {
  const rows=await q<{id:string}>('DELETE FROM series_title_extractions WHERE expires_at<=now() OR status=\'applied\' RETURNING id');
  for(const {id}of rows)await removeFiles(id);
  const keep=new Set((await q<{id:string}>('SELECT id FROM series_title_extractions')).map((r)=>r.id));
  for(const name of await readdir(EXTRACTION_DIR).catch(()=>[] as string[])) {
    const match=/^([a-f0-9-]{36})\.(?:png|webp)(?:\.[a-f0-9-]{36}\.part)?$/.exec(name);
    if(match&&!keep.has(match[1])){
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
  for(const row of await q<{id:string}>("SELECT id FROM series_title_extractions WHERE status='ready'")){
    const present=await Promise.all((['cover','preview']as const).map(async kind=>{
      const meta=await lstat(file(row.id,kind)).catch(()=>null);return!!meta?.isFile()&&meta.size>0&&meta.size<=ART_MAX_BYTES;
    }));
    if(present.some(ok=>!ok))await q("UPDATE series_title_extractions SET status='error',error='extract_interrupted' WHERE id=$1",[row.id]);
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
