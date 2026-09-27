/**
 * Status as a mark and a word, not a capsule (v0.49.0, "no more pills").
 *
 * The owner asked for the pill shapes to go: Health's "All good" / "Worth a look" / "Needs attention"
 * badges, the source card's "ok", the engine's "ready". What replaces them is a shaped glyph plus coloured
 * text with no fill (components/StatusMark.tsx), and this is the vocabulary it draws from, apart from React
 * so a test can hold the mappings.
 *
 * The SHAPES carry the meaning, not only the colours: check, diamond, triangle, open circle, dash. Today's
 * capsules differ only by tint, which a colour-blind admin reads as three identical badges.
 *
 * ⚠️ Every class string here is a literal, for the reason lib/ring.ts gives: Tailwind only compiles what it
 * can find written out.
 */
import { keys, t as tr } from './i18n';
import type { HealthCheck } from './types';
import type { SrcStatus } from './providerGroups';

/**
 * The six tones.
 * - ok: a healthy thing (emerald), as Health's "All good" always was;
 * - warn: worth a look, and also a refusal (amber) -- "a sweep is running" is not a failure;
 * - problem: needs someone (red);
 * - info: neutral facts, a source that answers empty;
 * - off: switched off on purpose;
 * - accent: an action that is working or has finished -- the accent, like Settings' "✓ Saved", so a
 *   finished repair does not read as a health verdict. Its glyph is the finished one (a check in a ring);
 *   the turning ring is StatusGlyph's `working`, asked for by name, never implied by the tone.
 */
export type Tone = 'ok' | 'warn' | 'problem' | 'info' | 'off' | 'accent';

export const TONE_TEXT: Record<Tone, string> = {
  ok: 'text-emerald-300',
  warn: 'text-amber-300',
  problem: 'text-red-300',
  info: 'text-fog-400',
  off: 'text-fog-500',
  accent: 'text-accent',
};

export const TONE_GLYPH: Record<Tone, string> = {
  ok: 'text-emerald-400',
  warn: 'text-amber-400',
  problem: 'text-red-400',
  info: 'text-fog-500',
  off: 'text-fog-600',
  accent: 'text-accent',
};

/** The 3 px start-edge bar a card may wear (StatusEdge). */
export const TONE_EDGE: Record<Tone, string> = {
  ok: 'bg-emerald-400/70',
  warn: 'bg-amber-400',
  problem: 'bg-red-400',
  info: 'bg-fog-500/60',
  off: 'bg-ink-500',
  accent: 'bg-accent',
};

/**
 * A tinted surface, for a TILE (a rounded rectangle holding a title and a sentence, like Overview's "Needs
 * attention" cards), never for a word-sized badge. These are the tints the Health capsules used.
 */
export const TONE_SURFACE: Record<Tone, string> = {
  ok: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  warn: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  problem: 'border-red-500/40 bg-red-500/10 text-red-300',
  info: 'border-ink-600 bg-ink-800/60 text-fog-300',
  off: 'border-ink-700 bg-ink-850 text-fog-500',
  accent: 'border-accent/40 bg-accent-soft text-accent',
};

export interface Mark {
  tone: Tone;
  /** Already translated. */
  label: string;
}

// Declared through `keys()` because they reach tr() through the maps below, which the string extractor
// cannot see (lib/i18n.ts).
export const HEALTH_LABELS = keys('Needs attention', 'Worth a look', 'All good');

const HEALTH_MARK: Record<HealthCheck['status'], { tone: Tone; label: (typeof HEALTH_LABELS)[number] }> = {
  problem: { tone: 'problem', label: HEALTH_LABELS[0] },
  warn: { tone: 'warn', label: HEALTH_LABELS[1] },
  ok: { tone: 'ok', label: HEALTH_LABELS[2] },
};

/** A Health check's verdict as a mark. */
export function healthMark(status: HealthCheck['status']): Mark {
  const m = HEALTH_MARK[status] ?? HEALTH_MARK.warn;
  return { tone: m.tone, label: tr(m.label) };
}

/**
 * The statuses a source card can show. Today exactly the public source statuses; #115 widens it with
 * `'failing'` (a source whose last deliberate check failed although traffic has not blocked it), and the
 * Record below then refuses to compile until that status has a tone and a word.
 */
export type ProviderStatus = SrcStatus;

// Specific words, not the bare "Off" / "Down" / "Ready": one English word used for two meanings forces a
// translator to pick one of them (the critic's rule for this release's keys). ⚠️ Not the bare "Blocked"
// either: that key is a scanlation GROUP's Block toggle (SourcesSheet.tsx), translated to agree with that
// noun, and on a source card it disagreed with "Turned off" beside it (es "Bloqueado" / "Desactivada").
export const SOURCE_LABELS = keys('Healthy', 'Blocked by the site', 'Rate-limited', 'Not answering', 'Answers empty', 'Turned off');

const SOURCE_MARK: Record<ProviderStatus, { tone: Tone; label: (typeof SOURCE_LABELS)[number] }> = {
  ok: { tone: 'ok', label: SOURCE_LABELS[0] },
  blocked: { tone: 'problem', label: SOURCE_LABELS[1] },
  rate_limited: { tone: 'warn', label: SOURCE_LABELS[2] },
  down: { tone: 'problem', label: SOURCE_LABELS[3] },
  // Answers without error and returns nothing. Deliberately NOT red, as the Providers card never made it:
  // it may be a site redesign rather than a failure, and until it is tested nobody knows which.
  quiet: { tone: 'info', label: SOURCE_LABELS[4] },
  disabled: { tone: 'off', label: SOURCE_LABELS[5] },
};

/** The statuses sourceMark knows, for the test that holds it to the Src type's own list. */
export const SOURCE_STATUSES = Object.keys(SOURCE_MARK) as ProviderStatus[];

/** A source's status as a mark. An unknown status (a newer server) reads as healthy, as the card's `?? 'ok'` does. */
export function sourceMark(st: ProviderStatus | undefined | null): Mark {
  const m = (st && SOURCE_MARK[st]) || SOURCE_MARK.ok;
  return { tone: m.tone, label: tr(m.label) };
}

/** The extension engine's state, for the Extensions header. */
export function engineMark(reachable: boolean, version?: string | null): Mark {
  if (!reachable) return { tone: 'problem', label: tr('Engine unreachable') };
  return { tone: 'ok', label: version ? tr('Engine ready · {version}', { version }) : tr('Engine ready') };
}
