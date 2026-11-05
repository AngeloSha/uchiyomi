import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, rm, symlink, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DSN = process.env.TEST_DATABASE_URL;
const ROOT = mkdtempSync(join(tmpdir(), 'uchiyomi-local-art-'));
const LIB = join(ROOT, 'library'), DL = join(ROOT, 'downloads');
const FOLDER = 'Source/Local Artwork';
const ABS = join(LIB, FOLDER);
if (DSN) {
  process.env.DATABASE_URL = DSN;
  process.env.JWT_SECRET = 'local-art-tests-at-least-sixteen';
  process.env.LIBRARY_BACKEND = 'owned';
  process.env.LIBRARY_ROOT = LIB;
  process.env.DL_ROOT = DL;
  process.env.CONFIG_DIR = join(ROOT, 'config');
  process.env.CACHE_DIR = join(ROOT, 'cache');
}
const skip = DSN ? false : 'set TEST_DATABASE_URL to run';
let q: any, sharp: any, id: string, app: any, img: any;
let red: Buffer, blue: Buffer, green: Buffer;
let refreshLocalSeriesArt: any, readLocalSeriesArt: any, persistScan: any, seriesCoverInput: any, SYSTEM_CTX: any, coverSelectionSql: any;
async function color(bytes: Buffer) {
  const meta = await sharp(bytes).stats();
  const means = meta.channels.slice(0,3).map((x: any) => x.mean);
  return means.indexOf(Math.max(...means));
}
before(async () => {
  if (!DSN) return;
  sharp = (await import('sharp')).default;
  red = await sharp({ create: { width: 60,height:90,channels:3,background:'#e01010' } }).png().toBuffer();
  blue = await sharp({ create: { width: 300,height:80,channels:3,background:'#1020e0' } }).png().toBuffer();
  green = await sharp({ create: { width: 60,height:90,channels:3,background:'#10e020' } }).png().toBuffer();
  ({ q } = await import('../src/lib/db'));
  await (await import('../src/lib/migrate')).migrate();
  ({ refreshLocalSeriesArt, readLocalSeriesArt } = await import('../src/lib/localSeriesArt'));
  ({ persistScan } = await import('../src/lib/library'));
  ({ seriesCoverInput } = await import('../src/routes/images'));
  ({ SYSTEM_CTX } = await import('../src/lib/visibility'));
  ({ coverSelectionSql } = await import('../src/lib/coverSelection'));
  await mkdir(join(ABS, 'artwork'), { recursive:true });
  await mkdir(DL, { recursive:true });
  const AdmZip = require('adm-zip'); const zip = new AdmZip();zip.addFile('001.png',green);
  await writeFile(join(ABS, 'Chapter 1.cbz'), zip.toBuffer());
  await writeFile(join(ABS, 'cover.png'), red);
  await writeFile(join(ABS, 'artwork', 'banner.png'), blue);
  await persistScan();
  id = (await q('SELECT id FROM lib_series WHERE folder=$1', [FOLDER]))[0].id;
  await q(`INSERT INTO series_art(series_id,checked_at) VALUES($1,now()) ON CONFLICT DO NOTHING`, [id]);
  const Fastify = (await import('fastify')).default;
  const jwt = (await import('@fastify/jwt')).default;
  app = Fastify();
  await app.register(jwt, { secret:process.env.JWT_SECRET! });
  const user = (await q(`INSERT INTO users(username,display_name,password_hash,role,auth_kind)
    VALUES('local-art-reader','Local artwork','x','admin','password') RETURNING id`))[0];
  await app.register((await import('@fastify/cookie')).default);
  const cookie = `yomi_img=${app.jwt.sign({ sub:user.id, typ:'img' })}`;
  img = (url: string) => app.inject({ url, headers:{ cookie } });
  await app.register((await import('../src/routes/images')).default);
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  if (q) {
    await q('DELETE FROM lib_series WHERE id=$1',[id]);
    await q(`DELETE FROM users WHERE username='local-art-reader'`);
    await (await import('../src/lib/db')).pool.end();
  }
  await rm(ROOT,{recursive:true,force:true});
});

test('the scanner indexes local artwork without treating artwork/ as a chapter', {skip}, async () => {
  assert.equal((await q('SELECT count(*)::int AS n FROM lib_books WHERE series_id=$1',[id]))[0].n,1);
  const cover = await readLocalSeriesArt(id,'cover'); const banner = await readLocalSeriesArt(id,'banner');
  assert.equal(await color(cover.bytes),0);
  assert.equal(await color(banner.bytes),2);
  assert.equal(await color(await seriesCoverInput(id,SYSTEM_CTX)),0,'local cover beats automatic first page');
  const thumb = await img(`/img/series/${id}/thumb`);
  assert.equal(thumb.statusCode,200,thumb.body);assert.equal(await color(thumb.rawPayload),0);
  const backdrop = await img(`/img/series/${id}/backdrop?style=banner`);
  assert.equal(backdrop.statusCode,200,backdrop.body);assert.equal(await color(backdrop.rawPayload),2);
  const { artFile } = await import('../src/lib/seriesArt');
  await writeFile(artFile(id, 'banner'), green);
  await q(`INSERT INTO series_overrides(series_id,banner) VALUES($1,'upload')`, [id]);
  const chosen = await img(`/img/series/${id}/backdrop?style=banner`);
  assert.equal(await color(chosen.rawPayload), 1, 'explicit manual banner wins over local banner');
  await q('DELETE FROM series_overrides WHERE series_id=$1', [id]);
  await chmod(ABS, 0o555);
  try {
    await refreshLocalSeriesArt(id, LIB, FOLDER, 0);
    assert.equal(await color((await readLocalSeriesArt(id, 'cover')).bytes), 0, 'a read-only series directory works');
  } finally { await chmod(ABS, 0o755); }
  const {heroEligible}=await import('../src/lib/autoHero');
  assert.equal((await q(`SELECT (${heroEligible('s')}) AS eligible FROM lib_series s WHERE s.id=$1`,[id]))[0].eligible,false,'local banner supersedes generated mosaics');
});

