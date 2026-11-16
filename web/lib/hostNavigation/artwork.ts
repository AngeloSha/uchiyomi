import type { NavigationAppearance } from './model';

/** Resolve CSS colours to sRGB bytes before crossing a platform boundary. */
export function readNavigationAppearance(): Omit<NavigationAppearance, 'icons' | 'moreLabel'> {
  const style = getComputedStyle(document.documentElement);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Navigation colours unavailable');
  const color = (value: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    return '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(n => n.toString(16).padStart(2, '0')).join('');
  };
  return {
    accent: color(`rgb(${style.getPropertyValue('--accent')})`),
    foreground: color(style.getPropertyValue('--color-fog-50')),
    muted: color(style.getPropertyValue('--color-fog-500')),
    background: color(style.getPropertyValue('--color-ink-850')),
  };
}

export async function rasterizeNavigationIcons(container: HTMLElement): Promise<Record<string, string>> {
  const entries = await Promise.all([...container.querySelectorAll<SVGSVGElement>('svg[data-navigation-icon]')].map(async original => {
    const svg = original.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', '72'); svg.setAttribute('height', '72');
    svg.style.color = '#ffffff';
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Navigation artwork timed out')), 2000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new Error('Navigation artwork unavailable')); };
    });
    image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await loaded;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 72;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Navigation artwork unavailable');
    context.drawImage(image, 0, 0, 72, 72);
    return [original.dataset.navigationIcon!, canvas.toDataURL('image/png').split(',')[1]] as const;
  }));
  return Object.fromEntries(entries);
}
