import { one, tx } from './db';
import { lockLibrarySaves } from './libraryFolders';
import { privateBackendSupported, privateFolderOwner, reservedPrivateFolder, folderForScope } from './contentScope';
import { libraryRows, libraryIdFor, withScansHeld } from './library';
import { renameSeriesFolder, type FileOpRefusal } from './libraryAdmin';
import { libraryChanged } from './discoverIdentity';
import { syncSeriesPrivacy } from './trackers';

export interface FilingSeries {
  id: string; folder: string; library_id: string; is_private: boolean; owner_user_id: string | null;
  work_id: string | null; deleted_at: unknown; merged_into: string | null;
}
export interface FilingLibrary { id: string; path: string; paths: string[]; managed_private: boolean; owner_user_id: string | null }
type Writer = (ids: readonly string[], folders: readonly string[]) => { release(): void } | null;

/** The caller holds an exclusive privacy lease and has obtained visibility confirmation, if needed. */
export async function fileSeriesInLibrary(row: FilingSeries, target: FilingLibrary | null, userId: string, writer: Writer): Promise<{ok:true} | FileOpRefusal> {
  const visibilityChanges = target !== null && row.is_private !== target.managed_private;
  if (row.is_private && row.owner_user_id !== userId || target?.managed_private && target.owner_user_id !== userId)
    return {ok:false,code:'not_found',reason:'That private library is unavailable.'};
  if (row.deleted_at || row.merged_into) return {ok:false,code:'admin_cleanup_required',reason:'Restore this series before filing it.'};
  let dest = row.folder;
  if (visibilityChanges) {
    if (!privateBackendSupported()) return {ok:false,code:'unsafe_files',reason:'This library backend does not support private filing.'};
    if (row.work_id) return {ok:false,code:'edition_privacy_conflict',reason:'Unlink editions before changing visibility.'};
    // A merge moves chapter rows, not files: a series that absorbed another reads chapters from that series' folder, and
    // only this folder moves here. Those chapters would keep the old visibility, and the scanner then skips them for good.
    // Asked again inside the catalogue step. Reintroduce by dropping this: "a series that absorbed a merge" in
    // libraryMove.int.test.ts changes visibility with chapters left behind.
    if (await one('SELECT 1 FROM lib_series WHERE merged_into=$1 LIMIT 1',[row.id]) || await one(`SELECT 1 FROM lib_books WHERE series_id=$1 AND left(file,length($2)+1)<>$2||'/' LIMIT 1`,[row.id,row.folder]))
      return {ok:false,code:'unsafe_files',reason:'Some of this series’ chapters are stored in another series’ folder.'};
    if (row.owner_user_id && row.owner_user_id !== userId) return {ok:false,code:'forbidden',reason:'Only the original owner can change this series’ visibility.'};
    const storedOwner = privateFolderOwner(row.folder);
    if (reservedPrivateFolder(row.folder) && storedOwner !== userId) return {ok:false,code:'forbidden',reason:'That folder belongs to another private namespace.'};
    const base = storedOwner ? row.folder.slice(`_private/${storedOwner}/`.length) : row.folder;
    if (!base || base === row.folder && reservedPrivateFolder(base)) return {ok:false,code:'unsafe_files',reason:'Choose a series folder below the private namespace.'};
    dest = target!.managed_private ? `_private/${userId}/${base}` : await folderForScope({
      key:`shared:${target!.id}`, libraryId:target!.id, visibility:'shared', ownerUserId:null, folderPrefix:target!.path,
    },base);
  }
  const claim = writer([row.id],[row.folder,dest]);
  if (!claim) return {ok:false,code:'busy',reason:'Another task is changing this series. Try again when it finishes.'};
  try {
    if (visibilityChanges) {
      const moved = await withScansHeld(() => renameSeriesFolder(row.id,dest,{userId,isPrivate:target!.managed_private,libraryId:target!.id,expected:{folder:row.folder,libraryId:row.library_id,isPrivate:row.is_private,ownerUserId:row.owner_user_id},expectedLibrary:{path:target!.path,paths:target!.paths}}));
      if (!moved.ok) return moved;
    } else {
      const automaticId = target?.id ?? (row.is_private ? row.library_id : libraryIdFor(row.folder,
        (await libraryRows()).filter(lib=>!reservedPrivateFolder(lib.path))));
      await tx(async qq=>{
        await lockLibrarySaves(qq);
        const [locked] = await qq<FilingSeries>('SELECT id,folder,library_id,is_private,owner_user_id,work_id,deleted_at,merged_into FROM lib_series WHERE id=$1 FOR UPDATE',[row.id]);
        if (!locked || locked.folder!==row.folder || locked.library_id!==row.library_id || locked.is_private!==row.is_private || locked.owner_user_id!==row.owner_user_id || locked.deleted_at || locked.merged_into)
          throw new Error('The series changed. Please try again.');
        const lib = await qq<FilingLibrary>('SELECT id,path,managed_private,owner_user_id FROM libraries WHERE id=$1 FOR SHARE',[automaticId]);
        if (!lib[0] || lib[0].managed_private!==row.is_private || row.is_private && lib[0].owner_user_id!==userId)
          throw new Error('The destination library changed. Please try again.');
        await qq('UPDATE lib_series SET library_id=$2,library_pinned=$3 WHERE id=$1',[row.id,automaticId,target!==null]);
      });
    }
    libraryChanged();
    if (visibilityChanges && target!.managed_private) void syncSeriesPrivacy(userId,row.id).catch(()=>{});
    return {ok:true};
  } catch {
    return {ok:false,code:'catalogue_changed',reason:'The series or destination changed. Please try again.'};
  } finally { claim.release(); }
}

export const filingLibrary = (id:string) => one<FilingLibrary>('SELECT l.id,l.path,l.managed_private,l.owner_user_id,ARRAY(SELECT p.path FROM library_paths p WHERE p.library_id=l.id ORDER BY p.path) AS paths FROM libraries l WHERE l.id=$1',[id]);
