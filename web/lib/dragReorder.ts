'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Drag to reorder: press an item, drag it to where it belongs, let go.
 *
 * Every ordered list in the app also has up and down keys, and they stay: they are what a keyboard or a screen
 * reader uses. This is the same move for a pointer, so an item that belongs five places up is one drag, not five
 * presses. It is built on pointer events rather than HTML drag and drop, which does not exist on a phone.
 *
 * A mouse or pen starts a drag after moving a few pixels. A finger has to rest on the item for a moment first
 * (`HOLD_MS`), because a finger that moves at once is scrolling the page, and the item only follows once the
 * page has been told to stay put.
 */

export interface Box { left: number; right: number; top: number; bottom: number }

/** `column`: one item per line, full width. `flow`: items wrapping along a line, like chips or a grid of tiles. */
export type DragLayout = 'column' | 'flow';

/** The list with item `from` taken out and put at index `to` (the index it ends up at). */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  const out = list.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [x] = out.splice(from, 1);
  out.splice(to, 0, x);
  return out;
}

/** Where a drop would land: the index the dragged item ends at, and the item the marker is drawn beside. */
export interface DropSpot {
  to: number;
  /** The index of the item the marker sits against, and which side of it. */
  beside: number;
  side: 'before' | 'after';
}

/**
 * The drop spot for a pointer at (`x`, `y`) while item `from` is dragged, or `null` when dropping there would leave
 * the order as it is (or there is nothing to drop among).
 *
 * `boxes[i]` is item i's box where it sits now. The dragged item is skipped: the pointer is choosing a place among
 * the others. The spot is just before the first other item that is not already behind the pointer, so a pointer past
 * the end of the list means the end, and one above the start means the start.
 */
export function dropSpot(boxes: ReadonlyArray<Box | null | undefined>, from: number, x: number, y: number, layout: DragLayout, rtl = false): DropSpot | null {
  const others: number[] = [];
  boxes.forEach((b, i) => { if (b && i !== from) others.push(i); });
  if (!others.length) return null;
  const behind = (b: Box) => {
    if (layout === 'column') return (b.top + b.bottom) / 2 < y;
    // Along a wrapping line: a whole line above the pointer is behind it, and on the pointer's own line an item is
    // behind it when its middle is on the start side of the pointer -- the left in English, the right in Arabic.
    if (y > b.bottom) return true;
    if (y < b.top) return false;
    const mid = (b.left + b.right) / 2;
    return rtl ? mid > x : mid < x;
  };
  let at = others.length;
  for (let k = 0; k < others.length; k++) {
    if (!behind(boxes[others[k]]!)) { at = k; break; }
  }
  // `at` places among the others is the index the item ends up at once it is taken out of the list, and the
  // item's own index is where it already is.
  if (at === from) return null;
  return at < others.length
    ? { to: at, beside: others[at], side: 'before' }
    : { to: at, beside: others[others.length - 1], side: 'after' };
}

/** How far (px) a mouse moves before a press becomes a drag, and how long (ms) a finger rests. */
export const DRAG_SLOP = 5;
export const HOLD_MS = 350;
/** A finger that wanders further than this while it waits is scrolling, not holding. */
const HOLD_WANDER = 8;
/** Near the edge of a scrolling area the drag scrolls it. */
const EDGE = 48;
const EDGE_STEP = 14;

/** Things inside an item that keep their own press: a key, a field, a link. */
const OWN_PRESS = 'button, input, select, textarea, label, a, [data-no-drag], [contenteditable="true"]';

