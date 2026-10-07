'use client';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';

export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  // Under Reduce effects (#71) the new page is simply there.  A zero-duration exit is not equivalent to
  // having no exit while AnimatePresence is in `wait` mode: Framer can retain the old keyed page without
  // ever admitting the new one after a client-side navigation (#174).  Keep the same wrapper, but mount the
  // incoming page synchronously and give the outgoing page no exit target at all.
  const reduced = useReduceEffects();
  return (
    <AnimatePresence mode={reduced ? 'sync' : 'wait'} initial={false}>
      <motion.div
        key={path}
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={reduced ? undefined : { opacity: 0, y: -6 }}
        transition={reduced ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
