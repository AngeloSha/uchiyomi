'use client';
// The notices (v0.49.0): what the app says after you do something -- "Fetching 3 chapters…", "Could not
// save" -- as cards at the bottom edge.
//
// Until v0.49.0 these were capsules at the top of the screen for 3.2 s. On a phone that is where every
// dialog keeps its title, and the owner's rule is that a notice never covers one; the pill shape itself is
// one the owner asked to lose. So a notice is now a card anchored to the bottom edge, never the top, placed
// by what lib/layers.ts says is on screen (lib/notices.ts has the rules):
// - on a phone, above the bottom nav, or above a select bar by its measured height;
// - with a dialog open, one card in the bottom nav bar's place -- the strip no dialog can use -- covering the
//   bar exactly;
// - in the reader, above a sheet that runs to the bottom edge;
// - from lg up, in the bottom-end corner, narrowed beside a centred dialog.
// A notice stays as long as it takes to read, pauses while it is hovered, touched or focused, can be
// dismissed or swiped away, and a repeat is one card counting (×2) rather than a stack.
//
// `useToast()` keeps its name and its two arguments, so none of the ~25 callers had to change; the optional
// third says `busy` (a turning ring: the work goes on after the notice), `key` (take the place of an earlier
// notice with that key) or `duration`.
//
// ⚠️ MOTION. Under Reduce effects or the system's reduced-motion setting a card neither slides nor springs,
// and the draining hairline is not drawn; the busy ring is still (ProgressRing handles both). Under reduced
// motion a card cannot be dragged either -- ✕ dismisses it.
import { createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';
import { useLayers } from '@/lib/layers';
import {
  announceText, createCountdown, dropNotice, noticeDuration, noticeOffset, noticePlace, noticeTone, oneAtATime,
  pushNotice, visibleNotices, wideWidth, type Notice, type NoticeOpts, type NoticePlace, type NoticeType,
} from '@/lib/notices';
import { TONE_EDGE } from '@/lib/status';
import { t as tr } from '@/lib/i18n';
import { StatusEdge, StatusGlyph } from './StatusMark';
import { IcX } from './icons';

/** What useToast() returns. Two arguments as it always took; the third is optional (lib/notices.ts NoticeOpts). */
export type Push = (msg: string, type?: NoticeType, opts?: NoticeOpts) => void;

const Ctx = createContext<Push>(() => {});
export const useToast = () => useContext(Ctx);

/** What the two live regions last said. */
interface Said { polite: string; assertive: string }

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Notice[]>([]);
  const [said, setSaid] = useState<Said>({ polite: '', assertive: '' });
  const seq = useRef(0);
  const push = useCallback<Push>((msg, type = 'info', opts = {}) => {
    const id = ++seq.current;
    setItems((s) => pushNotice(s, {
      id, msg, type, busy: !!opts.busy, duration: opts.duration ?? noticeDuration(msg, type), key: opts.key,
    }));
    // An error interrupts; the rest wait for a pause in what the screen reader is saying.
    setSaid((s) => (type === 'error' ? { ...s, assertive: announceText(s.assertive, msg) } : { ...s, polite: announceText(s.polite, msg) }));
  }, []);
  const dismiss = useCallback((id: number) => setItems((s) => dropNotice(s, id)), []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <NoticeViewport items={items} said={said} onDismiss={dismiss} />
    </Ctx.Provider>
  );
}

/**
 * Rendered here, beside the app rather than inside AppShell's <main>: everything in <main> -- every dialog
 * -- is under the bottom nav (z-40, a root-level layer), and a notice docked in the nav band has to be over
 * it. z-[60] is above the navs and below the command palette (z-[70]), which is anchored at the top.
 */
function NoticeViewport({ items, said, onDismiss }: { items: Notice[]; said: Said; onDismiss: (id: number) => void }) {
  // Both hooks on every render and in this order: `a() || b()` would skip the second whenever the first is
  // true, and a hook that is sometimes not called breaks every hook after it.
  const plain = useReduceEffects();
  const still = useReducedMotion();
  const reduced = plain || !!still;
  const layers = useLayers();
  const place = noticePlace(layers);
  const offset = noticeOffset(place, layers);
  const shown = visibleNotices(items, place);
  // Docked in the nav band, the card is as tall as the nav bar it covers (below lg; the bar is not shown above).
  const band = place === 'nav-band';
  const style = {
    '--notice-bottom': offset.phone, '--notice-bottom-lg': offset.wide, '--notice-min-h': band ? `${layers.navHeight}px` : '0px',
  } as CSSProperties;
  return (
    <>
      {/* Always mounted, and filled only when something is said: a live region that appears together with
          its first message is not announced by most screen readers. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{said.polite}</div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">{said.assertive}</div>
      {/* Named only while it holds something: an empty landmark is a stop on the way to nothing. */}
      <section data-notices data-place={place} aria-label={shown.length ? tr('Notifications') : undefined} style={style}
        className={`pointer-events-none fixed inset-x-0 bottom-[var(--notice-bottom)] z-[60] flex flex-col items-center gap-2 ${band ? 'px-4' : 'px-3'} lg:start-auto lg:end-6 lg:bottom-[var(--notice-bottom-lg)] lg:items-stretch lg:px-0 ${wideWidth(place, layers.dialog)}`}>
        <AnimatePresence initial={false}>
          {shown.map((n) => (
            <NoticeCard key={n.id} n={n} place={place} reduced={reduced} still={!!still} onDismiss={onDismiss} />
          ))}
        </AnimatePresence>
      </section>
    </>
  );
}

