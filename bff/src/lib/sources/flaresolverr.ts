// Thin client for FlareSolverr (headless-Chrome Cloudflare solver). Returns solved page HTML, and keeps the
// latest cf_clearance cookies + user-agent per origin so the downloader can fetch images directly afterwards.
const FS = (process.env.FLARESOLVERR_URL || 'http://yomi-flaresolverr:8191').replace(/\/$/, '');

interface Solution { url: string; status: number; response: string; cookies: Array<{ name: string; value: string }>; userAgent: string }
const sessions = new Map<string, { cookie: string; userAgent: string }>();

async function solve(cmd: 'request.get' | 'request.post', url: string, postData?: string): Promise<Solution> {
  const r = await fetch(`${FS}/v1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cmd, url, postData, maxTimeout: 60000 }),
    signal: AbortSignal.timeout(95000),
  });
  const j: any = await r.json();
  if (j.status !== 'ok' || !j.solution) throw new Error(`flaresolverr: ${j.message || j.status}`);
  const s: Solution = j.solution;
  try {
    const origin = new URL(s.url || url).origin;
    sessions.set(origin, { cookie: (s.cookies || []).map((c) => `${c.name}=${c.value}`).join('; '), userAgent: s.userAgent });
  } catch {}
  return s;
}

export async function cfGet(url: string): Promise<string> {
  return (await solve('request.get', url)).response || '';
}
export async function cfPost(url: string, postData: string): Promise<string> {
  return (await solve('request.post', url, postData)).response || '';
}

/** Cookie header + UA to fetch binaries (images) directly — FlareSolverr can't return binary bodies. */
export async function cfSession(url: string): Promise<{ cookie: string; userAgent: string }> {
  const origin = new URL(url).origin;
  if (!sessions.has(origin)) await cfGet(`${origin}/`);
  return sessions.get(origin) || { cookie: '', userAgent: 'Mozilla/5.0' };
}
