import type { OcrLine } from './ocrCore';

/** One speech bubble (or caption): the lines OCR found close together, in reading order, as one text. */
export interface Bubble {
  box: [number, number, number, number];
  vertical: boolean;
  text: string;
  score: number;
  lines: OcrLine['box'][];
}

/** Comics in these languages are read right to left: bubbles across a page, and columns within a vertical bubble. */
const RIGHT_TO_LEFT = new Set(['ja']);
/** Scripts written without spaces between words: a bubble's lines are joined directly. */
const NO_SPACES = new Set(['ja', 'zh']);

const base = (lang: string) => lang.toLowerCase().split(/[-_]/)[0];
const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s[s.length >> 1] ?? 0; };

/**
 * The page's bubbles from its OCR lines. Lines whose boxes come within about a line's thickness of each other belong to
 * one bubble (the gap between two bubbles is wider than the gap between two lines of one). A bubble is vertical when
 * most of its lines are; it reads its columns right to left, a horizontal one its rows top to bottom. Bubbles are put
 * in the page's reading order: bands down the page, and within a band right to left for Japanese, else left to right.
 */
export function bubblesOf(lines: OcrLine[], lang: string): Bubble[] {
  const L = lines.filter((l) => l.text.trim());
  if (!L.length) return [];
  const thick = median(L.map((l) => Math.min(l.box[2] - l.box[0], l.box[3] - l.box[1]))) || 10;
  const pad = thick * 0.9;
  const parent = L.map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < L.length; i++) {
    for (let j = i + 1; j < L.length; j++) {
      const a = L[i].box, b = L[j].box;
      if (a[0] - pad < b[2] && b[0] - pad < a[2] && a[1] - pad < b[3] && b[1] - pad < a[3]) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, OcrLine[]>();
  L.forEach((l, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), l]); });
  const rtl = RIGHT_TO_LEFT.has(base(lang));
  const joiner = NO_SPACES.has(base(lang)) ? '' : ' ';
  const out: Bubble[] = [];
  for (const g of groups.values()) {
    const vertical = g.filter((l) => l.tall).length * 2 > g.length;
    // Vertical: columns right to left, each top to bottom. Horizontal: rows top to bottom, each left to right.
    g.sort((a, b) => vertical ? (b.box[2] - a.box[2]) || (a.box[1] - b.box[1]) : (a.box[1] - b.box[1]) || (a.box[0] - b.box[0]));
    out.push({
      box: [Math.min(...g.map((l) => l.box[0])), Math.min(...g.map((l) => l.box[1])), Math.max(...g.map((l) => l.box[2])), Math.max(...g.map((l) => l.box[3]))],
      vertical,
      text: g.map((l) => l.text.trim()).join(joiner),
      score: g.reduce((s, l) => s + l.score, 0) / g.length,
      lines: g.map((l) => l.box),
    });
  }
  const band = thick * 6;
  out.sort((a, b) => (Math.round(a.box[1] / band) - Math.round(b.box[1] / band)) || (rtl ? b.box[2] - a.box[2] : a.box[0] - b.box[0]));
  return out;
}

/**
 * Whether the OCR of a page looks unreliable enough that the translation model should look at the page itself:
 * a low mean recognition score, or a page of scraps (short fragments) rather than sentences. Korean has its own,
 * weaker recogniser, so it is checked with a stricter bar.
 */
export function ocrLooksUnreliable(bubbles: Bubble[], lang: string): boolean {
  if (!bubbles.length) return false;
  const mean = bubbles.reduce((s, b) => s + b.score, 0) / bubbles.length;
  const scraps = bubbles.filter((b) => [...b.text].length <= 2).length / bubbles.length;
  const ko = base(lang) === 'ko';
  return mean < (ko ? 0.92 : 0.85) || scraps > (ko ? 0.25 : 0.4);
}
