// Actual upload/import controls against deterministic API answers. All feature writes are intercepted.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const parent='17000000-0000-4000-8000-000000000001',child='17000000-0000-4000-8000-000000000002';
const cid=n=>`17000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const candidate=(n,over={})=>({id:cid(n),batch_id:child,ord:n,backup_title:`Fixture title ${n}`,backup_source_id_unsigned:null,backup_source_id_signed:null,backup_url:null,in_library:false,
  decision:'auto',confidence:'exact',match_source:'mangadex',match_source_id:`fixture-${n}`,match_title:`Fixture title ${n}`,match_cover:null,auto_source:'mangadex',auto_source_id:`fixture-${n}`,auto_title:`Fixture title ${n}`,auto_cover:null,auto_confidence:'exact',status:null,...over});
export async function uploadImportEnhancementsWalk({page,base,check=(name,ok)=>assert.ok(ok,name),shot=async()=>{}}) {
  assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname),'fixture requires private loopback preview');
  const folder=await mkdtemp(join(tmpdir(),'uchi-upload-walk-'));
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVQImWP4z8DwnwGM/zMwAAAf7gP9qS/A4gAAAABJRU5ErkJggg==','base64');
  for(const name of ['page10.png','page2.png'])await writeFile(join(folder,name),png);
  const rows=[candidate(11),candidate(12,{match_source:'other',confidence:'fuzzy'}),candidate(13,{decision:'unresolved',confidence:null,match_source:null,match_source_id:null,match_title:null}),candidate(14,{decision:'skip'}),candidate(15,{in_library:true,decision:'skip'}),candidate(16,{decision:'manual',confidence:null,match_source:'other',content_scope:{visibility:'private',libraryId:'private_fixture'}})];
  const writes=[];let uploadAttempts=0;
  const batch=(id)=>({id,user_id:'fixture',origin:'backup',state:id===parent?'done':'review',total:id===parent?500:rows.length,resolved:id===parent?500:rows.length,added:0,already:0,failed:0,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),remainingCount:id===parent?2:0,canContinue:id===parent,nextBatchId:null,content_scope:{visibility:'shared',libraryId:'lib'}});
  const intercept=async req=> {
    if(req.isInterceptResolutionHandled())return;
    const u=new URL(req.url());if(u.origin!==new URL(base).origin)return req.continue();
    const reply=(body,status=200)=>req.respond({status,contentType:'application/json',body:JSON.stringify(body)});
    if(u.pathname==='/api/personal/privacy' && req.method()==='GET')return reply({defaultPrivate:false,supported:true,privateLibraryId:null});
    if(u.pathname==='/api/sources' && req.method()==='GET')return reply({content:[{id:'mangadex',name:'MangaDex',lang:'en'},{id:'other',name:'Fixture Source',lang:'en'}]});
    if(u.pathname==='/img/sources/icon/other')return req.respond({status:200,contentType:'image/png',body:png});
    if(u.pathname==='/api/library/upload') {
      uploadAttempts++;let payload=req.postData();try{payload??=await req.fetchPostData();}catch{}
      writes.push({kind:'upload',query:Object.fromEntries(u.searchParams),contentType:req.headers()['content-type'],payload});
      return uploadAttempts===1 ? reply({error:'invalid_page',page:'page2.png'},400) : reply({indexed:true,file:'fixture/Chapter7.cbz',seriesId:'s_fixture_uploaded',bookId:'b_fixture_uploaded',number:7});
    }
    if(u.pathname==='/api/admin/import/batches' && req.method()==='GET')return reply({content:[batch(parent)]});
    if(u.pathname==='/api/admin/import/batches' && req.method()==='POST') {const body=JSON.parse(req.postData());writes.push({kind:'continue',body});return reply({batchId:child,total:rows.length,truncated:false});}
    if(u.pathname===`/api/admin/import/batches/${parent}`)return reply({batch:batch(parent),items:[]});
    if(u.pathname===`/api/admin/import/batches/${child}`)return reply({batch:batch(child),items:rows});
    if(u.pathname===`/api/admin/import/batches/${child}/skip`) {const body=JSON.parse(req.postData());writes.push({kind:'skip',body});for(const row of rows)if(body.candidateIds.includes(row.id))row.decision='skip';return reply({ok:true,updated:body.candidateIds.length});}
    if(u.pathname===`/api/admin/import/batches/${child}/run`) {const body=JSON.parse(req.postData());writes.push({kind:'run',body});for(const row of rows)if(body.candidateIds.includes(row.id))row.status='added';return reply({ok:true,total:body.candidateIds.length});}
    return req.continue();
  };
  const previousLocale=await page.evaluate(()=>localStorage.getItem('uchiyomi.lang')), viewport=page.viewport();
  await page.setRequestInterception(true);page.on('request',intercept);
  try {
    await page.evaluate(()=>localStorage.setItem('uchiyomi.lang','en'));
    await page.setViewport({width:390,height:844,deviceScaleFactor:1});
    await page.goto(`${base}/upload/`,{waitUntil:'networkidle2'});
    await page.waitForSelector('[data-upload-title]');await page.locator('[data-upload-title]').fill('Browser image chapter');
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Images as one chapter')?.click());
    await page.locator('[data-image-chapter-name]').fill('Chapter 7');
    await(await page.$('[data-image-pick]')).uploadFile(join(folder,'page10.png'),join(folder,'page2.png'));
    await page.waitForFunction(()=>document.querySelectorAll('[data-image-pages] li').length===2);
    check('image picker naturally orders pages before an explicit change',(await page.$eval('[data-image-pages] li',el=>el.textContent)).includes('page2.png'));
    await page.waitForFunction(()=>{const canvas=document.querySelector('[data-image-pages] canvas');return canvas?.getContext('2d')?.getImageData(10,10,1,1).data[3]===255;});
    check('raster thumbnails render readable bounded pixels without image URLs',await page.$eval('[data-image-pages] canvas',canvas=>{const pixel=canvas.getContext('2d').getImageData(10,10,1,1).data;return canvas.width===72 && canvas.height===96 && pixel[0]>240 && pixel[1]<20 && pixel[2]<20 && pixel[3]===255; }));
    await shot('upload-image-pages-mobile-en');
    await page.click('[data-image-pages] li:first-child [data-image-down]');
    await page.click('[data-upload-start]');await page.waitForFunction(()=>document.body.textContent.includes('page2.png') && !document.querySelector('[data-upload-start]')?.disabled);
    check('failed image chapter leaves all pages selected for retry',await page.$$eval('[data-image-pages] li',els=>els.length)===2);
    await page.click('[data-upload-start]');await page.waitForFunction(()=>document.querySelectorAll('[data-image-pages] li').length===0);
    const uploads=writes.filter(w=>w.kind==='upload');
    check('image retry posts multipart to the selected scope and chapter',uploads.length===2 && uploads.every(w=>w.query.images==='1' && w.query.visibility==='shared' && w.query.name==='Chapter 7.cbz' && w.contentType.startsWith('multipart/form-data;')));
    check('manual page order is the actual multipart order',uploads.every(w=>w.payload?.indexOf('page10.png')>=0 && w.payload.indexOf('page10.png')<w.payload.indexOf('page2.png')));
    await shot('upload-images-mobile-en');
    await page.goto(`${base}/admin/import/`,{waitUntil:'networkidle2'});
    await page.waitForFunction(()=>document.body.textContent.includes('More titles to review'));
    check('completed batch with remaining titles is reachable after reopening',true);
    await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Backup file') && b.textContent.includes('Open'))?.click());
    await page.waitForSelector('[data-import-continue]');await page.click('[data-import-continue]');
    await page.waitForSelector(`[data-import-row="${cid(11)}"]`);
    check('continue reuses the stored batch instead of rereading an upload',writes.some(w=>w.kind==='continue' && w.body.continueFrom===parent));
    await page.select('[data-import-source]','other');await page.click('[data-import-select-all]');await page.click('[data-import-skip]');
    await page.waitForFunction(()=>!document.querySelector('[data-import-skip]'));
    check('bulk skip includes only the visible source selection',JSON.stringify(writes.find(w=>w.kind==='skip')?.body.candidateIds?.sort())===JSON.stringify([cid(12),cid(16)].sort()));
    await page.select('[data-import-source]','');
    check('Skipped filter count excludes already-owned rows',await page.$eval('[data-import-state] option[value="skipped"]',el=>el.textContent.trim().endsWith('3')));
    await page.select('[data-import-source]','mangadex');await page.select('[data-import-state]','exact');await page.click('[data-import-select-all]');await page.click('[data-import-run]');
    await page.waitForFunction(()=>document.querySelectorAll('[data-import-row]').length===0);
    check('import sends only confirmed visible rows, without skipped or held titles',JSON.stringify(writes.find(w=>w.kind==='run')?.body.candidateIds)===JSON.stringify([cid(11)]));
    await page.select('[data-import-source]','');await page.select('[data-import-state]','unmatched');await page.click('[data-import-select-all]');
    check('unmatched titles can be selected for skip while import stays disabled',!!await page.$('[data-import-skip]') && await page.$eval('[data-import-run]',el=>el.disabled));
    for(const locale of ['en','ar']) {
      await page.evaluate(lang=>localStorage.setItem('uchiyomi.lang',lang),locale);await page.goto(`${base}/admin/import/?batch=${child}`,{waitUntil:'networkidle2'});await page.waitForSelector('[data-import-source]');
      const info=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth-innerWidth,dir:document.documentElement.dir,privateRow:document.querySelector('[data-import-row="17000000-0000-4000-8000-000000000016"]')?.textContent}));
      check(`${locale}: import controls fit mobile and private row remains labelled`,info.overflow<=4 && info.dir===(locale==='ar'?'rtl':'ltr') && !!info.privateRow);
      await shot(`import-review-mobile-${locale}`);
      await page.$eval('[data-import-row="17000000-0000-4000-8000-000000000016"]',el=>el.scrollIntoView({block:'center'}));
      await shot(`import-private-row-mobile-${locale}`);
    }
    return {checks:13,writes:writes.length};
  } finally {
    page.off('request',intercept);await page.setRequestInterception(false);await page.evaluate(lang=>{if(lang===null)localStorage.removeItem('uchiyomi.lang');else localStorage.setItem('uchiyomi.lang',lang);},previousLocale);
    if(viewport)await page.setViewport(viewport);await rm(folder,{recursive:true,force:true});
  }
}
