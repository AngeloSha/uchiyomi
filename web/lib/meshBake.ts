/**
 * On a touch screen, the page colour and the mesh are one opaque picture, drawn once (components/CinematicFX.tsx).
 *
 * `.fx-mesh` in app/globals.css is three radial gradients under `filter: blur(90px) saturate(1.25)` at opacity 0.55, on a
 * layer half again the size of the window in each direction -- more than two windows of translucent pixels, blended over
 * the page on every frame it moves. On a phone's GPU that blending is the cost. Measured on an Android phone (Chrome, a
 * real finger scroll on Home): 41-42 fps with the layer as the rule draws it, 47 with this picture in its place, and the
 * two screenshots of the background a match to within 4 of 255 on any channel. Baking the blur alone, into a layer that
 * stayed large and translucent, saved nothing: what saves is that the layer is the size of the window and opaque.
 *
 * It holds still. A moving layer cost the gain back (43 fps), and the drift is 2-3% over 26 s of a glow that peaks at a
 * few levels above black. Wherever there is a hover pointer the layer is the pinned rule, drift included, and it is the
 * rule too where a canvas cannot filter (`ctx.filter`), and before this runs.
 *
 * Keep MESH in step with the rule: web/test/meshBake.test.ts compares them.
 */

/** The rule's gradients, as fractions of the layer, first on top. */
export const MESH = [
  { rx: 0.38, ry: 0.40, x: 0.18, y: 0.28, rgb: 'accent', alpha: 0.20 },
  { rx: 0.40, ry: 0.48, x: 0.82, y: 0.18, rgb: '34 211 238', alpha: 0.10 },
  { rx: 0.52, ry: 0.52, x: 0.62, y: 0.92, rgb: 'accent', alpha: 0.14 },
] as const;
/** Where each gradient reaches transparent (`transparent 70%`). */
export const MESH_FADE = 0.7;
/** The rule's `filter` and `opacity`, and its size: `inset: -25%`, so 1.5 times the window. */
export const MESH_LOOK = { blur: 90, saturate: 1.25, opacity: 0.55, size: 1.5 };
/** Something this blurred loses nothing drawn at a quarter of the size and scaled up. */
const SCALE = 0.25;

const rgba = (triplet: string, a: number) => `rgba(${triplet.split(/[\s,/]+/).filter(Boolean).slice(0, 3).join(',')},${a})`;

/**
 * The window's part of the mesh over `page` (a CSS colour), opaque, as a data URL -- or null where a canvas cannot
 * filter, in which case the layer stays the CSS rule.
 */
export function bakeBackdrop(width: number, height: number, page: string, accent: string): string | null {
  const lw = Math.ceil(width * MESH_LOOK.size * SCALE), lh = Math.ceil(height * MESH_LOOK.size * SCALE);
  const w = Math.max(1, Math.ceil(width * SCALE)), h = Math.max(1, Math.ceil(height * SCALE));
  const layer = document.createElement('canvas');
  layer.width = lw; layer.height = lh;
  const blurred = document.createElement('canvas');
  blurred.width = lw; blurred.height = lh;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const g = layer.getContext('2d'), b = blurred.getContext('2d'), o = out.getContext('2d');
  if (!g || !b || !o || !('filter' in b)) return null;
  const filter = `blur(${MESH_LOOK.blur * SCALE}px) saturate(${MESH_LOOK.saturate})`;
  b.filter = filter;
  if (b.filter !== filter) return null;
  for (const l of [...MESH].reverse()) {
    const triplet = l.rgb === 'accent' ? accent : l.rgb;
    if (!triplet) continue;
    g.save();
    // An ellipse is a unit circle scaled by its two radii.
    g.translate(l.x * lw, l.y * lh);
    g.scale(l.rx * lw, l.ry * lh);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 1);
    grad.addColorStop(0, rgba(triplet, l.alpha));
    grad.addColorStop(MESH_FADE, rgba(triplet, 0));
    g.fillStyle = grad;
    g.fillRect(-1, -1, 2, 2);
    g.restore();
  }
  b.drawImage(layer, 0, 0);
  o.fillStyle = page;
  o.fillRect(0, 0, w, h);
  o.globalAlpha = MESH_LOOK.opacity;
  // The layer is centred on the window, so the window sees its middle.
  o.drawImage(blurred, -(lw - w) / 2, -(lh - h) / 2);
  return out.toDataURL('image/png');
}

/** What is under the mesh: the body's colour, which the tones change. */
const pageColour = () => getComputedStyle(document.body).backgroundColor;
const accentOf = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();

/**
 * On a touch screen, shows the baked picture on the mesh layer `el`, sized to the window, opaque and still, and keeps it
 * current: drawn again when the accent or the tone changes (Look settings) and when the width changes or the height by
 * more than a sixth (a rotation). The small height changes of a phone's address bar are left to the picture's stretch,
 * which on something this blurred cannot be seen. Returns the cleanup, which hands the layer back to the CSS rule.
 */
export function bakeMesh(el: HTMLElement): () => void {
  const touch = window.matchMedia('(hover: none)');
  let drawn = { w: 0, h: 0, key: '' };
  const restore = () => {
    for (const p of ['inset', 'opacity', 'filter', 'animation', 'background']) el.style.removeProperty(p);
    drawn = { w: 0, h: 0, key: '' };
  };
  const draw = () => {
    if (!touch.matches) { restore(); return; }
    const w = window.innerWidth, h = window.innerHeight, page = pageColour(), accent = accentOf();
    const key = `${page}|${accent}`;
    if (!w || !h) return;
    if (key === drawn.key && w === drawn.w && Math.abs(h - drawn.h) <= drawn.h / 6) return;
    const url = bakeBackdrop(w, h, page, accent);
    if (!url) { restore(); return; }
    drawn = { w, h, key };
    el.style.setProperty('inset', '0');
    el.style.setProperty('opacity', '1');
    el.style.setProperty('filter', 'none');
    el.style.setProperty('animation', 'none');
    el.style.setProperty('background', `url("${url}") 0 0 / 100% 100%`);
  };
  draw();
  let t: ReturnType<typeof setTimeout> | undefined;
  const later = () => { clearTimeout(t); t = setTimeout(draw, 250); };
  window.addEventListener('resize', later);
  touch.addEventListener('change', later);
  const watch = new MutationObserver(later);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-tone'] });
  return () => {
    clearTimeout(t);
    window.removeEventListener('resize', later);
    touch.removeEventListener('change', later);
    watch.disconnect();
    restore();
  };
}
