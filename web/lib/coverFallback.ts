/**
 * The direct URL a card may fall back to when this server's cover proxy fails (`Img`'s fallbackSrc), or undefined.
 *
 * Only a public https address (v0.59.0). An extension source's cover is the engine's own thumbnail --
 * `http://yomi-suwayomi:4567/api/v1/manga/…/thumbnail`, a Docker service name -- which no browser can reach: falling
 * back to it only sent the reader's browser at an internal hostname, and named it. A plain-http cover would be blocked
 * as mixed content on an https page anyway. Reintroduce by passing coverUrl as it is: coverFallback.test.ts's engine
 * case gets the internal URL back.
 */
export function publicCoverFallback(u?: string | null): string | undefined {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && x.hostname.includes('.') ? u : undefined;
  } catch {
    return undefined;
  }
}
