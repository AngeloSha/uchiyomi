'use client';
// One verdict about a source, said the same way on Admin -> Providers and on Health's Source health rows (#115,
// v0.49.0).
//
// Two inputs, one look (lib/sourceEvidence.ts turns either into the same lines):
// - `answer`: a Test that just ran in this page -- its checks, its diagnosis, whether it ran out of time, and the
//   'Update address' key for a custom site that has moved;
// - `lines` + `tested`: what the server kept -- one line per stage (search, chapter list, page list, images) and
//   the last deliberate check, so after a reload the card still says what the last Test found.
//
// The source's own error text is shown in full but clamped to two lines, with all of it in the title attribute:
// an engine's Java exception can be three hundred characters, and a phone row is not the place for all of them.
import { t as tr } from '@/lib/i18n';
import { TONE_TEXT } from '@/lib/status';
import {
  answerView, evidenceView, glyphWord, GLYPH_TONE,
  type EvidenceView, type LiveVerdict, type StageLine, type TestAnswer,
} from '@/lib/sourceEvidence';
import { StatusGlyph } from './StatusMark';

export function SourceEvidence({ answer, lines, tested, failing, fix, compact, onMove, className = '' }: {
  answer?: TestAnswer | null;
  lines?: StageLine[] | null;
  tested?: LiveVerdict | null;
  /** Whether the source is failing now; a failed `tested` is red only while it is (lib/sourceEvidence.ts testedLine). */
  failing?: boolean;
  /** The admin's fix sentence for persisted evidence (Health passes item.diagnosis.fix). */
  fix?: string | null;
  /** The last-tested line alone, without the stage lines: a card whose last check passed has nothing to list. */
  compact?: boolean;
  /** Offered only when the live answer says the site moved (a custom site's one-click address update). */
  onMove?: () => void;
  className?: string;
}) {
  const view: EvidenceView = answer ? answerView(answer) : evidenceView(lines, tested, fix, failing);
  const rows = compact ? [] : view.rows;
  if (!view.head && !rows.length && !view.fix) return null;
  const moved = !!answer && answer.diagnosis?.code === 'moved' && !!onMove;
  return (
    <div data-source-evidence={answer ? 'test' : 'stored'} className={`mt-1.5 space-y-1 ${className}`}>
      {view.head && (
        <p data-evidence-head className={`flex items-start gap-1.5 text-[12px] leading-snug ${view.head.tone === 'ok' ? 'text-fog-200' : TONE_TEXT[view.head.tone]}`}>
          <span className="mt-[2px]"><StatusGlyph tone={view.head.tone} size={11} /></span>
          <span className="min-w-0">{view.head.text}</span>
        </p>
      )}
      {!!rows.length && (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            // A stage per line; at 390 px the time and the error wrap UNDER the label rather than squeezing it.
            <li key={r.key} data-evidence-stage={r.key} data-evidence-state={r.glyph} className="flex items-start gap-1.5 text-[11px] leading-snug">
              <span className="mt-[2px]"><StatusGlyph tone={GLYPH_TONE[r.glyph]} size={10} /></span>
              <div className="min-w-0 flex-1">
                <p>
                  <span className="text-fog-200">{r.label}</span>
                  <span className="sr-only"> ({glyphWord(r.glyph)})</span>
                  {r.detail && <span className="text-fog-500"> · {r.detail}</span>}
                  {r.when && <span className="text-fog-600"> · {r.when}</span>}
                </p>
                {r.error && (
                  <p className="line-clamp-2 break-words font-mono text-[10.5px] text-fog-500" title={r.error}>{r.error}</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {view.fix && <p className="text-[11px] leading-relaxed text-fog-400">{view.fix}</p>}
      {moved && (
        <button type="button" onClick={onMove} className="btn-key text-accent">{tr('Update address')}</button>
      )}
    </div>
  );
}
