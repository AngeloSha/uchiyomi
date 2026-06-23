'use client';
import { createContext, useCallback, useContext, useState, ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

type ToastType = 'info' | 'success' | 'error';
interface Toast { id: number; msg: string; type: ToastType }

const Ctx = createContext<(msg: string, type?: ToastType) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((msg: string, type: ToastType = 'info') => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, msg, type }]);
    setTimeout(() => setItems((s) => s.filter((t) => t.id !== id)), 3200);
  }, []);

  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="safe-top pointer-events-none fixed inset-x-0 top-0 z-[60] flex flex-col items-center gap-2 px-4">
        <AnimatePresence>
          {items.map((t) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: -16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16 }}
              className={`pointer-events-auto rounded-full border px-4 py-2 text-sm shadow-lift backdrop-blur-xl ${
                t.type === 'error'
                  ? 'border-red-500/40 bg-red-950/70 text-red-200'
                  : t.type === 'success'
                    ? 'border-accent/40 bg-ink-900/85 text-accent'
                    : 'border-ink-700 bg-ink-900/85 text-fog-200'
              }`}
            >
              {t.msg}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </Ctx.Provider>
  );
}
