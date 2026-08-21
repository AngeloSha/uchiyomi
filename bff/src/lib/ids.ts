// Identity for library rows.
//
// These used to be sha1 of the file path, which made the path the identity: renaming a folder minted a new
// series and stranded the user's reading progress on the old row, and two library roots holding the same
// relative path collided. Ids are minted here instead, so a row can move on disk and stay itself.
//
// The SHAPE is deliberately unchanged from the hashed version -- same prefix, same length, same character
// class -- because existing ids appear in URLs, OPDS entry ids, the offline IndexedDB keys on people's
// phones, and the cover filenames under CONFIG_DIR. Every one of those keeps working, and an install that
// predates the change ends up with a mix of hashed and minted ids that nothing can tell apart.
import { randomBytes } from 'crypto';

/** 20 hex characters, matching the sliced sha1 these replace. */
const rand = () => randomBytes(10).toString('hex');

export const newSeriesId = (): string => 's_' + rand();
export const newBookId = (): string => 'b_' + rand();

/** Shape check, used by tests and by anything validating an id from outside. */
export const isSeriesId = (s: string): boolean => /^s_[0-9a-f]{20}$/.test(s);
export const isBookId = (s: string): boolean => /^b_[0-9a-f]{20}$/.test(s);
