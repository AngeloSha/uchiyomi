import { claimWriterFolders, type FolderWriterClaim } from '../lib/bulkNewest';
import { folderBusy } from '../lib/numbering';
import { runsInside } from '../lib/updater';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate, userIdOf, roleOf } from '../lib/auth';
import { one, q, tx } from '../lib/db';
import { viewCtxFor, seriesVisible, nameableIds } from '../lib/visibility';
import { ContentScopeError, defaultPrivateFor, privateBackendSupported, resolveAddScope, scopeForSeries, privateFolderOwner } from '../lib/contentScope';
import { syncSeriesPrivacy } from '../lib/trackers';
import { logAudit } from '../lib/audit';
import { libraryChanged } from '../lib/discoverIdentity';
import { deleteSeries, restoreSeries, deleteSeriesFiles, forgetSeries } from '../lib/libraryAdmin';
import { DL_ROOT } from '../lib/library';
import { claimPrivateContentChange } from '../lib/privateFence';

/** Root onSend hook. Implicit caches must not retain a response containing private library data. */
export async function privateResponseHeaders(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!/^\/(?:api\/|img\/|opds(?:\/|$)|komga(?:\/|$))/.test(req.url)) return;
  const uid = (req as any).viewCtx?.userId ?? (req as any).user?.sub;
  if (!uid) return;
  let privateContent = req.url.split('?')[0].endsWith('/privacy');
  try {
    const row=await one<{private_content:boolean}>(`SELECT EXISTS(SELECT 1 FROM lib_series WHERE owner_user_id=$1 AND is_private)
      OR EXISTS(SELECT 1 FROM reading_events WHERE user_id=$1 AND is_private)
      OR EXISTS(SELECT 1 FROM read_progress WHERE user_id=$1 AND is_private)
      OR EXISTS(SELECT 1 FROM chapter_comments WHERE user_id=$1 AND is_private)
      OR EXISTS(SELECT 1 FROM chapter_reactions WHERE user_id=$1 AND is_private) AS private_content`,[uid]);
    privateContent ||= row?.private_content === true;
  } catch { privateContent=true; } // Classification failure must never turn on an implicit cache.
  if (privateContent) {
    reply.header('X-Uchiyomi-Private', '1');
    reply.header('Cache-Control', 'private, no-store');
    const vary=String(reply.getHeader('Vary') ?? '').split(',').map(v=>v.trim()).filter(Boolean);
    reply.header('Vary', [...new Set([...vary,'Authorization','Cookie'])].join(', '));
  }
}

