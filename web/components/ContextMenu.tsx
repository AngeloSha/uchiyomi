'use client';
import { createPortal } from 'react-dom';
import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent,
} from 'react';
import { contextMenusOn, placeMenu, wantsOwnMenu, LONG_PRESS_MS, LONG_PRESS_SLOP } from '@/lib/contextMenus';

// One menu, opened four ways (#100). lib/contextMenus.ts says when the browser's own menu is left alone.
//
// Replaces the two popovers the series page hand-rolled for its chapter rows (a button, a fixed backdrop, an
// absolutely placed panel -- twice). Those clipped at the screen's edge, could not be reached from the
// keyboard, and existed nowhere else; this one is portalled to <body> (a card inside a transformed or
// blurred parent would otherwise trap a `fixed` panel), flips at the viewport edges, and is a real
// `role="menu"`: arrow keys, Home/End, Enter, and Escape back to where it was opened from.

export interface MenuItem {
  label: string;
  onSelect: () => void | Promise<void>;
  /** A line above this item: where one group of actions ends and the next begins. */
  divider?: boolean;
  danger?: boolean;
  /** Shown, not hidden: offline, the items that need the server say so by being there and greyed. */
  disabled?: boolean;
}

type At = { x: number; y: number };
/** The menu's width (w-52), for anchoring it under a button by its end edge. */
const MENU_W = 208;

function Menu({ items, at, label, onClose }: { items: MenuItem[]; at: At; label: string; onClose: (refocus: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  // Measured, then placed: the height depends on the items, and a menu opened near an edge flips.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos(placeMenu(at, { w: r.width, h: r.height }, { w: window.innerWidth, h: window.innerHeight }));
  }, [at]);

  const enabled = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
  useEffect(() => { if (pos) enabled()[0]?.focus(); }, [pos]);

  // Anything that moves the page under a menu makes its position a lie.
  useEffect(() => {
    const away = () => onClose(false);
    window.addEventListener('resize', away);
    window.addEventListener('scroll', away, true);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('resize', away);
      window.removeEventListener('scroll', away, true);
      window.removeEventListener('blur', away);
    };
  }, [onClose]);

  const onKeyDown = (e: KeyboardEvent) => {
    const list = enabled();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    const go = (k: number) => { e.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(list.length - 1);
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); onClose(true); }
  };

  return createPortal(
    <>
      {/* A new press anywhere else closes it -- on press, not release, so the finger that long-pressed it open
          lifting off again does not. A right-click there closes it too, rather than stacking the browser's. */}
      <div className="fixed inset-0 z-[90]"
        onPointerDown={(e) => { e.preventDefault(); onClose(false); }}
        onContextMenu={(e) => { e.preventDefault(); onClose(false); }} />
      <div ref={ref} role="menu" aria-label={label} onKeyDown={onKeyDown}
        style={{ left: pos?.left ?? at.x, top: pos?.top ?? at.y, visibility: pos ? 'visible' : 'hidden' }}
        className="fixed z-[91] w-52 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-lift">
        {items.map((it, k) => (
          <button key={k} type="button" role="menuitem" tabIndex={-1} disabled={it.disabled}
            onClick={() => { onClose(true); void it.onSelect(); }}
            className={`block w-full px-3.5 py-2.5 text-start text-xs hover:bg-ink-800 focus:bg-ink-800 focus:outline-none disabled:opacity-40 ${
              it.divider && k > 0 ? 'border-t border-ink-800' : ''} ${it.danger ? 'text-red-300' : 'text-fog-200'}`}>
            {it.label}
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/**
 * A menu for one thing on screen. `getItems` is called when it opens, so it reads the state of that moment;
 * `bind` goes on the element that opens it by right-click, long-press or Shift+F10, and `openFrom` is for its
 * ⋯ button. Spread `bind` only where the menu applies: a Select mode, say, has none.
 */
export function useContextMenu(getItems: () => MenuItem[], { label }: { label: string }) {
  const [at, setAt] = useState<At | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const press = useRef<{ x: number; y: number; timer: ReturnType<typeof setTimeout> } | null>(null);
  // The click a long-press's release would send the card: swallowed, or the menu opens and the card opens too.
  const swallowClick = useRef(false);
  // Read after mount: the static export renders without storage, and the first client render must match it.
  const [on, setOn] = useState(true);
  useEffect(() => { setOn(contextMenusOn()); }, []);

  const close = useCallback((refocus: boolean) => {
    setAt(null);
    if (refocus) trigger.current?.focus?.();
  }, []);
  const openAt = (point: At, el: HTMLElement | null) => { trigger.current = el; setAt(point); };
  /** Under an element, end-aligned: the ⋯ button's place, and the keyboard's. */
  const openFrom = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    openAt({ x: r.right - MENU_W, y: r.bottom + 4 }, el);
  };
  const cancelPress = () => { if (press.current) clearTimeout(press.current.timer); press.current = null; };

  const bind = {
    onContextMenu: (e: MouseEvent<HTMLElement>) => {
      const t = e.target as HTMLElement;
      const sel = window.getSelection();
      const own = wantsOwnMenu({
        shiftKey: e.shiftKey,
        editable: !!t.closest('input, textarea, select, [contenteditable="true"]'),
        selection: sel?.toString() ?? '',
        inSelection: !!sel && !sel.isCollapsed && sel.containsNode(t, true),
      }, contextMenusOn());
      if (!own) return;
      e.preventDefault();
      cancelPress();
      openAt({ x: e.clientX, y: e.clientY }, e.currentTarget);
    },
    // Touch and pen only: a mouse has its right button. Android also sends `contextmenu` on a long-press,
    // which lands on the handler above at the same point; iOS sends nothing, which is why this exists.
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      swallowClick.current = false;
      if (e.pointerType === 'mouse' || !contextMenusOn()) return;
      const { clientX: x, clientY: y } = e;
      const el = e.currentTarget;
      cancelPress();
      press.current = { x, y, timer: setTimeout(() => { press.current = null; swallowClick.current = true; openAt({ x, y }, el); }, LONG_PRESS_MS) };
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const p = press.current;
      if (p && (Math.abs(e.clientX - p.x) > LONG_PRESS_SLOP || Math.abs(e.clientY - p.y) > LONG_PRESS_SLOP)) cancelPress();
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onClickCapture: (e: MouseEvent<HTMLElement>) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if ((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu') { e.preventDefault(); openFrom(e.currentTarget); }
    },
    // iOS draws its own link preview on a long-press; with the menu on, that is what the press is for instead.
    style: (on ? { WebkitTouchCallout: 'none' } : undefined) as CSSProperties | undefined,
  };

  const element = at ? <Menu items={getItems()} at={at} label={label} onClose={close} /> : null;
  return { bind, openFrom, open: !!at, close: () => close(false), element };
}
