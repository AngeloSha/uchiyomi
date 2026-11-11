// Uploading chapter files by hand (lib/chapterUpload.ts, components/ChapterUpload.tsx): the rough edges #375 left after
// v0.104.0 -- a list that forgot the files that failed, pages that stayed stale, refusals in English.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join } from 'path';
import { setActiveDict } from '../lib/i18n';
import { ApiError } from '../lib/api';
import { libraryMoveRefusal } from '../lib/refusals';
import { uploadAll, uploadRefusal, orderedImagePages, uploadImageChapter, isRasterPageHeader, imagePreviewBitmap } from '../lib/chapterUpload';

setActiveDict({});
const read = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');
const refusal = (status: number, body: unknown) => new ApiError(status, JSON.stringify(body));

test("every refusal the route answers is said in the reader's words, never its English sentence", () => {
  // Reintroduce `if (message) return message` ahead of the codes: busy and forbidden come back in English in every language.
  assert.match(uploadRefusal(refusal(429, { error: 'busy', message: 'Two uploads are already running. Try again when one finishes.' }), 'a.cbz'), /Two uploads are already running/);
  assert.equal(uploadRefusal(refusal(403, { error: 'forbidden', message: 'Uploading needs an admin to allow it.' }), 'a.cbz'), 'Your account does not have permission to upload to this destination.');
  assert.equal(uploadRefusal(refusal(409, { error: 'busy', message: 'Another task is changing this series.' }), 'a.cbz'), 'Another task is changing this series. Try again in a moment.');
  assert.equal(uploadRefusal(refusal(400, { error: 'bad_path' }), 'a.cbz'), 'a.cbz could not be stored at this destination. Check the file name and library folder.');
  assert.equal(uploadRefusal(refusal(409, { error: 'exists' }), 'a.cbz'), 'a.cbz is already in this series.');
});

test('upload refusals distinguish a missing series, a private destination conflict and a dropped connection', () => {
  assert.match(uploadRefusal(refusal(404, { error: 'not_found' }), 'a.cbz'), /series is no longer available/);
  assert.match(uploadRefusal(refusal(409, { error: 'privacy_destination_conflict' }), 'a.cbz'), /different visibility/);
  assert.match(uploadRefusal(new TypeError('fetch failed'), 'a.cbz'), /Check your connection/);
});

test('library moves explain privacy restrictions, stale destinations and oversized selections', () => {
  assert.match(libraryMoveRefusal(refusal(409, { error: 'use_privacy_action' }), 1), /Change visibility/);
  assert.match(libraryMoveRefusal(refusal(404, { error: 'no_such_library' }), 2), /destination library no longer exists/);
  assert.equal(libraryMoveRefusal(refusal(400, { error: 'bad_request' }), 501), 'Select up to 500 series at a time.');
});

