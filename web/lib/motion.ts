// The app's motion, named once (UI refresh). The cinematic ease is the one the heroes and the page transition have
// always used; the durations are what a hover, a panel and an art crossfade take. Every consumer still asks
// useReduceEffects() and useReducedMotion() first: these are the values for when motion is welcome.
export const EASE = [0.22, 1, 0.36, 1] as const;

export const DURATION = {
  /** A hover, a key press, a label fading in. */
  fast: 0.15,
  /** A panel opening, the sidebar expanding. */
  base: 0.25,
  /** Art crossfading: a hero slide, a mosaic settling. */
  art: 0.9,
} as const;

/** How long the pointer rests on the sidebar before it opens, and how long after it leaves before it closes. */
export const INTENT_MS = { open: 150, close: 120 } as const;
