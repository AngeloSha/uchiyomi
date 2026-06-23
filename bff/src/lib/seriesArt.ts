// Shared location for admin-uploaded series cover/banner overrides. Stored on the writable /config volume so
// they survive restarts (the BFF runs as uid 10002, which owns /config). Both the admin write route and the
// image server read route resolve paths through here.
import { join } from 'path';
import { env } from '../env';

export const ART_DIR = join(env.CONFIG_DIR, 'series-art');
const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
export const artFile = (id: string, kind: 'cover' | 'banner') => join(ART_DIR, `${safeId(id)}-${kind}.webp`);
