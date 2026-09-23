'use client';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { useReduceEffects } from '@/lib/effects';

export function PageTransition({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  // Under Reduce effects (#71) the new page is simply there. The tree stays the same shape either way --
  // only the timing changes -- so flipping the switch never remounts the page someone is on.
  const reduced = useReduceEffects();
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div
        key={path}
        initial={reduced ? false : { opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -6 }}
        transition={reduced ? { duration: 0 } : { duration: 0.26, ease: [0.22, 1, 0.36, 1] }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  );
}
