// How a library starts: the keys an empty library offers (v0.55.4, #158).
//
// DannyDynamite39: "I have found the import, god damn it's way too buried, it should be the first thing that gets
// recommended when the server is set up." It was Admin → Sources → Add sources → Import a list, and a new server opens
// on an empty Library that said "Your library is empty." with no way out, and a Home whose only key was "Browse
// library" -- to that same empty page. Both now offer what a new owner can actually do, in this order: bring a
// library over from another app (admins: the import page is theirs alone, and the server refuses it to anyone else),
// then find series in Discover (whoever may add series). Someone who may do neither is offered nothing that would
// lead to a refusal.

export type StartKey = 'import' | 'discover';

/** The import page. ⚠️ The trailing slash is load-bearing in the static export (app/admin/import/page.tsx). */
export const IMPORT_HREF = '/admin/import/';
export const DISCOVER_HREF = '/discover/';

/** The keys, in order, for this viewer. Empty when there is nothing they may do about an empty library. */
export function startKeys({ isAdmin, mayDownload }: { isAdmin: boolean; mayDownload: boolean }): StartKey[] {
  const out: StartKey[] = [];
  if (isAdmin) out.push('import');
  if (mayDownload) out.push('discover');
  return out;
}
