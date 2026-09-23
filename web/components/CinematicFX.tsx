'use client';
import { useReduceEffects } from '@/lib/effects';

// Global cinematic finish: animated accent mesh (behind), film grain + vignette (above).
//
// ⚠️ This is the look, and it is the default on purpose (#71). The fix for a slow machine is the Reduce
// effects switch -- under it these three layers are not rendered at all, and html.reduce-effects hides them
// too for the one frame a stale store could leave them in -- never a cheaper version of the layers
// themselves. web/test/effects.test.ts pins this markup and the three CSS rules behind it.
export function CinematicFX() {
  const reduced = useReduceEffects();
  if (reduced) return null;
  return (
    <>
      <div className="fx-mesh" />
      <div className="fx-grain" />
      <div className="fx-vignette" />
    </>
  );
}
