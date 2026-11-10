// Real loopback regression for a private download interrupted by an actual account switch.
// CDP pauses one ALREADY AUTHORIZED image response; no API/image response bodies are fabricated.
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fixtureLogin, waitForLoginCooldown } from './loginCooldown.mjs';

const base=process.env.BASE||'http://127.0.0.1:18330',parsed=new URL(base);
assert.ok(parsed.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(parsed.hostname),'disposable loopback preview required');
const out=process.env.OUT||'/tmp/uchiyomi-offline-account-race';mkdirSync(out,{recursive:true});
const nonce=randomUUID().replaceAll('-',''),password=`Offline-${randomBytes(24).toString('base64url')}-A9`,title=`Offline race fixture ${nonce}`;
const accounts=[],checks=[],failures=[],consoleErrors=[],serverErrors=[],expectedNetwork=[],privateRefusals=[],race={responsesMocked:false,serviceWorkerBypassedOnlyForResponsePause:true};
let browser,page,cdp,adminToken,owner,other,ownerToken,seriesId,completedBookId,pendingBookId,held,loginAttempt=-1,offline=false,step=0,holdResponse=false,switchStarted=false,effectiveBVerified=false;
const check=(name,pass,detail='')=>{checks.push({name,pass:!!pass,...(!pass?{detail}:{})});console.log(`[${pass?'PASS':'FAIL'}] ${name}${!pass?' '+detail:''}`);if(!pass)failures.push(name);};
const shot=name=>page.screenshot({path:`${out}/${String(++step).padStart(2,'0')}-${name}.png`,waitForFonts:false});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function raw(path,{token=adminToken,method='GET',body}={}){
  const response=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body&&!(body instanceof FormData)?{'content-type':'application/json'}:{})},
    ...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(60000)});
  const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}return{status:response.status,data};
}
async function clickText(text,selector='button'){
  await page.waitForFunction((text,selector)=>[...document.querySelectorAll(selector)].some(node=>node.getClientRects().length>0&&!node.disabled&&
    (node.textContent?.trim()===text||[...node.querySelectorAll('span')].some(span=>span.textContent?.trim()===text))),{timeout:30000},text,selector);
  for(const button of await page.$$(selector))if(await button.isVisible()&&await button.evaluate((node,text)=>node.textContent?.trim()===text||[...node.querySelectorAll('span')].some(span=>span.textContent?.trim()===text),text)){
    await button.asLocator().click();return;
  }
  throw new Error('No visible button '+text);
}
async function login(account){
  await page.goto(base,{waitUntil:'networkidle2'});await page.waitForSelector('form input[type=password]',{visible:true});
  for(let attempt=0;attempt<2;attempt++){
    loginAttempt=attempt;await page.locator('form input[type=text]').fill(account.username);await page.locator('form input[type=password]').fill(password);
    const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/login'&&response.request().method()==='POST');
    await page.locator('form button[type=submit]').click();const response=await pending;
    if(response.status()===429&&attempt===0){await waitForLoginCooldown(response.headers()['retry-after']);continue;}
    assert.equal(response.status(),200,'fixture browser sign-in');const session=await response.json();assert.equal(session.user.id,account.id);ownerToken=session.accessToken;break;
  }
  loginAttempt=-1;await page.waitForSelector('[data-topbar]',{visible:true});await page.waitForSelector('form input[type=password]',{hidden:true});
}
function png(seed=0){
  const crc=buffer=>{let value=0xffffffff;for(const byte of buffer){value^=byte;for(let i=0;i<8;i++)value=(value>>>1)^((value&1)?0xedb88320:0);}return(value^0xffffffff)>>>0;};
  const chunk=(name,data)=>{const kind=Buffer.from(name),length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE(crc(Buffer.concat([kind,data])));return Buffer.concat([length,kind,data,sum]);};
  const width=320,height=480,header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=2;
  const pixels=Buffer.alloc((width*3+1)*height);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=y*(width*3+1)+1+x*3;pixels[i]=(x+y+seed)%256;pixels[i+1]=(2*x+y+seed)%256;pixels[i+2]=(x+2*y+seed)%256;}
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}
async function upload(number,count){
  const form=new FormData();for(let n=1;n<=count;n++)form.append('pages',new Blob([png(number*10+n)],{type:'image/png'}),String(n).padStart(3,'0')+'.png');
  const query=new URLSearchParams({name:`Chapter ${number}.cbz`,images:'1',...(seriesId?{seriesId}:{title,fresh:'1',visibility:'private'})});
  const response=await raw('/api/library/upload?'+query,{token:ownerToken,method:'POST',body:form});assert.equal(response.status,200,JSON.stringify(response.data));assert.equal(response.data.indexed,true);
  assert.ok(response.data.file.startsWith(`_private/${owner.id}/`),'real upload remains owner-private');if(seriesId)assert.equal(response.data.seriesId,seriesId);return response.data;
}
async function records(){return page.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('yomi-offline');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
  try{
    if(!db.objectStoreNames.contains('chapters')||!db.objectStoreNames.contains('pages'))return{chapters:[],pages:[]};
    const [chapters,keys,blobs]=await new Promise((resolve,reject)=>{
      const tx=db.transaction(['chapters','pages'],'readonly'),c=tx.objectStore('chapters').getAll(),k=tx.objectStore('pages').getAllKeys(),v=tx.objectStore('pages').getAll();
      tx.oncomplete=()=>resolve([c.result,k.result,v.result]);tx.onerror=()=>reject(tx.error);
    });
    const pages=await Promise.all(keys.map(async(key,index)=>({key,size:blobs[index].size,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blobs[index].arrayBuffer())),byte=>byte.toString(16).padStart(2,'0')).join('')})));
    return{chapters:chapters.map(row=>({key:row.key,userId:row.userId,bookId:row.bookId,seriesId:row.seriesId,pageCount:row.pageCount})),pages};
  }finally{db.close();}
});}
async function waitStored(bookId){for(let n=0;n<160;n++){if((await records()).chapters.some(row=>row.bookId===bookId))return;await sleep(100);}throw new Error('offline chapter was not committed');}
try{
  adminToken=(await(await fixtureLogin(base,{username:process.env.E2E_USER||'e2e',password:process.env.E2E_PASS||'e2e-passw0rd-123'})).json()).accessToken;
  const a=await raw('/api/admin/users',{method:'POST',body:{username:`or_a_${nonce}`,displayName:`Offline owner ${nonce}`,password,role:'admin'}});assert.equal(a.status,200,JSON.stringify(a.data));owner=a.data;accounts.push(owner);
  const b=await raw('/api/admin/users',{method:'POST',body:{username:`or_b_${nonce}`,displayName:`Offline profile ${nonce}`,role:'user',localOpen:true,managedBy:owner.id}});assert.equal(b.status,200,JSON.stringify(b.data));other=b.data;accounts.push(other);
  browser=await puppeteer.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']});page=await browser.newPage();await page.setViewport({width:1280,height:900});
  page.on('pageerror',error=>consoleErrors.push(error.message));page.on('console',message=>{
    if(message.type()!=='error')return;const text=message.text(),url=message.location()?.url||'';
    if(/401/.test(text)&&[base+'/auth/refresh',base+'/auth/me'].includes(url)){expectedNetwork.push('anonymous auth refusal: '+url);return;}
    if(loginAttempt===0&&/429/.test(text)&&url===base+'/auth/login'){expectedNetwork.push('advertised sign-in cooldown');return;}
    if(offline&&/net::ERR_(?:INTERNET_DISCONNECTED|FAILED)/.test(text)&&url.startsWith(base+'/')){expectedNetwork.push('deliberate offline: '+url);return;}
    consoleErrors.push(text+' '+url);
  });page.on('response',response=>{
    if(response.status()>=500)serverErrors.push(response.status()+' '+response.url());
    const path=new URL(response.url()).pathname;
    if(switchStarted&&response.status()===404&&response.request().method()==='GET'&&['', '/related','/comments','/listing','/groups'].some(suffix=>path===`/api/series/${seriesId}${suffix}`)){
      let subject=null;try{subject=JSON.parse(Buffer.from((response.request().headers().authorization||'').replace(/^Bearer /,'').split('.')[1],'base64url')).sub||null;}catch{}
      privateRefusals.push({url:response.url(),status:404,method:'GET',subject});
    }
  });
  await login(owner);await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.reload({waitUntil:'networkidle2'});
  check('real service worker controls the initial app',await page.evaluate(()=>!!navigator.serviceWorker.controller));
  const first=await upload(1,1);seriesId=first.seriesId;completedBookId=first.bookId;
  await page.goto(`${base}/series/?id=${seriesId}`,{waitUntil:'networkidle2'});await page.locator('::-p-aria(Save all offline)').click();await waitStored(completedBookId);
  const before=await records();check('first real private chapter is fully saved under A',before.chapters.some(row=>row.key===`${owner.id}:${completedBookId}`)&&before.pages.some(row=>row.key===`${owner.id}:${completedBookId}:1`));
  const second=await upload(2,2);pendingBookId=second.bookId;
  await page.reload({waitUntil:'networkidle2'});await page.waitForSelector('[data-topbar]');
  // Network-domain interception cannot reliably pause the final network response behind a worker.
  // Bypass ONLY for this response-pause step. The standalone privacy walk covers real SW isolation.
  await page.setBypassServiceWorker(true);cdp=await page.createCDPSession();await cdp.send('Network.enable');holdResponse=true;
  cdp.on('Network.loadingFailed',event=>{if(held?.networkId===event.requestId)race.heldRequestFailure={canceled:!!event.canceled,errorText:event.errorText};});
  cdp.on('Fetch.requestPaused',event=>{
    if(holdResponse&&new URL(event.request.url).pathname===`/img/books/${pendingBookId}/page/2`){held=event;race.heldResponse={status:event.responseStatusCode,networkId:event.networkId,privateHeader:event.responseHeaders?.find(header=>header.name.toLowerCase()==='x-uchiyomi-private')?.value};return;}
    void cdp.send('Fetch.continueRequest',{requestId:event.requestId}).catch(()=>{});
  });
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:`${base}/img/books/${pendingBookId}/page/2*`,requestStage:'Response'}]});
  await page.locator('::-p-aria(Save all offline)').click();
  for(let n=0;n<300&&!held;n++)await sleep(100);assert.ok(held,'an actual second-page response must be paused');assert.equal(held.responseStatusCode,200,'the real server authorized A before the switch');
  const during=await records();check('race holds a real authorized private response',race.heldResponse.status===200&&race.heldResponse.privateHeader==='1');
  check('first page is staged under A while the chapter remains unpublished',during.pages.some(row=>row.key.startsWith(`${owner.id}:${pendingBookId}:pending:`))&&!during.chapters.some(row=>row.bookId===pendingBookId));await shot('a-download-paused');
  await page.evaluate(nonce=>{window.__offlineRaceDocument=nonce;},nonce);
  const switched=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/switch'&&response.request().method()==='POST');
  const restored=page.waitForResponse(response=>new URL(response.url()).pathname==='/auth/refresh'&&response.status()===200);
  void switched.catch(()=>{});void restored.catch(()=>{});
  await page.locator('[data-topbar] [aria-label="You"]').click();await clickText('Switch profile');switchStarted=true;await clickText(other.display_name||other.displayName||`Offline profile ${nonce}`,'[data-switch-profile]');
  const accepted=await switched;assert.equal(accepted.status(),200);assert.equal((await accepted.json()).user.id,other.id);
  await page.waitForFunction(()=>window.__offlineRaceDocument===undefined,{timeout:30000});await page.waitForSelector('[data-topbar]',{visible:true});const bSession=await(await restored).json();assert.equal(bSession.user.id,other.id);effectiveBVerified=true;
  check('real profile switch installs B only in a fresh document',true);
  const denied=await page.evaluate(async({path,token})=>{const response=await fetch(path,{headers:{authorization:`Bearer ${token}`}});return{status:response.status,data:await response.json()};},{path:`/api/series/${seriesId}`,token:bSession.accessToken});
  race.directBRefusal=denied;
  check('verified B is denied the direct private series ID without receiving private data',denied.status===404&&JSON.stringify(denied.data)===JSON.stringify({error:'series not found'}));
  holdResponse=false;try{await cdp.send('Fetch.continueRequest',{requestId:held.requestId});race.release='continued';}catch(error){race.release='canceled with old document';race.releaseError=error.message;}
  await cdp.send('Fetch.disable').catch(()=>{});await page.setBypassServiceWorker(false);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const after=await records();race.recordsAfterSwitch=after;
  check('no A private page bytes or chapter metadata are stored under B',after.pages.every(row=>!row.key.startsWith(other.id+':'))&&after.chapters.every(row=>row.userId!==other.id));
  check('interrupted chapter was never published as complete',!after.chapters.some(row=>row.bookId===pendingBookId));
  check('completed A download metadata survives the account switch',JSON.stringify(after.chapters.filter(row=>row.bookId===completedBookId))===JSON.stringify(before.chapters.filter(row=>row.bookId===completedBookId)));
  check('completed A page bytes survive without changes',JSON.stringify(after.pages.filter(row=>row.key.startsWith(`${owner.id}:${completedBookId}:`)))===JSON.stringify(before.pages.filter(row=>row.key.startsWith(`${owner.id}:${completedBookId}:`))));
  check('any interrupted staging blobs remain immutable A-owned',after.pages.filter(row=>row.key.includes(':pending:')).every(row=>row.key.startsWith(owner.id+':')));
  await page.goto(base+'/library/?view=downloads',{waitUntil:'networkidle2'});check('B offline library does not display A private title',!(await page.$eval('body',node=>node.innerText)).includes(title));await shot('b-downloads-isolated');
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});await page.reload({waitUntil:'networkidle2'});check('real service worker is restored after the pause test',await page.evaluate(()=>!!navigator.serviceWorker.controller));
  offline=true;await page.setOfflineMode(true);await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('[data-topbar]');
  check('offline cold boot restores B own identity',await page.evaluate(id=>JSON.parse(localStorage.getItem('uchiyomi.offlineUser')||'null')?.id===id,other.id));
  check('B offline cold boot does not inherit A private title',!(await page.$eval('body',node=>node.innerText)).includes(title));await shot('b-offline-isolated');
}catch(error){failures.push(error.stack||error.message);console.error(error.stack||error.message);if(page&&!page.isClosed()){await shot('failure').catch(()=>{});writeFileSync(`${out}/failure-page.txt`,page.url()+'\n'+await page.$eval('body',node=>node.innerText).catch(()=>''));}}
finally{
  holdResponse=false;if(held&&cdp)await cdp.send('Fetch.continueRequest',{requestId:held.requestId}).catch(()=>{});await cdp?.send('Fetch.disable').catch(()=>{});
  await browser?.close();
  if(seriesId&&ownerToken)try{for(const action of ['remove','delete']){const response=await raw(`/api/series/${seriesId}/private-management`,{token:ownerToken,method:'POST',body:{action,...(action==='delete'?{confirmed:true}:{})}});assert.equal(response.status,200,`fixture content cleanup ${action}: ${JSON.stringify(response.data)}`);}}catch(error){failures.push(error.message);}
  for(const account of [...accounts].reverse())try{const response=await raw('/api/admin/users/'+account.id,{method:'DELETE'});assert.equal(response.status,200,'fixture account cleanup');}catch(error){failures.push(error.message);}
  const observedConsoleErrors=[...consoleErrors];
  for(let i=consoleErrors.length-1;i>=0;i--){const entry=consoleErrors[i];
    if(effectiveBVerified&&/status of 404/.test(entry)&&privateRefusals.some(response=>response.subject===other.id&&entry.endsWith(' '+response.url))){expectedNetwork.push('verified B private-ID refusal: '+entry.split(' ').at(-1));consoleErrors.splice(i,1);}
  }
  const result={base,image:process.env.E2E_IMAGE||null,checks,failures,consoleErrors,observedConsoleErrors,serverErrors,expectedNetwork,privateRefusals,effectiveBVerified,race,fixtures:{owner:owner?.id,other:other?.id,seriesId,completedBookId,pendingBookId}};
  writeFileSync(`${out}/result.json`,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({checks:checks.length,passed:checks.filter(check=>check.pass).length,failures,consoleErrors,serverErrors}));process.exitCode=failures.length||consoleErrors.length||serverErrors.length?1:0;
}
