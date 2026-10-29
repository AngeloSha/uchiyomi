// Only the operator's configured local sidecar is contacted. No caller-provided URL or public image upload.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readCapped } from './safeFetch';
export interface ExtractionRect { left: number; top: number; width: number; height: number }
export const extractionRect = z.object({ left: z.number().min(0).max(1), top: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict()
  .refine((r) => r.left+r.width <= 1.000000001 && r.top+r.height <= 1.000000001);
export const extractionSelection = z.object({ region: extractionRect.optional(), exclusions: z.array(extractionRect).max(8).default([]),
  coverFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();
export class ExtractionError extends Error {
  constructor(readonly code: string, readonly statusCode = 503) { super(code); }
}
export interface WorkerExtraction {
  bytes: Buffer; sourceSha256: string; width: number; height: number; region: ExtractionRect;
  sourceWidth: number; sourceHeight: number; ms: number;
  candidateRegion?:ExtractionRect;
  evidence: Record<string, unknown>; modelFingerprint?:string;
}
const config = () => {
  try {
    const url = new URL(process.env.TITLE_EXTRACTOR_URL ?? ''); const token = process.env.TITLE_EXTRACTOR_TOKEN;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !token || token.length < 16) return null;
    return { url: url.href.replace(/\/$/, ''), token };
  } catch { return null; }
};
export async function titleExtractorHealth(): Promise<{ready:boolean;modelFingerprint:string|null}|null> {
  const configured = config(); if (!configured) return null;
  try {
    const r = await fetch(configured.url+'/healthz', { headers: { authorization: 'Bearer '+configured.token }, redirect: 'error', signal: AbortSignal.timeout(2500) });
    if (!r.ok) return null;
    const body = JSON.parse((await readCapped(r, 16_384)).toString('utf8'));
    return body.version===1?{ready:body.ready===true,modelFingerprint:typeof body.modelFingerprint==='string'&&/^[a-f0-9]{64}$/.test(body.modelFingerprint)?body.modelFingerprint:null}:null;
  } catch { return null; }
}
export async function titleExtractorReady():Promise<boolean>{return(await titleExtractorHealth())?.ready===true;}
export async function extractCoverTitle(bytes: Buffer, selection: { region?: ExtractionRect; exclusions: ExtractionRect[] },
  expectedTitles: string[], signal: AbortSignal): Promise<WorkerExtraction> {
  const configured = config(); if (!configured) throw new ExtractionError('worker_unavailable');
  let response: Response;
  try {
    response = await fetch(configured.url+'/v1/extract', { method: 'POST', redirect: 'error',
      headers: { authorization: 'Bearer '+configured.token, 'content-type': 'application/json' },
      body: JSON.stringify({ imageBase64: bytes.toString('base64'), ...selection, expectedTitles: expectedTitles.slice(0,8).map((t) => t.slice(0,200)) }), signal });
  } catch { throw new ExtractionError(signal.aborted ? 'extract_timeout' : 'worker_unavailable'); }
  if (!response.ok) {
    if (response.status === 429) throw new ExtractionError('extract_busy', 429);
    if (response.status === 422) throw new ExtractionError('no_text', 422);
    throw new ExtractionError('worker_unavailable');
  }
  try {
    const body = JSON.parse((await readCapped(response, 15*1024*1024)).toString('utf8'));
    const value = z.object({ version: z.literal(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), candidateBase64: z.string().max(15*1024*1024),
      width: z.number().int().positive().max(12000), height: z.number().int().positive().max(12000), region: extractionRect,candidateRegion:extractionRect.optional(),
      sourceWidth: z.number().int().positive().max(12000), sourceHeight: z.number().int().positive().max(12000), ms: z.number().nonnegative().max(300_000),
      modelFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional(),evidence: z.record(z.string(), z.unknown()) }).parse(body);
    if (value.sourceSha256 !== createHash('sha256').update(bytes).digest('hex') || !/^[a-z0-9+/]*={0,2}$/i.test(value.candidateBase64)) throw new Error('wrong source');
    return { ...value, bytes: Buffer.from(value.candidateBase64, 'base64') };
  } catch { throw new ExtractionError('extract_failed', 502); }
}
