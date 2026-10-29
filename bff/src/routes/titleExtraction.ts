// Registered under the admin plugin: session role and admin token scope gate every JSON and image route.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {z}from'zod';
import{titleExtractionBatchStatus,runTitleExtractionBatch,cancelTitleExtractionBatch}from'../lib/titleExtractionBatch';
import { roleOf, userIdOf } from '../lib/auth';
import { viewCtxFor } from '../lib/visibility';
import { TitleArtError } from '../lib/titleArt';
import { ExtractionError, extractionSelection } from '../lib/titleExtractionWorker';
import { titleExtractionCapabilities, titleExtractionCover, createTitleExtraction, getTitleExtraction, latestTitleExtraction,
  titleExtractionImage, applyTitleExtraction, discardTitleExtraction, correctTitleExtractionMask } from '../lib/titleExtraction';
const revision=z.number().int().min(0).max(2_147_483_646);
const point=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1)}).strict();
const maskChange=z.object({expectedRevision:revision,strokes:z.array(z.object({mode:z.enum(['restore','erase']),radius:z.number().min(.0005).max(.05),
  points:z.array(point).min(1).max(8192)}).strict()).max(128)}).strict().refine(v=>v.strokes.reduce((n,s)=>n+s.points.length,0)<=8192);
const applyChange=z.object({expectedMaskRevision:revision.optional()}).strict();
const context = async(req:FastifyRequest) => ({userId:userIdOf(req)!,viewer:await viewCtxFor(userIdOf(req),roleOf(req))});
const handle=(fn:(req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>)=>async(req:FastifyRequest,reply:FastifyReply)=>{
  try{return await fn(req,reply);}catch(error){
    if(error instanceof ExtractionError||error instanceof TitleArtError)return reply.code(error.statusCode).send({error:error.code,message:error.message});
    throw error;
  }
};
export default async function titleExtractionRoutes(app:FastifyInstance) {
  app.get('/api/admin/title-extraction/capabilities',handle(async()=>titleExtractionCapabilities()));
  app.get('/api/admin/title-extraction/batch/status',handle(async req=>titleExtractionBatchStatus((await context(req)).viewer)));
  app.post('/api/admin/title-extraction/batch/run',handle(async(req,reply)=>{
    const parsed=z.object({retryErrors:z.boolean().optional()}).strict().safeParse(req.body??{});if(!parsed.success)return reply.code(400).send({error:'bad_request'});
    const{userId,viewer}=await context(req);await runTitleExtractionBatch(userId,parsed.data);return reply.code(202).send(await titleExtractionBatchStatus(viewer));
  }));
  app.post('/api/admin/title-extraction/batch/cancel',handle(async(req,reply)=>{
    const parsed=z.object({runId:z.uuid()}).strict().safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'bad_request'});
    await cancelTitleExtractionBatch(parsed.data.runId);return titleExtractionBatchStatus((await context(req)).viewer);
  }));
  app.get('/api/admin/series/:id/title-extraction/cover',handle(async(req,reply)=>{
    const{id} = req.params as {id:string};const{viewer}=await context(req);const cover=await titleExtractionCover(id,viewer);
    return reply.type('image/png').header('cache-control','private, no-store').header('x-content-type-options','nosniff')
      .header('x-cover-fingerprint',cover.fingerprint).send(cover.bytes);
  }));
  app.post('/api/admin/series/:id/title-extraction',handle(async(req,reply)=>{
    const parsed=extractionSelection.safeParse(req.body??{});if(!parsed.success)return reply.code(400).send({error:'invalid_selection'});
    const{id}=req.params as {id:string};const{userId,viewer}=await context(req);
    const job=await createTitleExtraction(id,userId,viewer,parsed.data);return reply.code(202).send({job});
  }));
  app.get('/api/admin/series/:id/title-extraction',handle(async(req)=>{
    const{id}=req.params as {id:string};const{userId,viewer}=await context(req);return{job:await latestTitleExtraction(id,userId,viewer)};
  }));
  app.get('/api/admin/series/:id/title-extraction/:jobId',handle(async(req)=>{
    const{id,jobId}=req.params as {id:string;jobId:string};const{userId,viewer}=await context(req);
    return{job:await getTitleExtraction(id,jobId,userId,viewer)};
  }));
  for(const kind of ['cover','preview'] as const)app.get(`/api/admin/series/:id/title-extraction/:jobId/${kind}`,handle(async(req,reply)=>{
    const{id,jobId}=req.params as {id:string;jobId:string};const{userId,viewer}=await context(req);
    const query=req.query as{revision?:string};const expected=query.revision===undefined?undefined:Number(query.revision);
    if(expected!==undefined&&(!Number.isSafeInteger(expected)||expected<0))return reply.code(400).send({error:'invalid_mask'});
    const image=await titleExtractionImage(id,jobId,userId,viewer,kind,expected);
    return reply.type(kind==='cover'?'image/png':'image/webp').header('cache-control','private, no-store')
      .header('x-content-type-options','nosniff').header('x-cover-fingerprint',image.fingerprint).send(image.bytes);
  }));
  app.get('/api/admin/series/:id/title-extraction/:jobId/mask/baseline',handle(async(req,reply)=>{
    const{id,jobId}=req.params as{id:string;jobId:string};const{userId,viewer}=await context(req);
    const image=await titleExtractionImage(id,jobId,userId,viewer,'mask-base');
    return reply.type('image/png').header('cache-control','private, no-store').header('x-content-type-options','nosniff')
      .header('x-cover-fingerprint',image.fingerprint).send(image.bytes);
  }));
  app.patch('/api/admin/series/:id/title-extraction/:jobId/mask',handle(async(req,reply)=>{
    const parsed=maskChange.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:'invalid_mask'});
    const{id,jobId}=req.params as{id:string;jobId:string};const{userId,viewer}=await context(req);
    return{job:await correctTitleExtractionMask(id,jobId,userId,viewer,parsed.data)};
  }));
  app.post('/api/admin/series/:id/title-extraction/:jobId/apply',handle(async(req,reply)=>{
    const parsed=applyChange.safeParse(req.body??{});if(!parsed.success)return reply.code(400).send({error:'invalid_mask'});
    const{id,jobId}=req.params as {id:string;jobId:string};const{userId,viewer}=await context(req);
    return{ok:true,titleArt:await applyTitleExtraction(id,jobId,userId,viewer,parsed.data.expectedMaskRevision)};
  }));
  app.delete('/api/admin/series/:id/title-extraction/:jobId',handle(async(req)=>{
    const{id,jobId}=req.params as {id:string;jobId:string};const{userId,viewer}=await context(req);
    await discardTitleExtraction(id,jobId,userId,viewer);return{ok:true};
  }));
}
