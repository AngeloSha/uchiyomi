'use client';
import { useEffect, useRef, useState } from 'react';
import { PAD_IDLE, padActions, type PadMap, type PadState } from './readerPad';
import type { ReaderAction } from './readerKeys';

/**
 * Whether this page may use a controller at all: the Gamepad API is offered to a secure page only -- https, or this
 * computer itself -- so on a plain-http address on the home network it is simply not there.
 */
export function gamepadsAvailable(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === true && typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function';
}

/** The first connected controller, or null. */
export function firstPad(): Gamepad | null {
  if (!gamepadsAvailable()) return null;
  try {
    for (const p of navigator.getGamepads()) if (p && p.connected !== false) return p;
  } catch { /* a browser that refuses: no controller */ }
  return null;
}

/** A pad's buttons as down / up. A trigger counts as down past halfway. */
export function buttonsOf(p: Gamepad): boolean[] {
  return Array.from(p.buttons, (b) => b.pressed || b.value > 0.5);
}

/**
 * Turn a connected controller's presses into reader actions (v0.61.0, lib/readerPad.ts). Polls once a frame, and only
 * while a controller is connected and the tab is visible: with none plugged in, nothing runs at all -- plugging one in
 * is the opt-in. `paused` stops it while the sheet is capturing a button. Returns whether a controller is connected.
 */
export function useGamepad(onAction: (a: ReaderAction) => void, map: PadMap, paused = false): boolean {
  const [connected, setConnected] = useState(false);
  const act = useRef(onAction);
  act.current = onAction;
  const mapRef = useRef(map);
  mapRef.current = map;
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    if (!gamepadsAvailable()) return;
    let raf = 0;
    let prev: boolean[] = [];
    let state: PadState = PAD_IDLE;
    const tick = () => {
      raf = 0;
      const p = firstPad();
      setConnected(!!p);
      if (!p || document.visibilityState !== 'visible') { prev = []; state = PAD_IDLE; return; }
      const now = buttonsOf(p);
      if (pausedRef.current) {
        prev = now;
        state = { ...PAD_IDLE, axes: [...p.axes] };
      } else {
        const r = padActions(prev, now, [...p.axes], mapRef.current, performance.now(), state);
        prev = now;
        state = r.state;
        for (const a of r.actions) act.current(a);
      }
      raf = requestAnimationFrame(tick);
    };
    const start = () => { if (!raf && firstPad() && document.visibilityState === 'visible') raf = requestAnimationFrame(tick); };
    const gone = () => { if (!firstPad()) setConnected(false); };
    window.addEventListener('gamepadconnected', start);
    window.addEventListener('gamepaddisconnected', gone);
    document.addEventListener('visibilitychange', start);
    start();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('gamepadconnected', start);
      window.removeEventListener('gamepaddisconnected', gone);
      document.removeEventListener('visibilitychange', start);
    };
  }, []);
  return connected;
}
