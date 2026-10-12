'use client';
// What a List says about itself (v0.61.0): squared tags for a smart list ("Live list") and one its owner shares
// ("Shared"), and, on someone else's list, whose it is. Tags, never capsules (the owner's "no pills"); a shared list's
// owner is told it is shared, everyone else is told whose it is.
import Link from 'next/link';
import { t as tr } from '@/lib/i18n';
import { libraryHref } from '@/lib/libraryQuery';
import { isMine, type ListOwner, type ListRow } from '@/lib/lists';
import { Avatar } from './Avatar';

const TAG = 'rounded-[4px] border px-1.5 text-[10px] font-semibold leading-4';

export function ListTags({ list }: { list: Pick<ListRow, 'kind' | 'shared' | 'mine'> }) {
  const live = list.kind === 'smart';
  const shared = !!list.shared && isMine(list);
  if (!live && !shared) return null;
  return (
    <span className="inline-flex items-center gap-1" data-list-tags>
      {live && <span className={`${TAG} border-accent/40 text-accent`} data-list-tag="live">{tr('Live list')}</span>}
      {shared && <span className={`${TAG} border-ink-600 text-fog-300`} data-list-tag="shared">{tr('Shared')}</span>}
    </span>
  );
}

/**
 * A list's own keys on its page, its owner's alone (someone else's shared list is read-only: nothing): Edit for a
 * hand-picked list with something in it (remove and reorder), Edit filters for a smart one -- the Library with its search
 * in the address, where Update "Name" saves a change; a smart list holds what its search finds, so it has no Edit --
 * and Share or Stop sharing. Keys, never chips: the chips beside them are the list's sorts.
 */
export function ListKeys({ list, editing, hasItems, onEdit, onShare, busy }: {
  list: Pick<ListRow, 'id' | 'kind' | 'shared' | 'mine' | 'query'>;
  editing: boolean; hasItems: boolean; onEdit: () => void; onShare: () => void; busy: boolean;
}) {
  if (!isMine(list)) return null;
  const smart = list.kind === 'smart';
  return (
    <div data-list-keys className="ms-auto flex flex-wrap items-center gap-2">
      {!smart && (hasItems || editing) && (
        <button type="button" onClick={onEdit} aria-pressed={editing} data-list-edit className={`btn-key ${editing ? 'btn-key-accent' : ''}`}>
          {editing ? tr('Done') : tr('Edit')}
        </button>
      )}
      {smart && list.query && (
        <Link href={libraryHref(list.query, list.id)} className="btn-key" data-list-filters>{tr('Edit filters')}</Link>
      )}
      <button type="button" onClick={onShare} disabled={busy} aria-pressed={!!list.shared} data-list-share className="btn-key">
        {list.shared ? tr('Stop sharing') : tr('Share')}
      </button>
    </div>
  );
}

/** "by Name", with their avatar: on a list someone else shares. The name is isolated, as it sits in a sentence. */
export function ListOwnerLine({ owner, className = '' }: { owner: ListOwner; className?: string }) {
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 text-xs text-fog-500 ${className}`} data-list-owner>
      <Avatar avatar={owner.avatar ?? undefined} size={16} />
      <span className="truncate">{tr('by {name}', { name: `⁨${owner.name}⁩` })}</span>
    </span>
  );
}
