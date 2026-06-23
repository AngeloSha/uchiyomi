export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-brand font-bold tracking-tight ${className}`}>
      yomi<span className="text-accent">.</span>
    </span>
  );
}

// The Yomi logo mark — a kanji-for-"read" monogram (generated with Higgsfield), violet→magenta on the OLED brand.
export function Mark({ size = 40, className = '' }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src="/icons/yomi-mark.svg" width={size} height={size} alt="" aria-hidden className={`shrink-0 ${className}`} />
  );
}

// Mark + wordmark lockup for nav/header bars.
export function Lockup({ className = '', markSize = 24 }: { className?: string; markSize?: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <Mark size={markSize} />
      <Wordmark className={className} />
    </span>
  );
}
