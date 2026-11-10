export type ContentVisibility = 'shared' | 'private';

export interface ContentPrivacy {
  supported: boolean;
  defaultPrivate: boolean;
  privateLibraryId: string | null;
}

export interface ContentSelection {
  ownerId: string;
  visibility: ContentVisibility;
}

/** A failed or stale account lookup must never become an implicit shared addition. */
export function contentPrivacyOf(value: unknown): ContentPrivacy {
  if (!value || typeof value !== 'object') throw new Error('Privacy settings unavailable');
  const v = value as Record<string, unknown>;
  if (typeof v.supported !== 'boolean' || typeof v.defaultPrivate !== 'boolean'
      || !(v.privateLibraryId == null || typeof v.privateLibraryId === 'string')) {
    throw new Error('Privacy settings unavailable');
  }
  return { supported: v.supported, defaultPrivate: v.defaultPrivate,
    privateLibraryId: typeof v.privateLibraryId === 'string' ? v.privateLibraryId : null };
}

export function additionVisibility(ownerId: string | null, preferences: ContentPrivacy | undefined,
  selection: ContentSelection | null): ContentVisibility | null {
  if (!ownerId || !preferences) return null;
  if (!preferences.supported) return 'shared';
  return selection?.ownerId === ownerId ? selection.visibility : preferences.defaultPrivate ? 'private' : 'shared';
}
