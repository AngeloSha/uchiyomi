import { one, q, tx } from './db';
import { NO_LIBRARIES, Params, visible, type ViewCtx } from './visibility';

export const PRIVATE_FOLDER = '_private';
export interface AddScope {
  readonly key: string;
  readonly libraryId: string;
  readonly ownerUserId: string | null;
  readonly visibility: 'shared' | 'private';
  readonly folderPrefix: string;
}
export class ContentScopeError extends Error {
  constructor(public readonly statusCode: number, public readonly code: string) { super(code); }
}
const deny = (code = 'forbidden'): never => { throw new ContentScopeError(403, code); };
export const privateBackendSupported = () => process.env.LIBRARY_BACKEND !== 'komga';
export const privateFolderOwner = (folder: string): string | null => {
  const match = /^_private\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/i.exec(folder);
  return match?.[1].toLowerCase() ?? null;
};
export const reservedPrivateFolder = (folder: string): boolean => folder === PRIVATE_FOLDER || folder.startsWith(PRIVATE_FOLDER + '/');

export async function defaultPrivateFor(userId: string): Promise<boolean> {
  const row = await one<{ enabled: boolean }>("SELECT data->'defaultPrivate' = 'true'::jsonb AS enabled FROM app_settings WHERE user_id=$1", [userId]);
  return row?.enabled === true;
}

/** Server-only ownership resolution; callers cannot nominate another account. */
export async function ensurePrivateLibrary(userId: string): Promise<AddScope> {
  const id = `private_${userId}`;
  const prefix = `${PRIVATE_FOLDER}/${userId}`;
  await tx(async qq => {
    await qq(`INSERT INTO libraries(id,name,path,owner_user_id,managed_private) VALUES($1,'Private library',$2,$3,true)
      ON CONFLICT(id) DO NOTHING`, [id, prefix, userId]);
    const [lib] = await qq<{ owner_user_id: string; managed_private: boolean }>('SELECT owner_user_id,managed_private FROM libraries WHERE id=$1', [id]);
    if (!lib?.managed_private || lib.owner_user_id !== userId) deny();
    await qq('INSERT INTO library_paths(library_id,path) VALUES($1,$2) ON CONFLICT(path) DO NOTHING', [id, prefix]);
    const [path] = await qq<{ library_id: string }>('SELECT library_id FROM library_paths WHERE path=$1', [prefix]);
    if (path?.library_id !== id) deny();
  });
  return { key: `private:${userId}`, libraryId: id, ownerUserId: userId, visibility: 'private', folderPrefix: prefix };
}

export async function resolveAddScope(
  viewer: ViewCtx,
  requested: { visibility?: 'shared' | 'private'; libraryId?: string } = {},
  operation: 'download' | 'upload' | 'import' = 'download',
): Promise<AddScope> {
  if (!viewer.userId || viewer.system || viewer.libraryIds?.includes(NO_LIBRARIES)) return deny();
  const account = await one<{ role: string; disabled: boolean; perms: { canDownload?: boolean; canUploadManually?: boolean } }>(
    'SELECT role,disabled,perms FROM users WHERE id=$1', [viewer.userId]);
  if (!account || account.disabled) return deny();
  if (account.role !== 'admin' && (operation === 'upload' ? account.perms?.canUploadManually !== true : account.perms?.canDownload === false)) deny();
  const visibility = requested.visibility ?? (await defaultPrivateFor(viewer.userId) ? 'private' : 'shared');
  if (visibility === 'private') {
    if (!privateBackendSupported()) throw new ContentScopeError(409, 'private_backend_unsupported');
    const scope = await ensurePrivateLibrary(viewer.userId);
    if (requested.libraryId && requested.libraryId !== scope.libraryId) deny();
    return scope;
  }
  const id = requested.libraryId ?? 'lib';
  const lib = await one<{ id: string; path: string; owner_user_id: string | null; age_rating: number | null }>('SELECT id,path,owner_user_id,age_rating FROM libraries WHERE id=$1', [id]);
  if (!lib || lib.owner_user_id || reservedPrivateFolder(lib.path) || (viewer.libraryIds && !viewer.libraryIds.includes(id))) return deny();
  if (viewer.maxAgeRating !== null && lib.age_rating !== null && lib.age_rating > viewer.maxAgeRating) deny();
  return { key: `shared:${id}`, libraryId: id, ownerUserId: null, visibility: 'shared', folderPrefix: lib.path };
}

