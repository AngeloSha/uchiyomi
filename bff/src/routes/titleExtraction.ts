// Registered under the admin plugin: session role and admin token scope gate every JSON and image route.
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { roleOf, userIdOf } from '../lib/auth';
import { viewCtxFor } from '../lib/visibility';
import { TitleArtError } from '../lib/titleArt';
import { ExtractionError, extractionSelection } from '../lib/titleExtractionWorker';
import { titleExtractionCapabilities, titleExtractionCover, createTitleExtraction, getTitleExtraction, latestTitleExtraction,
  titleExtractionImage, applyTitleExtraction, discardTitleExtraction } from '../lib/titleExtraction';
const context = async(req:FastifyRequest) => ({userId:userIdOf(req)!,viewer:await viewCtxFor(userIdOf(req),roleOf(req))});
const handle=(fn:(req:FastifyRequest,reply:FastifyReply)=>Promise<unknown>)=>async(req:FastifyRequest,reply:FastifyReply)=>{
  try{return await fn(req,reply);}catch(error){
    if(error instanceof ExtractionError||error instanceof TitleArtError)return reply.code(error.statusCode).send({error:error.code,message:error.message});
    throw error;
  }
};
export default async function titleExtractionRoutes(app:FastifyInstance) {
  app.get('/api/admin/title-extraction/capabilities',handle(async()=>titleExtractionCapabilities()));
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
    const image=await titleExtractionImage(id,jobId,userId,viewer,kind);
    return reply.type(kind==='cover'?'image/png':'image/webp').header('cache-control','private, no-store')
      .header('x-content-type-options','nosniff').header('x-cover-fingerprint',image.fingerprint).send(image.bytes);
  }));
  app.post('/api/admin/series/:id/title-extraction/:jobId/apply',handle(async(req)=>{
    const{id,jobId}=req.params as {id:string;jobId:string};const{userId,viewer}=await context(req);
    return{ok:true,titleArt:await applyTitleExtraction(id,jobId,userId,viewer)};
  }));
  app.delete('/api/admin/series/:id/title-extraction/:jobId',handle(async(req)=>{
    const{id,jobId}=req.params as {id:string;jobId:string};const{userId,viewer}=await context(req);
    await discardTitleExtraction(id,jobId,userId,viewer);return{ok:true};
  }));
}
