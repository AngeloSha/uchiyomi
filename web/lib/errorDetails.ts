import { saidText, type Said } from './said';
import type { NoticeOpts } from './notices';

/** Diagnostics are plain text. Only known diagnostic fields are read; never serialize an API response wholesale. */
export function redactDiagnostic(text: string): string {
  return text.replace(/\r\n?/g, '\n')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/(\b(?:authorization|proxy-authorization|set-cookie|cookie)\s*[:=]\s*)[^\n]+/gi, '$1[redacted]')
    .replace(/((?:["']?)(?:password|passwd|secret|authorization|cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|token)(?:["']?)\s*[:=]\s*)(?:\[redacted\]|"[^"\n]*"|'[^'\n]*'|[^\s,;}\]&]+)/gi, '$1[redacted]')
    .replace(/([?&](?:password|secret|access[_-]?token|refresh[_-]?token|api[_-]?key|token)=)[^&#\s]*/gi, '$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[a-z0-9+/_~.=-]+/gi, '$1 [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .trim();
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function errorPayload(error: unknown): Record<string, unknown> | null {
  const value = object(error);
  if (typeof value?.body !== 'string') return null;
  try { return object(JSON.parse(value.body)); } catch { return null; }
}

/** Keep complete stack traces and nested causes, while omitting unrelated response data and credentials. */
export function errorDetailsOf(error: unknown): string | undefined {
  const parts: string[] = [];
  const seen = new Set<object>();
  const read = (input: unknown, depth = 0) => {
    if (typeof input === 'string') { if (input.trim()) parts.push(input); return; }
    const value = object(input);
    if (!value || seen.has(value) || depth > 4) return;
    seen.add(value);
    for (const key of ['message', 'reason', 'stack', 'detail', 'details']) if (typeof value[key] === 'string') read(value[key], depth + 1);
    if (typeof value.error === 'string' && /^[\w.-]{1,100}$/.test(value.error)) parts.push(`Code: ${value.error}`);
    if (value.cause) read(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const entry of value.errors) read(entry, depth + 1);
  };
  const outer = object(error);
  const payload = errorPayload(error);
  if (payload) read(payload); else read(error);
  if (typeof outer?.status === 'number' && Number.isInteger(outer.status)) parts.unshift(`HTTP ${outer.status}`);
  return [...new Set(parts.map(redactDiagnostic).filter(Boolean))].join('\n\n') || undefined;
}

/** An optional, backward-compatible useToast tuple: a localized summary with diagnostics behind Details. */
export function errorNoticeOf(error: unknown, fallback: string): [string, 'error', NoticeOpts] {
  const payload = errorPayload(error);
  const said = payload?.messageSaid;
  const validSaid = (value: unknown): value is Said => typeof object(value)?.code === 'string';
  let translated = fallback;
  if (validSaid(said) || (Array.isArray(said) && said.every(validSaid))) {
    try { translated = saidText(said, fallback); } catch { /* A malformed diagnostic must not hide the action's failure. */ }
  }
  const message = redactDiagnostic(translated.length <= 240 && !/[\r\n]/.test(translated) ? translated : fallback);
  const details = errorDetailsOf(error);
  return [message, 'error', details && details !== message ? { details } : {}];
}
