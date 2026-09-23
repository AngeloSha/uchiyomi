/**
 * The digest's wording (v0.43.0, #70): "{count} new chapters in {series}", or whatever the admin wrote.
 *
 * ⚠️ NO IMPORTS, ON PURPOSE. The admin panel shows a live preview of the template, and `web/lib/notifyDigest.ts`
 * carries a copy of `renderDigest` for it; `web/test/adminNotifications.test.ts` imports THIS file and the
 * copy and renders the same fixtures through both, so the preview cannot drift from what is sent. An import
 * here would drag the server into that test, and a server module has no place in the web build.
 *
 * Series titles come from scraped sources. They are only ever interpolated into a message that is then
 * JSON-encoded or sent as a text body -- never into a URL or a header -- and control characters are stripped
 * so a title cannot forge a line in a text notification.
 */

/** The default, as the issue asked for it. One chapter reads "1 new chapter", not "1 new chapters". */
export const DEFAULT_TEMPLATE = '{count} new chapters in {series}';
const DEFAULT_TEMPLATE_ONE = '{count} new chapter in {series}';
/** How many titles `{list}` names before "…and N more". */
export const LIST_MAX = 10;
/** A rendered message is cut here: a phone notification is not the place for a library listing. */
export const MESSAGE_MAX = 1000;
export const TEMPLATE_VARIABLES = ['{count}', '{series}', '{list}'] as const;

/** Control characters out of a scraped title; a newline becomes a space, so a title stays one line. */
const cleanTitle = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
/** The template may break lines on purpose; every other control character goes. */
const cleanTemplate = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, '');

/**
 * Render the digest for these series.
 *
 * `{count}` the chapters added, `{series}` the one title when there is one and "N series" otherwise,
 * `{list}` up to ten titles then "…and N more". An unknown placeholder stays literal, so the preview shows
 * `{chapters}` and the admin fixes it rather than wondering why the message is short.
 *
 * ONE pass over the template: a series called "{count}" is text, not a second expansion. A chain of one
 * replace per variable is only safe while `{list}` happens to run last, which nothing would keep true.
 * Reintroduce by chaining `.replace(/\{list\}/g, …).replace(/\{series\}/g, …).replace(/\{count\}/g, …)`:
 * "a title that looks like a placeholder is not expanded" in notifySend.test.ts sees the titles expanded.
 */
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