function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const o = getComputedStyle(n).overflowY;
    if ((o === 'auto' || o === 'scroll') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

export interface DragReorder {
  /** Spread onto item `i`. */
  item: (i: number) => {
    ref: (el: HTMLElement | null) => void;
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => void;
    onDragStart: (e: React.DragEvent<HTMLElement>) => void;
    'data-reorder'?: DragLayout;
    'data-reorder-drag'?: '';
    'data-reorder-drop'?: 'before' | 'after';
  };
  /** The item being dragged, or null. */
  dragging: number | null;
}

/**
 * `count` items, in order; `onMove(from, to)` is called once when one is dropped somewhere else, with the index it
 * should end at. Nothing changes while it is dragged: the item follows the pointer and a marker shows where it would
 * go, so letting go somewhere that is not a spot (outside the list, or Escape) is a cancel.
 *
 * `enabled: false` (a save in flight, a list of one) hands out no handles at all, so the item is an ordinary item.
 */
export function useDragReorder({ count, layout, enabled = true, onMove }: {
  count: number;
  layout: DragLayout;
  enabled?: boolean;
  onMove: (from: number, to: number) => void;
}): DragReorder {
  const els = useRef(new Map<number, HTMLElement>());
  const live = useRef({ count, layout, onMove });
  live.current = { count, layout, onMove };
  const [state, setState] = useState<{ from: number; spot: DropSpot | null } | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  // An item that is dragged when the list stops being draggable (a save began) is let go.
  useEffect(() => { if (!enabled) cleanup.current?.(); }, [enabled]);

  const begin = useCallback((from: number, e: React.PointerEvent<HTMLElement>) => {
    const el = els.current.get(from);
    if (!el) return;
    const pointerId = e.pointerId;
    const touch = e.pointerType === 'touch';
    const startX = e.clientX;
    const startY = e.clientY;
    let x = startX;
    let y = startY;
    let active = false;
    let hold: ReturnType<typeof setTimeout> | null = null;
    let raf = 0;
    let spot: DropSpot | null = null;
    const scroller = scrollParent(el);
    const scrolled = () => (scroller ? scroller.scrollTop : window.scrollY);
    const scrolledAtStart = scrolled();
    const rtl = getComputedStyle(el).direction === 'rtl';

    const boxes = () => Array.from({ length: live.current.count }, (_, i) => els.current.get(i)?.getBoundingClientRect() ?? null);
    const place = () => {
      // The item follows the pointer: moved by its own transform, so the list around it does not reflow.
      // A page that scrolled under it (the edge scroll below) carries it along, so that is added back.
      el.style.transform = `translate(${x - startX}px, ${y - startY + scrolled() - scrolledAtStart}px)`;
      const next = dropSpot(boxes(), from, x, y, live.current.layout, rtl);
      if (next?.to !== spot?.to || next?.beside !== spot?.beside || next?.side !== spot?.side) {
        spot = next;
        setState({ from, spot });
      }
    };

    const tick = () => {
      raf = 0;
      if (!active) return;
      // Near the top or bottom of what scrolls, scroll it, and keep going while the pointer stays there.
      const r = scroller ? scroller.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const by = y < r.top + EDGE ? -EDGE_STEP : y > r.bottom - EDGE ? EDGE_STEP : 0;
      if (by) {
        if (scroller) scroller.scrollTop += by; else window.scrollBy(0, by);
        place();
        raf = requestAnimationFrame(tick);
      }
    };
    const edge = () => { if (!raf) raf = requestAnimationFrame(tick); };

    const swallowClick = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    // Registered when the finger lands, not when the hold ends: the browser decides at the touch's start whether a page
    // listener may veto the scroll, and one added later is too late (the pointer is cancelled the moment the page scrolls).
    // It vetoes nothing until the hold has made this a drag, so a finger that moves first still scrolls.
    const stopTouchScroll = (ev: TouchEvent) => { if (active && ev.cancelable) ev.preventDefault(); };
    const noMenu = (ev: Event) => ev.preventDefault();

    const start = () => {
      active = true;
      document.body.style.userSelect = 'none';
      (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = 'none';
      el.style.zIndex = '50';
      el.style.pointerEvents = 'none';
      setState({ from, spot: null });
      place();
      if (touch && 'vibrate' in navigator) { try { navigator.vibrate(8); } catch { /* not everywhere */ } }
    };

    const finish = (drop: boolean) => {
      if (hold) clearTimeout(hold);
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('touchmove', stopTouchScroll);
      window.removeEventListener('contextmenu', noMenu, true);
      cleanup.current = null;
      if (active) {
        el.style.transform = '';
        el.style.zIndex = '';
        el.style.pointerEvents = '';
        document.body.style.userSelect = '';
        (document.body.style as CSSStyleDeclaration & { webkitUserSelect?: string }).webkitUserSelect = '';
        // The press that ends a drag is not a click on whatever is under it (a link, a key).
        window.addEventListener('click', swallowClick, { capture: true, once: true });
        setTimeout(() => window.removeEventListener('click', swallowClick, true), 0);
        setState(null);
        if (drop && spot) live.current.onMove(from, spot.to);
      }
    };

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      x = ev.clientX; y = ev.clientY;
      if (!active) {
        const far = Math.hypot(x - startX, y - startY);
        if (touch) { if (far > HOLD_WANDER) finish(false); } // moved before the hold: it is a scroll
        else if (far > DRAG_SLOP) start();
        return;
      }
      place();
      edge();
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(true); };
    const cancel = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape' && active) { ev.stopPropagation(); ev.preventDefault(); finish(false); } };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    if (touch) {
      window.addEventListener('touchmove', stopTouchScroll, { passive: false });
      window.addEventListener('contextmenu', noMenu, true);
      hold = setTimeout(() => { hold = null; start(); }, HOLD_MS);
    }
    cleanup.current = () => finish(false);
  }, []);

  const item: DragReorder['item'] = (i) => {
    const on = enabled && count > 1;
    const base = {
      ref: (el: HTMLElement | null) => { if (el) els.current.set(i, el); else els.current.delete(i); },
      onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
        if (!on || cleanup.current) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        if (!e.isPrimary) return;
        // A key, field or link inside the item keeps its own press.
        const t = e.target as HTMLElement;
        const own = t.closest?.(OWN_PRESS);
        if (own && own !== e.currentTarget) return;
        begin(i, e);
      },
      // A link or an image inside an item would otherwise start the browser's own drag of it.
      onDragStart: (e: React.DragEvent<HTMLElement>) => { if (on) e.preventDefault(); },
      'data-reorder': layout,
    } as ReturnType<DragReorder['item']>;
    if (!on) return { ...base, 'data-reorder': undefined };
    if (state?.from === i) base['data-reorder-drag'] = '';
    if (state?.spot?.beside === i) base['data-reorder-drop'] = state.spot.side;
    return base;
  };

  return { item, dragging: state?.from ?? null };
}
