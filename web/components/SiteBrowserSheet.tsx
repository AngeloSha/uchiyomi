'use client';
// Open site (v0.91.0, #314): an extension's site in the extension engine's own browser, live, over the whole screen. The
// admin signs in or passes the site's check with their own clicks and keys, and Done leaves the page -- which is when the
// engine saves the sign-in its extensions send (lib/siteBrowser.ts says how). Opened from Admin → Sources → an extension.
//
// The page is a picture the engine draws at this box's size, five times a second at most; input goes back as the engine's
// page takes it (bff lib/sources/suwayomi/engineBrowser.ts): mouse buttons, moves while pressed, wheel, keys and paste. A
// finger is a tap or a scroll. A phone's own keyboard has no key events worth the name, so typing there arrives as text
// through a hidden field, the way the engine's own page does it.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { closeSite, followSite, openSite, pagePoint, siteSender, SITE_TEXT, type SiteInput, type SiteLine } from '@/lib/siteBrowser';
import { useToast } from '@/components/Toast';
import { msgOf } from '@/components/ConfirmDialog';
import { IcGlobe, IcHome, IcPencil } from '@/components/icons';
import { Busy } from '@/components/ExtensionBits';
import { keys, t as tr } from '@/lib/i18n';
import { useLayer } from '@/lib/layers';

type State = 'opening' | 'open' | 'saving' | 'ended';

/** What ended a page that was not Done, in words. */
const ENDED_TEXT = keys(
  'The page was closed after ten minutes without input. What you did there is kept.',
  'The site was opened somewhere else, so this page closed.',
  'The extension engine closed the page.',
);
const ENDED: Record<Exclude<Extract<SiteLine, { type: 'closed' }>['reason'], 'done'>, string> = {
  idle: ENDED_TEXT[0],
  replaced: ENDED_TEXT[1],
  engine: ENDED_TEXT[2],
};

const hostOf = (u: string): string => { try { return new URL(u).host; } catch { return u; } };

