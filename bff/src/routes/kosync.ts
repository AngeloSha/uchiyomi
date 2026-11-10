import type { FastifyInstance, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { z } from 'zod';
import { join } from 'node:path';
import { resolveApiToken, type ResolvedToken } from '../lib/auth';
import { one,q } from '../lib/db';
import { visibleBookFile, viewCtxFor, visible, Params, type ViewCtx } from '../lib/visibility';
import { backfillKoreaderHashes,bookFileSignature } from '../lib/koreaderHash';
import { LIBRARY_ROOT, onUnprintedFiles } from '../lib/library';
import { writeExternalBook, rememberExternalBaseline } from '../lib/externalReading';

const BASE='/api/v1/kosync';
const document=z.string().regex(/^[a-f0-9]{32}$/i).transform(s=>s.toLowerCase());
const bodySchema=z.object({document,progress:z.string().min(1).max(4096),percentage:z.number().finite().min(0).max(1),device:z.string().min(1).max(128),device_id:z.string().max(128).optional(),metadata:z.unknown().optional()});
interface Identity{token:ResolvedToken;ctx:ViewCtx}
const identity=(req:FastifyRequest)=>(req as any).kosync as Identity;

interface MatchingBook {id:string;root:string|null;file:string;pages:number;series_id:string;signature:string}
async function matchingBook(digest:string,ctx:ViewCtx):Promise<MatchingBook|null>{
  const p=new Params();
  const rows=await q<MatchingBook>(`SELECT b.id,b.root,b.file,b.pages,b.series_id,h.signature
    FROM koreader_hashes h JOIN lib_books b ON b.id=h.book_id JOIN lib_series s ON s.id=b.series_id
    WHERE h.digest=${p.add(digest)} AND b.pruned_at IS NULL AND ${visible('s',ctx,p)} LIMIT 2`,p.values as any[]);
  if(rows.length!==1)return null;
  const book=rows[0],signature=await bookFileSignature(join(book.root||LIBRARY_ROOT,book.file)).catch(()=>null);
  return signature===book.signature?book:null;
}

export default async function kosync(app:FastifyInstance){
  if(!app.hasDecorator('createRateLimit'))await app.register(rateLimit,{global:false});
  app.addHook('preHandler',async(req,reply)=>{
    reply.header('Cache-Control','private, no-store');
    if(req.routeOptions.url===BASE+'/users/create')return reply.code(403).send({code:2005,message:'Create an API token in Uchiyomi, then choose Login.'});
    // Komga's documented KOReader configuration: API key as username; password is a dummy value.
    const raw=req.headers['x-auth-user'];
    const token=typeof raw==='string'&&raw.length<512?await resolveApiToken(raw):null;
    if(!token)return reply.code(401).send({code:2001,message:'Unauthorized'});
    if(!token.scopes.includes('read')||(req.method==='PUT'&&!token.scopes.includes('write')))
      return reply.code(403).send({code:2001,message:'This token does not permit progress sync.'});
    const ctx=await viewCtxFor(token.userId,token.role,{hideAdult:!token.showAdult});
    (req as any).kosync={token,ctx};
    (req as any).viewCtx=ctx;
    (req as any).user={sub:token.userId,role:token.role,tokenScopes:token.scopes};
    if(process.env.LIBRARY_BACKEND==='komga')return reply.code(503).send({code:2000,message:'Use the library server’s KOReader endpoint.'});
  });
  app.get(BASE+'/users/auth',{config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async()=>({authorized:'OK'}));
  app.post(BASE+'/users/create',async(_req,reply)=>reply.code(403).send({code:2005,message:'Create an API token in Uchiyomi, then choose Login.'}));
  app.get(BASE+'/syncs/progress/:document',async(req,reply)=>{
    const parsed=document.safeParse((req.params as any).document);if(!parsed.success)return reply.code(400).send({code:2004,message:'Invalid document'});
    const {token,ctx}=identity(req);
    const saved=await one<any>('SELECT * FROM koreader_progress WHERE user_id=$1 AND document=$2',[token.userId,parsed.data]);
    const book=await matchingBook(parsed.data,ctx);
    if(!book)return {};
    const canonical=await one<{page:number;updated_at:Date}>('SELECT page,updated_at FROM read_progress WHERE user_id=$1 AND book_id=$2',[token.userId,book.id]);
    if(canonical&&!/\.epub$/i.test(book.file)&&book.pages>0&&(!saved||(/^\d+$/.test(saved.progress)&&canonical.page>=Number(saved.progress)))){
      const page=Math.min(book.pages,Math.max(1,canonical.page));
      return {document:parsed.data,progress:String(page),percentage:page/book.pages,device:'Uchiyomi',device_id:'uchiyomi',timestamp:Math.floor(new Date(canonical.updated_at).getTime()/1000)};
    }
    if(!saved||saved.book_id!==book.id)return {};
    return {document:parsed.data,progress:saved.progress,percentage:saved.percentage,device:saved.device,device_id:saved.device_id,timestamp:Math.floor(new Date(saved.updated_at).getTime()/1000)};
  });
  app.put(BASE+'/syncs/progress',{config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
    const parsed=bodySchema.safeParse(req.body);if(!parsed.success)return reply.code(400).send({code:2003,message:'Invalid progress'});
    const b=parsed.data,{token,ctx}=identity(req);
    const book=await matchingBook(b.document,ctx);
    if(!book)return reply.code(404).send({code:2007,message:'No unique available book matches this document. Use Binary matching and let the library finish hashing.'});
    const epub=/\.epub$/i.test(book.file);
    const page=!epub&&/^\d+$/.test(b.progress)?Number(b.progress):null;
    // Fixed-page formats have an exact location. Never turn an EPUB xpointer or a percentage into invented pages.
    if(page===null&&!epub)return reply.code(400).send({code:2003,message:'This book requires a page number.'});
    if(page!==null&&(!Number.isSafeInteger(page)||page<1||!book.pages||page>book.pages))return reply.code(400).send({code:2003,message:'Page is outside this book.'});
    if(page!==null)await writeExternalBook(token.userId,{id:book.id,seriesId:book.series_id,pages:book.pages},page,b.document);
    else if(b.percentage===1)await writeExternalBook(token.userId,{id:book.id,seriesId:book.series_id,pages:book.pages},book.pages||0,b.document,true);
    else await rememberExternalBaseline(token.userId,b.document,b.percentage);
    await q(`INSERT INTO koreader_progress(user_id,document,book_id,progress,percentage,device,device_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id,document) DO UPDATE SET
      book_id=EXCLUDED.book_id,progress=EXCLUDED.progress,percentage=EXCLUDED.percentage,device=EXCLUDED.device,device_id=EXCLUDED.device_id,updated_at=now()
      WHERE (koreader_progress.progress IS DISTINCT FROM EXCLUDED.progress OR koreader_progress.percentage IS DISTINCT FROM EXCLUDED.percentage)
        AND ($8::boolean=false OR CASE WHEN koreader_progress.progress ~ '^[0-9]+$' THEN length(koreader_progress.progress)>15 OR EXCLUDED.progress::numeric>=koreader_progress.progress::numeric ELSE true END)`,
      [token.userId,b.document,book.id,b.progress,b.percentage,b.device,b.device_id??null,page!==null]);
    const saved=await one<{at:Date}>('SELECT updated_at AS at FROM koreader_progress WHERE user_id=$1 AND document=$2',[token.userId,b.document]);
    return {document:b.document,timestamp:Math.floor(new Date(saved!.at).getTime()/1000)};
  });
  let closed=false;
  let timer:ReturnType<typeof setTimeout>|null=null;
  const schedule=(delay:number)=>{if(closed)return;timer=setTimeout(()=>{backfillKoreaderHashes().then(n=>schedule(n===100?1000:600000)).catch(()=>schedule(600000));},delay);timer.unref();};
  app.addHook('onReady',async()=>{if(process.env.LIBRARY_BACKEND==='komga')return;schedule(1000);onUnprintedFiles(()=>{if(!closed){if(timer)clearTimeout(timer);schedule(60000);}});});
  app.addHook('onClose',async()=>{closed=true;if(timer)clearTimeout(timer);});
}