test('manual artwork wins, local replacements change cache identity, removal falls back', {skip}, async () => {
  const {artFile}=await import('../src/lib/seriesArt');
  await writeFile(artFile(id,'cover'),green);
  await q(`INSERT INTO series_overrides(series_id,cover) VALUES($1,'upload')`,[id]);
  assert.equal(await color(await seriesCoverInput(id,SYSTEM_CTX)),1,'explicit upload wins');
  await q('DELETE FROM series_overrides WHERE series_id=$1',[id]);
  const selected = async () => (await q(`SELECT ${coverSelectionSql('s')} AS k FROM lib_series s WHERE s.id=$1`,[id]))[0].k;
  const oldSelection = await selected();
  const before = await img(`/img/series/${id}/thumb`);
  await writeFile(join(ABS,'cover.png'),blue);
  await refreshLocalSeriesArt(id,LIB,FOLDER,0);
  assert.notEqual(await selected(),oldSelection,'extraction draft identity tracks changed local cover');
  const after = await img(`/img/series/${id}/thumb`);
  assert.equal(await color(after.rawPayload),2);
  assert.notEqual(after.headers.etag,before.headers.etag);
  await rm(join(ABS,'cover.png'));
  await refreshLocalSeriesArt(id,LIB,FOLDER,0);
  assert.equal(await readLocalSeriesArt(id,'cover'),null);
  assert.equal(await color(await seriesCoverInput(id,SYSTEM_CTX)),1,'first chapter returns after removal');
});

test('read-library art wins over download overlay art and cached files are collected on Forget', {skip}, async () => {
  const {dropLocalSeriesArt}=await import('../src/lib/localSeriesArt');
  const other = 's_local_art_overlay';
  await q(`INSERT INTO lib_series(id,source,title,folder) VALUES($1,'test','Overlay art',$1)`,[other]);
  await mkdir(join(DL,FOLDER),{recursive:true});
  await writeFile(join(DL,FOLDER,'cover.png'),green);
  await rm(join(ABS,'cover.png'),{force:true});await writeFile(join(ABS,'cover.png'),red);
  try {
    await refreshLocalSeriesArt(other,DL,FOLDER,1);
    await refreshLocalSeriesArt(other,LIB,FOLDER,0);
    assert.equal(await color((await readLocalSeriesArt(other,'cover')).bytes),0,'read library takes deterministic priority');
    const before=await q('SELECT cover_file FROM series_local_art WHERE series_id=$1',[other]);
    await q('DELETE FROM lib_series WHERE id=$1',[other]);
    assert.equal((await q('SELECT count(*)::int AS n FROM series_local_art WHERE series_id=$1',[other]))[0].n,0,'metadata cascades');
    await dropLocalSeriesArt(other);
    const {ART_DIR}=await import('../src/lib/seriesArt');
    const names=await readdir(ART_DIR);
    for(const r of before)assert.equal(names.includes(r.cover_file),false,'only forgotten series cache files are collected');
    assert.ok((await readLocalSeriesArt(id,'banner')),'another series cache is retained');
  } finally {
    await q('DELETE FROM lib_series WHERE id=$1',[other]);
    await rm(join(ABS,'cover.png'),{force:true});
  }
});

test('malformed, oversized-pixel and symlink artwork is ignored without modifying originals', {skip}, async () => {
  await writeFile(join(ABS,'cover.png'),Buffer.from('not an image'));
  await refreshLocalSeriesArt(id,LIB,FOLDER,0);
  assert.equal(await readLocalSeriesArt(id,'cover'),null);
  const huge = await sharp({create:{width:5000,height:5000,channels:3,background:'#ffffff'}}).png().toBuffer();
  await writeFile(join(ABS,'cover.png'),huge);
  await refreshLocalSeriesArt(id,LIB,FOLDER,0);
  assert.equal(await readLocalSeriesArt(id,'cover'),null);
  await rm(join(ABS,'cover.png'));
  const outside = join(ROOT,'outside.png');await writeFile(outside,red);
  await symlink(outside,join(ABS,'cover.png'));
  await refreshLocalSeriesArt(id,LIB,FOLDER,0);
  assert.equal(await readLocalSeriesArt(id,'cover'),null,'a final symlink out of library is refused');
  await rm(join(ABS,'artwork'),{recursive:true,force:true});
  const outsideDir=join(ROOT,'outside-art');await mkdir(outsideDir);await writeFile(join(outsideDir,'banner.png'),red);
  await symlink(outsideDir,join(ABS,'artwork'));
  await refreshLocalSeriesArt(id,LIB,FOLDER,0);
  assert.equal(await readLocalSeriesArt(id,'banner'),null,'a parent symlink out of library is refused');
  assert.ok((await readdir(outsideDir)).includes('banner.png'),'original files remain');
});