test('a run names the files that failed, and the next file of a new series joins the one the first made', async () => {
  // Reintroduce dropping `failedFiles`: the page has nothing to keep, and clears the list of the very files to retry.
  const asked: string[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    asked.push(String(url));
    if (String(url).includes('name=Chapter%202.cbz')) return new Response(JSON.stringify({ error: 'bad_file' }), { status: 415, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ file: 'x', seriesId: 's_new', bookId: 'b', number: 1, indexed: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const files = ['Chapter 1.cbz', 'Chapter 2.cbz', 'Chapter 3.cbz'].map((n) => new File([new Uint8Array([1])], n));
    const run = await uploadAll({ title: 'New One', fresh: true }, files);
    assert.deepEqual([run.done, run.failedFiles, run.seriesId], [2, ['Chapter 2.cbz'], 's_new']);
    assert.match(asked[0], /title=New%20One&fresh=1/, 'the first file makes the series');
    assert.match(asked[1], /seriesId=s_new/, 'the next ones join it');
  } finally { globalThis.fetch = orig; }
});

test('the page keeps the files that failed, refreshes what lists the series, and names where files go', () => {
  // Reintroduce `setFiles([])` after a run: a partial failure loses the files to retry. Reintroduce the two-key
  // invalidation: the chapter list (`series-books`) stays stale after an upload.
  const src = read('components/ChapterUpload.tsx');
  assert.match(src, /setFiles\(\(had\) => had\.filter\(\(f\) => run\.failedFiles\.includes\(f\.name\)\)\)/, 'the failed files leave the list');
  assert.match(src, /\['series-books', run\.seriesId\]/, 'the chapter rows are not refreshed');
  assert.match(src, /if \(run\.done\) for \(const k of \[\['library'\], \['home'\]\]\) qc\.invalidateQueries/, 'Library and Home are not refreshed');
  assert.match(src, /const into = seriesId \|\| \(!title\.trim\(\) && made \? made\.id : ''\);/, 'a retry of a new series asks for its title again');
  assert.match(src, /tr\('Add chapter files to “\{title\}”\./, 'the page does not say which series');
});

test('image selection sorts page numbers, reports ignored files and refuses silent folder merging',()=> {
  const files=['page10.png','page2.png','.hidden.jpg','readme.txt'].map(name=>new File([new Uint8Array([1])],name));
  const chosen=orderedImagePages(files);assert.deepEqual(chosen.pages.map(f=>f.name),['page2.png','page10.png']);assert.equal(chosen.ignored,2);
  const nested=['Chapter 1/page1.png','Chapter 2/page2.png'].map(path=>{const file=new File([new Uint8Array([1])],path.split('/').at(-1)!);Object.defineProperty(file,'webkitRelativePath',{value:path});return file;});
  assert.equal(orderedImagePages(nested).multipleFolders,true);
  assert.equal(orderedImagePages([files[0],files[0]]).duplicateNames,true);
});
test('image chapter uploads preserve the chosen multipart order and send selected privacy without an owner override',async()=> {
  const original=globalThis.fetch;let request:{url:string;init:RequestInit}|undefined;
  globalThis.fetch=(async(url:any,init:RequestInit)=>{request={url:String(url),init};return new Response(JSON.stringify({indexed:true,file:'x',seriesId:'s',bookId:'b',number:7}),{headers:{'content-type':'application/json'}});}) as typeof fetch;
  try {
    const pages=['page10.png','page2.png'].map(name=>new File([new Uint8Array([1])],name));
    await uploadImageChapter({title:'New Private',fresh:true,visibility:'private'},'Chapter 7',pages);
    const url=new URL(request!.url,'http://localhost');assert.equal(url.searchParams.get('visibility'),'private');assert.equal(url.searchParams.get('images'),'1');assert.equal(url.searchParams.get('name'),'Chapter 7.cbz');assert.equal(url.searchParams.has('ownerId'),false);
    const data=request!.init.body as FormData;assert.deepEqual(data.getAll('pages').map(f=>(f as File).name),['page10.png','page2.png']);
    assert.equal(new Headers(request!.init.headers).has('content-type'),false,'the browser must generate its own multipart boundary');
  } finally {globalThis.fetch=original;}
});
test('an unreadable image refusal names the offending page without discarding the chapter silently',()=> {
  assert.equal(uploadRefusal(refusal(400,{error:'invalid_page',page:'坏图.png'}),'Chapter 7'),'Could not read image “坏图.png”. No chapter was stored.');
});


test('preview headers accept supported raster formats and refuse active documents even with image filenames',()=> {
  for(const bytes of [Buffer.from('89504e470d0a1a0a','hex'),Buffer.from('ffd8ff0000000000','hex'),Buffer.from('GIF89a00'),Buffer.from('RIFF0000WEBP'),Buffer.from('0000ftypavif0000')])assert.equal(isRasterPageHeader(bytes),true);
  for(const text of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>','<html><img src=x onerror=alert(1)>','data:image/svg+xml,<svg/>','not an image'])assert.equal(isRasterPageHeader(Buffer.from(text)),false);
});

test('thumbnail decoding is bounded, skips oversized or cancelled files, and closes an abandoned bitmap',async()=> {
  const original=globalThis.createImageBitmap,png=new File([Buffer.from('89504e470d0a1a0a','hex')],'page.png');
  const releases:Array<()=>void>=[],options:ImageBitmapOptions[]=[];let active=0,peak=0,closed=0;
  globalThis.createImageBitmap=((_file:any,opts:ImageBitmapOptions)=>new Promise(resolve=>{
    active++;peak=Math.max(peak,active);options.push(opts);let released=false;
    releases.push(()=>{if(released)return;released=true;active--;resolve({width:72,height:96,close:()=>{closed++;}} as ImageBitmap);});
  })) as typeof createImageBitmap;
  const waitFor=async(n:number)=>{for(let i=0;i<100 && releases.length<n;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(releases.length,n);};
  try {
    const cancelled=new AbortController(),first=imagePreviewBitmap(png),second=imagePreviewBitmap(png),third=imagePreviewBitmap(png,cancelled.signal);
    await waitFor(2);assert.equal(peak,2);cancelled.abort();releases[0]();releases[1]();
    const images=await Promise.all([first,second,third]);assert.equal(images[2],null,'cancelled queued files never decode');images[0]!.close();images[1]!.close();
    assert.deepEqual(options,[{resizeWidth:72,resizeHeight:96,resizeQuality:'high'},{resizeWidth:72,resizeHeight:96,resizeQuality:'high'}]);
    const huge=new File([Buffer.from('89504e470d0a1a0a','hex')],'huge.png');Object.defineProperty(huge,'size',{value:64*1024*1024+1});
    assert.equal(await imagePreviewBitmap(huge),null);assert.equal(await imagePreviewBitmap(new File(['<svg/>'],'renamed.png')),null);assert.equal(releases.length,2);
    const departed=new AbortController(),pending=imagePreviewBitmap(png,departed.signal);await waitFor(3);departed.abort();releases[2]();
    assert.equal(await pending,null);assert.equal(closed,3,'a bitmap that finishes after unmount is closed too');
  } finally {for(const release of releases)release();globalThis.createImageBitmap=original;}
});

test('download cancels say why they were refused, and fall back to the shared connection message', async () => {
  const { downloadCancelRefusal } = await import('../lib/refusals');
  assert.match(downloadCancelRefusal(refusal(404, { error: 'not_found' })), /no longer in the queue/);
  assert.match(downloadCancelRefusal(refusal(409, { error: 'not_running' })), /no longer running/);
  assert.match(downloadCancelRefusal(refusal(403, { error: 'forbidden' })), /Only the person who started/);
  assert.match(downloadCancelRefusal(new TypeError('fetch failed')), /Check your connection/);
  assert.match(downloadCancelRefusal(refusal(500, {})), /Could not cancel this download/);
});

test('shared request failures cover an expired session and an unavailable server', async () => {
  const { requestFailure } = await import('../lib/refusals');
  assert.match(requestFailure(refusal(401, {})) ?? '', /session has expired/);
  assert.match(requestFailure(refusal(503, {})) ?? '', /temporarily unavailable/);
  assert.equal(requestFailure(refusal(500, {})), undefined);
});
