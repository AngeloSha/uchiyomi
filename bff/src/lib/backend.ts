// Selects the content backend: the real Komga client, or our owned CBZ-library backend.
// Flip with LIBRARY_BACKEND=owned. Until cutover the default keeps the live app on Komga.
import { komga } from './komga';
import { owned } from './ownedCatalog';

export const OWNED = process.env.LIBRARY_BACKEND === 'owned';

// When false (owned mode) there is no native Komga progress store, so every account — including admin —
// is tracked via read_progress (catalog.ts gates its admin-native-progress branches on this).
export const NATIVE_PROGRESS = !OWNED;

// drop-in for `komga`; typed as any so the existing call sites compile unchanged.
export const content: any = OWNED ? owned : komga;
