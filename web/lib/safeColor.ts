// A colour a member stored (their avatar, a list's accent) as it may be painted for other members: a hex colour, or the
// fallback. These land in an inline `background`, where a stored `url(https://…)` made every viewer's browser fetch a
// URL the member chose (v0.69.1). The server refuses anything else now; this covers what was stored before.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export const safeColor = (c: unknown, fallback: string): string => (typeof c === 'string' && HEX.test(c.trim()) ? c.trim() : fallback);