export function SiteBrowserSheet({ sourceId, name, onClose }: { sourceId: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const box = useRef<HTMLDivElement>(null);
  const typer = useRef<HTMLTextAreaElement>(null);
  const session = useRef<string | null>(null);
  const sender = useRef<ReturnType<typeof siteSender> | null>(null);
  const page = useRef({ width: 0, height: 0 });
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [state, setState] = useState<State>('opening');
  const [title, setTitle] = useState(name);
  const [address, setAddress] = useState('');
  const [frame, setFrame] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  // On the stack like every dialog, so a notice is placed clear of its buttons (lib/layers.ts).
  useLayer('dialog', true);

  const send = (i: SiteInput) => sender.current?.send(i);
  const end = (why: string) => {
    sender.current?.stop();
    session.current = null;
    setEnded(why);
    setState('ended');
  };

  // Opened at this box's size; followed until it closes. Leaving the sheet any other way than Done still leaves the page.
  useEffect(() => {
    const ac = new AbortController();
    let gone = false;
    const onLine = (l: SiteLine) => {
      if (l.type === 'frame') setFrame(`data:image/png;base64,${l.png}`);
      else if (l.type === 'address' || l.type === 'load') setAddress(l.url);
      else if (l.type === 'closed' && l.reason !== 'done') end(tr(ENDED[l.reason]));
    };
    void (async () => {
      const r = box.current?.getBoundingClientRect();
      try {
        const o = await openSite(sourceId, r?.width || 1024, r?.height || 700);
        if (gone) { void closeSite(o.session).catch(() => {}); return; }
        session.current = o.session;
        setTitle(o.name);
        setAddress(o.site);
        sender.current = siteSender(o.session, () => end(tr('The page is no longer open.')));
        setState('open');
        await followSite(o.session, onLine, ac.signal);
      } catch (e) {
        if (!gone && !ac.signal.aborted) end(msgOf(e, tr('Could not open the site')));
      }
    })();
    return () => {
      gone = true;
      ac.abort();
      sender.current?.stop();
      if (session.current) void closeSite(session.current).catch(() => {});
      session.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId]);

  // The page follows the box: a phone turned, a window resized.
  useEffect(() => {
    const el = box.current;
    if (!el || state !== 'open') return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        const r = el.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 200) send({ type: 'resize', width: Math.round(r.width), height: Math.round(r.height) });
      }, 200);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
  }, [state]);

  const done = async () => {
    const id = session.current;
    if (!id) { onClose(); return; }
    setState('saving');
    sender.current?.stop();
    session.current = null;
    try {
      const r = await closeSite(id);
      void qc.invalidateQueries({ queryKey: ['admin-sources'] });
      if (r.test?.ok) toast(tr('Saved. {name} answers now.', { name: title }));
      else if (r.test) toast(tr('Saved, but {name} still does not answer. Open the site again to check what it shows.', { name: title }), 'error');
      else toast(tr('Saved.'));
    } catch (e) {
      toast(msgOf(e, tr('Could not save the sign-in')), 'error');
    }
    onClose();
  };

  /** A pointer on the picture, in the page's pixels; null off the picture. */
  const at = (clientX: number, clientY: number) => {
    const el = box.current;
    return el ? pagePoint(clientX, clientY, el.getBoundingClientRect(), page.current) : null;
  };
  const mods = (e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }) =>
    ({ ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey });

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    typer.current?.focus({ preventScroll: true });
    const p = at(e.clientX, e.clientY);
    if (!p) return;
    if (e.pointerType === 'touch') { touch.current = { x: e.clientX, y: e.clientY, moved: false }; return; }
    e.currentTarget.setPointerCapture(e.pointerId);
    send({ type: 'event', eventType: 'mousedown', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, button: e.button, ...mods(e) });
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (e.pointerType === 'touch') {
      if (!t) return;
      const dy = t.y - e.clientY;
      if (Math.abs(dy) < 4 && !t.moved) return;
      t.moved = true;
      const p = at(e.clientX, e.clientY);
      if (p) send({ type: 'event', eventType: 'wheel', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, deltaY: dy });
      t.x = e.clientX;
      t.y = e.clientY;
      return;
    }
    const p = at(e.clientX, e.clientY);
    if (p) send({ type: 'event', eventType: 'mousemove', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, ...mods(e) });
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = at(e.clientX, e.clientY);
    if (e.pointerType === 'touch') {
      const t = touch.current;
      touch.current = null;
      // A tap is a click where it landed; a finger that scrolled clicks nothing.
      if (t && !t.moved && p) {
        send({ type: 'event', eventType: 'mousedown', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, button: 0 });
        send({ type: 'event', eventType: 'mouseup', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, button: 0 });
      }
      return;
    }
    if (p) send({ type: 'event', eventType: 'mouseup', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, button: e.button, ...mods(e) });
  };
  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const p = at(e.clientX, e.clientY);
    if (p) send({ type: 'event', eventType: 'wheel', clickX: p.x, clickY: p.y, clientX: p.x, clientY: p.y, deltaY: e.deltaY, ...mods(e) });
  };
  // Keys go to the page, never to the sheets under this one (Escape included: a page has its own uses for it).
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    // A phone's keyboard: "Unidentified" keys come through as text instead (onInput below).
    if (e.key === 'Unidentified' || e.key === 'Process') return;
    // Paste is the paste event's, which has the text.
    if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    send({ type: 'event', eventType: e.type === 'keydown' ? 'keydown' : 'keyup', clickX: 0, clickY: 0, key: e.key, ...mods(e) });
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="site-sheet-title" data-site-sheet
      className="fixed inset-0 z-[80] flex flex-col bg-ink-950 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center gap-3 border-b border-ink-800 px-[max(1rem,env(safe-area-inset-left))] py-2.5 pe-[max(1rem,env(safe-area-inset-right))]">
        <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><IcGlobe width={18} height={18} /></span>
        <div className="min-w-0 flex-1">
          <h2 id="site-sheet-title" className="truncate font-display text-base font-semibold leading-snug text-fog-50">{title}</h2>
          <p className="truncate text-[12px] text-fog-500" dir="ltr" data-site-address>{hostOf(address) || tr('Opening the site…')}</p>
        </div>
        {state === 'open' && (
          <button type="button" className="btn-key" onClick={() => send({ type: 'home' })} data-site-home>
            <IcHome width={15} height={15} aria-hidden />
            <span className="max-sm:sr-only">{tr('Start over')}</span>
          </button>
        )}
        <button type="button" className="btn-key btn-key-accent" onClick={() => void done()} disabled={state === 'saving'} data-site-done>
          {state === 'saving' ? <Busy tone="muted">{tr('Saving…')}</Busy> : tr('Done')}
        </button>
      </header>

      <div ref={box} className="relative min-h-0 flex-1 touch-none select-none overflow-hidden bg-black"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()} data-site-page>
        {frame && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={frame} alt={tr('The site, live')} draggable={false} data-site-frame
            onLoad={(e) => { page.current = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }; }}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain object-left-top" />
        )}
        {state === 'opening' && (
          <div className="absolute inset-0 grid place-items-center text-sm text-fog-400"><Busy tone="muted">{tr('Opening the site…')}</Busy></div>
        )}
        {state === 'ended' && (
          <div className="absolute inset-0 grid place-items-center bg-ink-950/90 p-6" role="status" data-site-ended>
            <div className="max-w-sm space-y-4 text-center">
              <p className="text-sm leading-relaxed text-fog-200">{ended}</p>
              <button type="button" className="btn-key" onClick={onClose}>{tr('Close')}</button>
            </div>
          </div>
        )}
        {/* Where the keys go: a field off the page's picture that a phone's keyboard can type into. */}
        <textarea ref={typer} aria-label={tr('Type on the site')} autoCapitalize="off" autoCorrect="off" spellCheck={false}
          className="absolute -left-[200vw] top-0 h-px w-px opacity-0"
          onKeyDown={onKey} onKeyUp={onKey}
          onPaste={(e) => { e.preventDefault(); const t = e.clipboardData.getData('text'); if (t) send({ type: 'paste', data: t.slice(0, 4000) }); }}
          onInput={(e) => { const v = e.currentTarget.value; e.currentTarget.value = ''; if (v) send({ type: 'paste', data: v }); }} />
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-ink-800 px-[max(1rem,env(safe-area-inset-left))] py-2.5 pe-[max(1rem,env(safe-area-inset-right))]">
        <p className="text-[12px] leading-relaxed text-fog-400">{tr(SITE_TEXT[2])}</p>
        {/* On a phone there is no keyboard until something asks for one. */}
        <button type="button" className="btn-key sm:hidden" onClick={() => typer.current?.focus()} data-site-keyboard>
          <IcPencil width={14} height={14} aria-hidden />{tr('Keyboard')}
        </button>
      </footer>
    </div>,
    document.body,
  );
}
