'use client';

/**
 * The app's on/off toggle.
 *
 * It exists because there were three hand-rolled copies of it and all three positioned the knob with
 * `left-*`. The track mirrors under `dir="rtl"` and a physical `left` does not, so in Arabic every one of
 * them drew "off" exactly where a reader looks for "on" -- a toggle that lies about its own state. The knob
 * is placed with `start-*` here, and there is one copy so a fourth cannot drift.
 */
export function Switch({ on, onChange, disabled, label }: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-7 w-12 shrink-0 rounded-full transition disabled:opacity-40 ${on ? 'bg-accent' : 'bg-ink-600'}`}
    >
      <span aria-hidden className={`absolute top-0.5 h-6 w-6 rounded-full bg-white transition-all ${on ? 'start-[22px]' : 'start-0.5'}`} />
    </button>
  );
}
