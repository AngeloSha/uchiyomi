/** Request-bound content administration has the same private-owner boundary as the reader.
 * System maintenance (scanner, scheduled repair) calls library utilities directly, never these hooks.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { q } from './db';
import { roleOf } from './auth';
import { viewCtxFor } from './visibility';
import { privateFolderOwner } from './contentScope';
import { claimPrivateContentRead, type PrivacyLease } from './privateFence';

const adminReadLease = Symbol('adminReadLease');
type GuardedRequest = FastifyRequest & { [adminReadLease]?: PrivacyLease };
/** Release this request's read lease only when handing off to an exclusive visibility writer. */
export function releasePrivateAdminRead(req: FastifyRequest): void {
  const held = req as GuardedRequest;
  held[adminReadLease]?.release();
  delete held[adminReadLease];
}

const targetKeys=new Set(['id','ids','series','seriesId','seriesIds','series_id','bookId','bookIds','book_id','libraryId','library_id','of','with','withId','from','into','intoId','fromId','targetId']);
function targets(value:unknown,out:Set<string>,key='',depth=0,allStrings=false):void{
  if(depth>30)return;
  if(typeof value==='string'){if((allStrings||targetKeys.has(key)) && value.length<=400)out.add(value);return;}
  if(Array.isArray(value)){for(const v of value)targets(v,out,key,depth+1,allStrings);return;}
  if(value && typeof value==='object')for(const [k,v]of Object.entries(value))targets(v,out,k,depth+1,allStrings);
}
async function forbiddenIds(ids:Set<string>,uid:string,historical=false):Promise<Set<string>>{
  if(!ids.size)return new Set();
  const values=[...ids];
  const [series,libraries,forgotten]=await Promise.all([
    q<{id:string;book_id:string|null}>(`SELECT s.id,b.id AS book_id FROM lib_series s
      LEFT JOIN lib_books b ON b.series_id=s.id AND b.id=ANY($1::text[])
      WHERE (s.id=ANY($1::text[]) OR b.id=ANY($1::text[]))
        AND ((s.is_private AND s.owner_user_id IS DISTINCT FROM $2::uuid)
          OR EXISTS(SELECT 1 FROM libraries l WHERE l.id=s.library_id AND l.managed_private AND l.owner_user_id IS DISTINCT FROM $2::uuid))`,[values,uid]),
    q<{id:string}>('SELECT id FROM libraries WHERE id=ANY($1::text[]) AND managed_private AND owner_user_id IS DISTINCT FROM $2::uuid',[values,uid]),
    q<{id:string}>(`SELECT resource_id AS id FROM private_resource_owners r WHERE resource_id=ANY($1::text[]) AND owner_user_id<>$2::uuid
      AND ($3::boolean OR (NOT EXISTS(SELECT 1 FROM lib_series s WHERE s.id=r.resource_id)
      AND NOT EXISTS(SELECT 1 FROM lib_books b WHERE b.id=r.resource_id)))`,[values,uid,historical]),
  ]);
  return new Set([...series.flatMap(r=>[r.id,...(r.book_id?[r.book_id]:[])]),...libraries.map(r=>r.id),...forgotten.map(r=>r.id)]);
}