/** True while the page is in a background tab: nobody can read a notice there, so its clock waits. */
function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const read = () => setHidden(document.visibilityState === 'hidden');
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return hidden;
}

/**
 * The card's clock (lib/notices.ts createCountdown): it runs while the card shows and nothing holds it, and
 * a merge or a replacement (`bump`) starts it again from the full length.
 */
function useNoticeClock(ms: number, bump: number, paused: boolean, onEnd: () => void) {
  const end = useRef(onEnd);
  end.current = onEnd;
  const clock = useRef<ReturnType<typeof createCountdown> | null>(null);
  if (!clock.current) clock.current = createCountdown(ms, () => end.current());
  const seen = useRef(bump);
  useEffect(() => {
    const c = clock.current!;
    if (seen.current !== bump) { seen.current = bump; c.reset(ms); }
    if (paused) c.pause(); else c.run();
  }, [ms, bump, paused]);
  useEffect(() => () => clock.current?.pause(), []);
}

function NoticeCard({ n, place, reduced, still, onDismiss }: {
  n: Notice;
  place: NoticePlace;
  reduced: boolean;
  still: boolean;
  onDismiss: (id: number) => void;
}) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [press, setPress] = useState(false);
  const hidden = usePageHidden();
  const paused = hover || focus || press || hidden;
  useNoticeClock(n.duration, n.bump, paused, () => onDismiss(n.id));
  const tone = noticeTone(n.type);
  // Over a dialog there is room for two lines; from lg up the column beside a dialog is narrow but tall.
  const tight = oneAtATime(place);
  return (
    <motion.div
      data-notice={n.type}
      data-busy={n.busy || undefined}
      layout={reduced ? false : 'position'}
      // In the nav band it is the nav bar's shape and size (max-w-2xl less the nav's px-4, its rounded-3xl,
      // its measured height), so it covers the bar whole; everywhere else a 28 rem card.
      className={`glass-strong pointer-events-auto relative flex w-full flex-col justify-center overflow-hidden border border-ink-700/80 shadow-lift lg:max-w-none ${
        place === 'nav-band' ? 'min-h-[var(--notice-min-h)] max-w-[40rem] rounded-3xl lg:min-h-0 lg:rounded-xl' : 'max-w-md rounded-xl'}`}
      initial={reduced ? false : { opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: 8, transition: { duration: 0.16 } }}
      transition={reduced ? { duration: 0 } : { duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      // Swipe down to dismiss; it springs back from anything shorter. Not under reduced motion.
      drag={still ? false : 'y'}
      dragConstraints={{ top: 0, bottom: 0 }}
      dragElastic={{ top: 0, bottom: 0.6 }}
      onDragEnd={(_, info) => { if (info.offset.y > 36) onDismiss(n.id); }}
      // A mouse resting on it holds it; a finger holds it while it is down. (A touch also fires the mouse
      // events without ever leaving, which would hold a notice for good after one tap.)
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHover(false); else setPress(false); }}
      onPointerDown={(e) => { if (e.pointerType !== 'mouse') setPress(true); }}
      onPointerUp={() => setPress(false)}
      onPointerCancel={() => setPress(false)}
      onFocus={() => setFocus(true)}
      onBlur={() => setFocus(false)}
    >
      <StatusEdge tone={tone} inset="inset-y-0" />
      <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-3 py-3 ps-4 pe-2">
        <span className="mt-px grid h-4 place-items-center">
          <StatusGlyph tone={tone} size={16} working={n.busy} />
        </span>
        <p className={`break-words text-[13px] leading-snug text-fog-100 ${tight ? 'line-clamp-2 lg:line-clamp-none' : ''}`}
          title={tight ? n.msg : undefined}>
          {n.msg}
          {n.count > 1 && <span className="ms-1.5 tabular-nums text-fog-500">×{n.count}</span>}
        </p>
        <button type="button" onClick={() => onDismiss(n.id)} aria-label={tr('Dismiss')}
          className="-my-1.5 grid h-8 w-8 place-items-center rounded-md text-fog-500 transition hover:bg-ink-800 hover:text-fog-100">
          <IcX width={14} height={14} />
        </button>
      </div>
      {/* How long is left, draining toward the start edge; restarted by a merge (its key is the bump). */}
      {!reduced && (
        <span aria-hidden key={n.bump}
          className={`pointer-events-none absolute inset-x-0 bottom-0 h-[2px] origin-[var(--start)] animate-notice-countdown opacity-60 ${TONE_EDGE[tone]}`}
          style={{ animationDuration: `${n.duration}ms`, animationPlayState: paused ? 'paused' : 'running' }} />
      )}
    </motion.div>
  );
}