export function scopeSql(alias: string, scope: AddScope, p: Params): string {
  return scope.visibility === 'private'
    ? `${alias}.is_private AND ${alias}.owner_user_id=${p.add(scope.ownerUserId)}::uuid`
    : `NOT ${alias}.is_private AND ${alias}.library_id=${p.add(scope.libraryId)}`;
}
/** Multi-folder shared libraries keep their existing spelling and destination. */
export async function folderForScope(scope: AddScope, folder: string): Promise<string> {
  if (!scope.folderPrefix || folder === scope.folderPrefix || folder.startsWith(scope.folderPrefix + '/')) return folder;
  if (scope.visibility === 'shared' && await one(`SELECT 1 FROM library_paths WHERE library_id=$1
    AND ($2=path OR left($2,length(path)+1)=path||'/') LIMIT 1`,[scope.libraryId,folder])) return folder;
  return `${scope.folderPrefix}/${folder}`;
}
export function sameContentScope(a: { is_private: boolean; owner_user_id: string | null; library_id: string }, b: { is_private: boolean; owner_user_id: string | null; library_id: string }): boolean {
  return a.is_private === b.is_private && (a.is_private ? a.owner_user_id === b.owner_user_id : a.library_id === b.library_id);
}
export const sameScopeSql = (a:string,b:string):string =>
  `(${a}.is_private=${b}.is_private AND (${a}.is_private AND ${a}.owner_user_id=${b}.owner_user_id OR NOT ${a}.is_private AND ${a}.library_id=${b}.library_id))`;
/** Existing shared works can span libraries; each sibling still needs the viewer's own library grant. */
export const samePrivacyDomainSql = (a:string,b:string):string =>
  `(${a}.is_private=${b}.is_private AND (NOT ${a}.is_private OR ${a}.owner_user_id=${b}.owner_user_id))`;
export async function scopeForSeries(viewer: ViewCtx, id: string, opts: { write?: boolean } = {}): Promise<AddScope | null> {
  const p = new Params();
  const row = await one<{ library_id: string; owner_user_id: string | null; is_private: boolean; folder: string }>(
    `SELECT s.library_id,s.owner_user_id,s.is_private,s.folder FROM lib_series s WHERE s.id=${p.add(id)} AND ${visible('s', viewer, p)}`, p.values);
  if (!row || (opts.write && row.is_private && row.owner_user_id !== viewer.userId)) return null;
  const lib = await one<{ path: string }>('SELECT path FROM libraries WHERE id=$1', [row.library_id]);
  return { key: row.is_private ? `private:${row.owner_user_id}` : `shared:${row.library_id}`, libraryId: row.library_id,
    ownerUserId: row.owner_user_id, visibility: row.is_private ? 'private' : 'shared', folderPrefix: lib?.path ?? '' };
}

/** Historical private reads remain private after publication. */
export const sharedActivitySql = (seriesAlias: string, eventAlias: string): string =>
  `(NOT ${eventAlias}.is_private AND NOT COALESCE(${seriesAlias}.is_private,false))`;

/** Scanner reconstructs ownership from the reserved namespace, never shared fallback. */
export async function privateScopeForFolder(folder: string): Promise<AddScope | null> {
  if (!reservedPrivateFolder(folder)) return null;
  const owner = privateFolderOwner(folder);
  if (!owner || !(await one('SELECT id FROM users WHERE id=$1', [owner]))) throw new ContentScopeError(409, 'orphan_private_folder');
  return ensurePrivateLibrary(owner);
}

/** Account removal cannot turn its private rows into ownerless shared content. */
export async function deleteAccountPreservingPrivate(userId: string): Promise<'deleted'|'owned_content'|'not_found'> {
  return tx(async qq=>{
    const [user]=await qq('SELECT id FROM users WHERE id=$1 FOR UPDATE',[userId]);
    if (!user) return 'not_found';
    if ((await qq(`SELECT 1 FROM lib_series s WHERE owner_user_id=$1
      OR EXISTS(SELECT 1 FROM libraries l WHERE l.id=s.library_id AND l.owner_user_id=$1) LIMIT 1`,[userId])).length) return 'owned_content';
    // An empty managed library has no content to transfer; orphaned disk paths remain quarantined by the scanner.
    await qq('DELETE FROM libraries WHERE owner_user_id=$1 AND managed_private AND NOT EXISTS(SELECT 1 FROM lib_series WHERE library_id=libraries.id)',[userId]);
    await qq('DELETE FROM users WHERE id=$1',[userId]);
    return 'deleted';
  });
}