export async function privateLibraryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  app.get('/api/personal/private-series',async req=>{
    const uid=userIdOf(req),ctx=await viewCtxFor(uid,roleOf(req));
    const rows=await q<{id:string;title:string;deleted:boolean;auto_update:boolean;private_published_at:string|null;work_id:string|null}>(`SELECT id,title,deleted_at IS NOT NULL AS deleted,auto_update,private_published_at,work_id
      FROM lib_series WHERE owner_user_id=$1 AND is_private AND merged_into IS NULL ORDER BY title,id`,[uid]);
    const allowed=await nameableIds(rows.map(r=>r.id),ctx);
    return {content:rows.filter(r=>allowed.has(r.id)).map(r=>({id:r.id,title:r.title,deleted:r.deleted,autoUpdate:r.auto_update,
      canDelete:!r.private_published_at&&!r.work_id}))};
  });
  app.post('/api/series/:id/private-management',async(req,reply)=>{
    const {id}=req.params as {id:string};
    const body=z.strictObject({action:z.enum(['pause','resume','remove','restore','delete']),confirmed:z.boolean().optional()}).safeParse(req.body);
    if(!body.success)return reply.code(400).send({error:'bad_request'});
    const uid=userIdOf(req),ctx=await viewCtxFor(uid,roleOf(req));
    const row=await one<{id:string;folder:string;deleted_at:string|null;private_published_at:string|null;work_id:string|null}>(`SELECT id,folder,deleted_at,private_published_at,work_id FROM lib_series
      WHERE id=$1 AND owner_user_id=$2 AND is_private AND merged_into IS NULL`,[id,uid]);
    if(!row || privateFolderOwner(row.folder)!==uid || !(await nameableIds([id],ctx)).has(id))return reply.code(404).send({error:'not_found'});
    if(body.data.action==='resume')await resolveAddScope(ctx,{visibility:'private'});
    const claim=claimWriterFolders([row.folder],folderBusy,()=>runsInside(id)>0);
    if(!claim)return reply.code(409).send({error:'busy'});
    try{
      if(body.data.action==='delete'){
        if(!body.data.confirmed)return reply.code(400).send({error:'confirmation_required'});
        if(!row.deleted_at)return reply.code(409).send({error:'remove_first'});
        if(row.private_published_at || row.work_id || await one('SELECT 1 FROM lib_series WHERE merged_into=$1 LIMIT 1',[id]))return reply.code(409).send({error:'admin_cleanup_required'});
        const files=await q<{root:string;file:string}>('SELECT root,file FROM lib_books WHERE series_id=$1',[id]);
        if(files.some(f=>f.root!==DL_ROOT || privateFolderOwner(f.file)!==uid))return reply.code(409).send({error:'admin_cleanup_required'});
        if(files.length){
          const deleted=await deleteSeriesFiles(id);
          if(!deleted.ok)return reply.code(409).send({error:'private_cleanup_refused',message:deleted.reason});
          if(deleted.unchecked || deleted.unproven)return reply.code(409).send({error:'private_cleanup_incomplete'});
        }
        const forgotten=await forgetSeries(id);
        if(!forgotten.ok)return reply.code(409).send({error:'private_cleanup_refused',message:forgotten.message});
      }else if(body.data.action==='remove'){
        await q('UPDATE lib_series SET auto_update=false WHERE id=$1',[id]);
        await deleteSeries(id);
      }else if(body.data.action==='restore')await restoreSeries(id);
      else await q('UPDATE lib_series SET auto_update=$2 WHERE id=$1',[id,body.data.action==='resume']);
      libraryChanged();
      await logAudit('series.private_management',{userId:uid,detail:{id,action:body.data.action},req});
      return {ok:true,action:body.data.action};
    }finally{claim.release();}
  });
  app.get('/api/personal/privacy', async req => {
    const uid = userIdOf(req);
    const library = await one<{ id: string }>('SELECT id FROM libraries WHERE managed_private AND owner_user_id=$1', [uid]);
    return { supported: privateBackendSupported(), defaultPrivate: await defaultPrivateFor(uid), privateLibraryId: library?.id ?? null };
  });
  app.put('/api/personal/privacy', async (req, reply) => {
    const body = z.strictObject({ defaultPrivate: z.boolean() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    if (body.data.defaultPrivate && !privateBackendSupported()) return reply.code(409).send({ error: 'private_backend_unsupported' });
    const uid = userIdOf(req);
    // Validate the account and its explicit deny-all without creating a private library to save a preference.
    const ctx = await viewCtxFor(uid, roleOf(req));
    if (ctx.libraryIds?.includes('')) return reply.code(403).send({ error: 'forbidden' });
    await q(`INSERT INTO app_settings(user_id,data) VALUES($1,jsonb_build_object('defaultPrivate',$2::boolean))
      ON CONFLICT(user_id) DO UPDATE SET data=app_settings.data || EXCLUDED.data`, [uid, body.data.defaultPrivate]);
    return { ok: true, defaultPrivate: body.data.defaultPrivate };
  });
  app.get('/api/series/:id/privacy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const uid = userIdOf(req);
    if (!(await seriesVisible(id, await viewCtxFor(uid, roleOf(req))))) return reply.code(404).send({ error: 'not_found' });
    const row = await one<{ is_private: boolean; owner_user_id: string | null; work_id: string | null; folder: string }>('SELECT is_private,owner_user_id,work_id,folder FROM lib_series WHERE id=$1', [id]);
    return { isPrivate: row!.is_private, owner: row!.owner_user_id === uid,
      canChange: privateBackendSupported() && row!.owner_user_id === uid && !row!.work_id && privateFolderOwner(row!.folder) === uid };
  });
  app.put('/api/series/:id/privacy', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.strictObject({ isPrivate: z.boolean(), libraryId: z.string().min(1).max(64).optional() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'bad_request' });
    const uid = userIdOf(req);
    const ctx = await viewCtxFor(uid, roleOf(req));
    const currentScope=await scopeForSeries(ctx,id,{write:true});
    if (!currentScope) return reply.code(404).send({ error: 'not_found' });
    if(currentScope.ownerUserId!==uid)return reply.code(403).send({error:'forbidden'});
    const privacyLease=claimPrivateContentChange(id);
    if(!privacyLease)return reply.code(409).send({error:'busy'});
    let writerClaim:FolderWriterClaim|null=null;
    try {
      const destination = await resolveAddScope(ctx, { visibility: body.data.isPrivate ? 'private' : 'shared', libraryId: body.data.libraryId });
      const outcome = await tx(async qq => {
        const [row] = await qq<{ owner_user_id: string | null; work_id: string | null; folder: string; source_id: string | null; source_series_id: string | null }>('SELECT owner_user_id,work_id,folder,source_id,source_series_id FROM lib_series WHERE id=$1 FOR UPDATE', [id]);
        if (!row || row.owner_user_id !== uid) return 'forbidden';
        // Edition and merge propagation needs an explicit work-level operation; never split silently.
        if (row.work_id) return 'edition_privacy_conflict';
        if (privateFolderOwner(row.folder) !== uid) return 'privacy_copy_required';
        writerClaim=claimWriterFolders([row.folder],folderBusy,()=>runsInside(id)>0);
        if (!writerClaim) return 'busy';
        const conflict = await qq(`SELECT id FROM lib_series WHERE id<>$1 AND library_id=$2
          AND (folder=$3 OR (source_id=$4 AND source_series_id=$5 AND merged_into IS NULL AND deleted_at IS NULL)) LIMIT 1`,
          [id, destination.libraryId, row.folder, row.source_id, row.source_series_id]);
        if (conflict.length) return 'privacy_destination_conflict';
        // Logical filing preserves all series/book/progress IDs and bytes. is_private is authoritative.
        await qq(`UPDATE lib_series SET is_private=$2,library_id=$3,library_pinned=true,
          private_published_at=CASE WHEN $2 THEN private_published_at ELSE COALESCE(private_published_at,now()) END WHERE id=$1`, [id, body.data.isPrivate, destination.libraryId]);
        return 'ok';
      });
      if (outcome !== 'ok') return reply.code(outcome === 'forbidden' ? 403 : 409).send({ error: outcome });
      libraryChanged();
      await logAudit('series.privacy',{userId:uid,detail:{id,isPrivate:body.data.isPrivate},req});
      if (body.data.isPrivate) void syncSeriesPrivacy(uid,id).catch(()=>{});
      return { ok: true, isPrivate: body.data.isPrivate, libraryId: destination.libraryId };
    } catch (error) {
      if (error instanceof ContentScopeError) return reply.code(error.statusCode).send({ error: error.code });
      throw error;
    } finally { (writerClaim as FolderWriterClaim|null)?.release();privacyLease.release(); }
  });
}
export default privateLibraryRoutes;
