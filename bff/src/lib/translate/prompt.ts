import type { Bubble } from './bubbles';

/**
 * Translated pages, step 2: what the translation model is told. Measured on raw pages (10-19): a model that sees one
 * bubble at a time translates word by word ("War" for ウォー, "What is this?!" for なんだと!?). Told that the text comes
 * from OCR, given the lines before, the series' known names and, when the OCR looks unreliable, the page itself, it
 * writes the scene ("Whoa", "What did you say!?") and repairs most misreads.
 */

/** The reader's language (the app's UI languages), as the model is told it. */
const TARGETS: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Brazilian Portuguese', 'pt-br': 'Brazilian Portuguese',
  ru: 'Russian', ja: 'Japanese', zh: 'Simplified Chinese', ar: 'Arabic',
};
const SOURCES: Record<string, string> = { ja: 'Japanese', zh: 'Chinese', ko: 'Korean', en: 'English' };
const LATIN = new Set(['en', 'es', 'fr', 'de', 'pt', 'pt-br']);

export const targetName = (lang: string) => TARGETS[lang.toLowerCase()] ?? TARGETS[lang.toLowerCase().split(/[-_]/)[0]] ?? 'English';
const sourceName = (lang: string) => SOURCES[lang.toLowerCase().split(/[-_]/)[0]] ?? 'its original language';

export interface Name { source: string; target: string }
export interface PageContext {
  title?: string;
  sourceLang: string;
  names: Name[];
  /** The bubbles before this page in the chapter, oldest first, as translated. */
  previous: Name[];
}

/** The fixed part, the same for every page in one target language (llama.cpp keeps it cached between pages). */
export function systemPrompt(target: string): string {
  const t = targetName(target);
  const latin = LATIN.has(target.toLowerCase()) || LATIN.has(target.toLowerCase().split(/[-_]/)[0]);
  return [
    `You translate comics (manga, manhwa and manhua) into natural ${t} for a reader.`,
    'The text of each bubble comes from OCR and can contain misread or missing characters: work out what was meant from',
    'the scene, the lines before it and, when one is given, the page image.',
    `Character and place names stay names: write them as ${t} readers would${latin ? ' (romanized: Hepburn for Japanese, Pinyin for Chinese, Revised Romanization for Korean)' : ''},`,
    'never translate their meaning, and keep the spellings in the list of known names.',
    'Keep Japanese honorifics such as -san, -chan and senpai, also where a Korean or Chinese edition of a Japanese comic',
    'spells them out (짱 / 酱 = -chan, 씨 / 桑 = -san, 군 / 君 = -kun, 선배 / 前辈 = senpai): they are not part of the name.',
    `Sound effects become short ${t} sound effects. Write speech the way people talk, in the tone of the scene.`,
    'A bubble that is only OCR noise (stray letters, page numbers, watermarks, site names) becomes an empty string.',
    'In "names", list each character or place name on this page with the spelling you used.',
  ].join('\n');
}

/** The per-page message: what is known about the comic, what came before, and this page's bubbles. */
export function pageText(bubbles: Bubble[], ctx: PageContext, withImage: boolean): string {
  const parts: string[] = [];
  if (ctx.title) parts.push(`Comic: ${ctx.title} (${sourceName(ctx.sourceLang)})`);
  if (ctx.names.length) parts.push(`Known names: ${ctx.names.map((n) => `${n.source} = ${n.target}`).join('; ')}`);
  if (ctx.previous.length) parts.push(`Earlier in this chapter:\n${ctx.previous.map((p) => `- ${p.source} => ${p.target}`).join('\n')}`);
  parts.push(`${withImage ? 'The image is this page. ' : ''}OCR read ${bubbles.length} bubble${bubbles.length === 1 ? '' : 's'} on this page, in reading order:\n`
    + bubbles.map((b, i) => `${i + 1}. ${b.text}`).join('\n'));
  parts.push(`Answer with JSON: "lines" holds exactly ${bubbles.length} strings, one per bubble, in the same order.`);
  return parts.join('\n\n');
}

/** The answer's shape, enforced by llama.cpp's grammar: exactly one line per bubble, so a line can never land in the wrong bubble. */
export function answerSchema(n: number): object {
  return {
    type: 'object',
    properties: {
      lines: { type: 'array', items: { type: 'string' }, minItems: n, maxItems: n },
      names: {
        type: 'array', maxItems: 12,
        items: { type: 'object', properties: { source: { type: 'string' }, target: { type: 'string' } }, required: ['source', 'target'] },
      },
    },
    required: ['lines', 'names'],
  };
}

/** The model's answer, checked: n trimmed lines and the names it used (each at most 40 characters, both sides set). */
export function parseAnswer(content: string, n: number): { lines: string[]; names: Name[] } {
  const a = JSON.parse(content) as { lines?: unknown; names?: unknown };
  if (!Array.isArray(a.lines) || a.lines.length !== n || !a.lines.every((l) => typeof l === 'string')) {
    throw new Error(`the answer has ${Array.isArray(a.lines) ? a.lines.length : 'no'} lines for ${n} bubbles`);
  }
  const names = (Array.isArray(a.names) ? a.names : [])
    .filter((x): x is Name => !!x && typeof x === 'object' && typeof (x as Name).source === 'string' && typeof (x as Name).target === 'string')
    .map((x) => ({ source: x.source.trim(), target: x.target.trim() }))
    .filter((x) => x.source && x.target && x.source.length <= 40 && x.target.length <= 40 && x.source !== x.target);
  return { lines: (a.lines as string[]).map((l) => l.trim()), names };
}
