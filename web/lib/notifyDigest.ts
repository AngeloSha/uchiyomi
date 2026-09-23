// The notification digest's wording, for the live preview under Admin → Settings → Notifications (#70).
//
// ⚠️ A COPY of `bff/src/lib/notify/template.ts` `renderDigest`, on purpose: the web build cannot import the
// server, and the preview must show exactly what a target will be sent. `test/adminNotifications.test.ts`
// renders the same fixtures through BOTH files and fails on any difference, so change them together.
//
// The message is not translated: it is what goes to the webhook, the phone or the Discord channel, and the
// server sends it in English unless the admin writes a template in their own language. The preview shows
// that, not a translation of it.

export const DEFAULT_TEMPLATE = '{count} new chapters in {series}';
const DEFAULT_TEMPLATE_ONE = '{count} new chapter in {series}';
export const LIST_MAX = 10;
export const MESSAGE_MAX = 1000;
export const TEMPLATE_VARIABLES = ['{count}', '{series}', '{list}'] as const;

const cleanTitle = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
const cleanTemplate = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

/** `{count}` chapters, `{series}` the one title or "N series", `{list}` ten titles then "…and N more". */
export function renderDigest(template: string | null | undefined, series: ReadonlyArray<{ title: string; added: number }>): string {
  const count = series.reduce((n, s) => n + (s.added > 0 ? s.added : 0), 0);
  const titles = series.map((s) => cleanTitle(s.title) || '?');
  const custom = template && template.trim() ? cleanTemplate(template) : null;
  const tpl = custom ?? (count === 1 ? DEFAULT_TEMPLATE_ONE : DEFAULT_TEMPLATE);
  const values: Record<string, string> = {
    count: String(count),
    series: titles.length === 1 ? titles[0] : `${titles.length} series`,
    list: titles.slice(0, LIST_MAX).join(', ') + (titles.length > LIST_MAX ? ` …and ${titles.length - LIST_MAX} more` : ''),
  };
  const out = tpl.replace(/\{(count|series|list)\}/g, (_m, k: string) => values[k]);
  return out.length > MESSAGE_MAX ? `${out.slice(0, MESSAGE_MAX - 1)}…` : out;
}