export async function privateAdminContentGuard(req:FastifyRequest,reply:FastifyReply):Promise<void|FastifyReply>{
  if(!req.url.startsWith('/api/admin/') || (req as any).privateAdminGuarded)return;
  const uid=(req as any).user?.sub as string|undefined;if(!uid)return;
  (req as any).viewCtx=await viewCtxFor(uid,roleOf(req));
  const ids=new Set<string>();
  const route=req.routeOptions.url ?? '';
  const params=(req.params??{})as Record<string,unknown>;
  if(/^\/api\/admin\/(?:series|books)\/:id(?:\/|$)/.test(route) || /^\/api\/admin\/(?:art\/candidates|update|libraries)\/:id(?:\/|$)/.test(route)){
    if(typeof params.id==='string')ids.add(params.id);
  }
  for(const key of ['seriesId','bookId'])if(typeof params[key]==='string')ids.add(params[key]as string);
  // Classify short candidate strings by actual resource identity; field aliases never grant ownership or system access.
  targets(req.body,ids,'',0,true);targets(req.query,ids,'',0,true);targets(req.params,ids,'',0,true);
  if(ids.size>10000)return reply.code(400).send({error:'too_many_targets'});
  if(ids.size){
    const rows=await q<{id:string}>(`SELECT s.id FROM lib_series s WHERE s.id=ANY($1::text[])
      OR EXISTS(SELECT 1 FROM lib_books b WHERE b.series_id=s.id AND b.id=ANY($1::text[]))`,[[...ids]]);
    const lease=claimPrivateContentRead(rows.map(r=>r.id));
    if(!lease)return reply.code(404).send({error:'not_found'});
    (req as GuardedRequest)[adminReadLease]=lease;
    reply.raw.once('finish',()=>lease.release());reply.raw.once('close',()=>lease.release());
  }
  if((await forbiddenIds(ids,uid)).size)return reply.code(404).send({error:'not_found'});
  (req as any).privateAdminGuarded=true;
}

/**
 * Legacy aggregate endpoints must not serialize private rows merely because their caller is an admin.
 * Full scans, verification, scheduled repairs and automatic-art batches remain explicit server maintenance:
 * their utilities can use SYSTEM_CTX, preserve ownership and cannot implicitly merge privacy domains.
 * Request-selected targets still pass the guard, and their operational responses pass this filter.
 */
export async function privateAdminResponse(req:FastifyRequest,reply:FastifyReply,payload:unknown):Promise<unknown>{
  if(!req.url.startsWith('/api/admin/') || !payload || typeof payload!=='object' || Buffer.isBuffer(payload))return payload;
  const uid=(req as any).user?.sub as string|undefined;if(!uid)return payload;
  const ids=new Set<string>();targets(payload,ids);
  const denied=await forbiddenIds(ids,uid,/\/(?:audit|tasks\/repair|health\/autofix)(?:[/?]|$)/.test(req.url));
  const privatePath=(v:unknown):boolean=>typeof v==='string' && [...v.matchAll(/_private\/[0-9a-f-]{36}(?:\/[^\s"']*)?/gi)]
    .some(m=>privateFolderOwner(m[0])!==uid);
  const scrub=(value:unknown):unknown=>{
    if(Array.isArray(value))return value.map(scrub).filter(v=>v!==undefined);
    if(!value || typeof value!=='object')return privatePath(value)||typeof value==='string'&&denied.has(value)?undefined:value;
    const source=value as Record<string,unknown>;
    if(Array.isArray(source.private_owner_ids) && source.private_owner_ids.some(owner=>owner!==uid))return undefined;
    if(source.visibility==='private' && source.ownerUserId && source.ownerUserId!==uid)return undefined;
    if(source.is_private===true && source.owner_user_id && source.owner_user_id!==uid)return undefined;
    if(Object.entries(source).some(([k,v])=>(targetKeys.has(k) && (typeof v==='string' && denied.has(v) || Array.isArray(v) && v.some(x=>typeof x==='string'&&denied.has(x)))) || privatePath(v)))return undefined;
    const result:Record<string,unknown>={};
    for(const[k,v]of Object.entries(source)){
      if(k==='private_owner_ids')continue;
      if(denied.has(k))continue;
      const clean=scrub(v);
      // A nested private target taints its enclosing record's title/message too. Arrays filter whole records.
      if(clean===undefined && v && !Array.isArray(v))return undefined;
      if(clean!==undefined)result[k]=clean;
    }
    return result;
  };
  try{return scrub(payload)??{};}catch{reply.header('Cache-Control','private, no-store');return {};}
}
