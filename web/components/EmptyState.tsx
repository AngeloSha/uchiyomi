'use client';
import Link from 'next/link';
import { motion } from 'framer-motion';

export function EmptyState({ art, title, sub, cta }: { art: string; title: string; sub: string; cta?: { href: string; label: string } }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="relative mb-5 h-44 w-44 overflow-hidden rounded-[2rem] border border-white/10 shadow-lift"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={art} alt="" className="h-full w-full object-cover" />
        <div className="absolute inset-0" style={{ boxShadow: 'inset 0 0 50px 16px rgb(0 0 0 / 0.55)' }} />
      </motion.div>
      <p className="font-display text-xl font-semibold text-fog-50">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-fog-400">{sub}</p>
      {cta && <Link href={cta.href} className="btn-accent mt-4 text-sm">{cta.label}</Link>}
    </div>
  );
}
