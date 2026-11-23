'use client';
import { useEffect, useRef } from 'react';
import { useReduceEffects } from '@/lib/effects';
import { bakeMesh } from '@/lib/meshBake';

// Global cinematic finish: animated accent mesh (behind), film grain + vignette (above).
//
// ⚠️ This is the look, and it is the default on purpose (#71). The fix for a slow machine is the Reduce
// effects switch -- under it these three layers are not rendered at all, and html.reduce-effects hides them
// too for the one frame a stale store could leave them in -- never a cheaper version of the layers
// themselves. web/test/effects.test.ts pins this markup and the three CSS rules behind it.
//
// On a touch screen the mesh is drawn once into an opaque picture of the same pixels (lib/meshBake.ts): the same look,
// without blending a layer twice the window's size on every frame of a scroll.
export function CinematicFX() {
  const reduced = useReduceEffects();
  const mesh = useRef<HTMLDivElement>(null);
  useEffect(() => (reduced || !mesh.current ? undefined : bakeMesh(mesh.current)), [reduced]);
  if (reduced) return null;
  return (
    <>
      <div ref={mesh} className="fx-mesh" />
      <div className="fx-grain" />
      <div className="fx-vignette" />
    </>
  );
}
