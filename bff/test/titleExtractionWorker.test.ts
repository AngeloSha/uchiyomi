// A local HTTP fixture checks the shipped worker transport, not an imitation of the model.
import test,{after,before}from'node:test';
import assert from'node:assert/strict';
import{createServer}from'node:http';
import{createHash}from'node:crypto';
import{extractCoverTitle,titleExtractorHealth,ExtractionError}from'../src/lib/titleExtractionWorker';
const token='fixture-title-worker-token',source=Buffer.from('bounded source fixture');
const digest=createHash('sha256').update(source).digest('hex');
const saved={url:process.env.TITLE_EXTRACTOR_URL,token:process.env.TITLE_EXTRACTOR_TOKEN};
let url='',behavior='ok',requests=0;
const server=createServer(async(req,res)=>{
  requests++;assert.equal(req.headers.authorization,'Bearer '+token);
  if(req.url==='/healthz'){res.setHeader('content-type','application/json');res.end(JSON.stringify({ready:true,version:1,modelFingerprint:'a'.repeat(64)}));return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  const body=JSON.parse(Buffer.concat(chunks).toString());assert.equal(body.imageBase64,source.toString('base64'));
  if(behavior==='redirect'){res.writeHead(302,{location:'http://127.0.0.1:1/private'});res.end();return;}
  if(behavior==='busy'){res.writeHead(429);res.end();return;}
  if(behavior==='timeout')return;
  if(behavior==='oversized'){res.end(' '.repeat(15*1024*1024+1));return;}
  res.setHeader('content-type','application/json');res.end(JSON.stringify({version:1,sourceSha256:behavior==='wrong-source'?'0'.repeat(64):digest,
    candidateBase64:Buffer.from('fixture bytes decoded later').toString('base64'),width:240,height:80,sourceWidth:480,sourceHeight:640,
    region:{left:0,top:0,width:1,height:.3},ms:1,evidence:{maskScore:.9},modelFingerprint:'a'.repeat(64)}));
});
before(async()=>{await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));url='http://127.0.0.1:'+(server.address()as any).port;});
after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(saved.url===undefined)delete process.env.TITLE_EXTRACTOR_URL;else process.env.TITLE_EXTRACTOR_URL=saved.url;
  if(saved.token===undefined)delete process.env.TITLE_EXTRACTOR_TOKEN;else process.env.TITLE_EXTRACTOR_TOKEN=saved.token;});
const configure=()=>{process.env.TITLE_EXTRACTOR_URL=url;process.env.TITLE_EXTRACTOR_TOKEN=token;};
const extract=(signal=AbortSignal.timeout(1000))=>extractCoverTitle(source,{exclusions:[]},['Fixture Tale'],signal);
test('operator configuration is required; health is authenticated and exposes only the model fingerprint',async()=>{
  delete process.env.TITLE_EXTRACTOR_URL;delete process.env.TITLE_EXTRACTOR_TOKEN;assert.equal(await titleExtractorHealth(),null);assert.equal(requests,0);
  configure();assert.deepEqual(await titleExtractorHealth(),{ready:true,modelFingerprint:'a'.repeat(64)});
});
test('actual worker POST stays bounded to the configured service and checks response source identity',async()=>{
  configure();behavior='ok';const result=await extract();assert.equal(result.sourceSha256,digest);assert.equal(result.modelFingerprint,'a'.repeat(64));
  behavior='wrong-source';await assert.rejects(extract(),(error:any)=>error instanceof ExtractionError&&error.code==='extract_failed');
});
test('redirects, oversized payloads, busy status and cancellation never become valid candidates',async()=>{
  configure();behavior='redirect';await assert.rejects(extract(),(error:any)=>error.code==='worker_unavailable');
  behavior='oversized';await assert.rejects(extract(),(error:any)=>error.code==='extract_failed');
  behavior='busy';await assert.rejects(extract(),(error:any)=>error.code==='extract_busy');
  behavior='timeout';await assert.rejects(extract(AbortSignal.timeout(25)),(error:any)=>error.code==='extract_timeout');
});
