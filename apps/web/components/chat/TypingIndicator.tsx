'use client';

import { motion } from 'framer-motion';
import { Sparkles } from 'lucide-react';

/**
 * Shown while the assistant is working.
 *
 * `label` matters more than it looks: Claude thinks and calls tools before it
 * writes a single word, and a long lookup (a RUNT check runs for ~18s) left the
 * screen showing three dots with no clue anything was happening — indistinguishable
 * from a hung request. Naming the tool in flight turns dead air into progress.
 */
export function TypingIndicator({ label }: { label?: string }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-gradient-to-br from-primary to-primary-strong text-white">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="flex items-center gap-2 rounded-2xl rounded-tl-md bg-surface px-3.5 py-3 shadow-card ring-1 ring-border">
        <div className="flex items-center gap-1">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="h-1.5 w-1.5 rounded-full bg-primary/50"
              animate={{ scale: [1, 1.4, 1], opacity: [0.4, 1, 0.4] }}
              transition={{ duration: 0.7, repeat: Number.POSITIVE_INFINITY, delay: i * 0.15 }}
            />
          ))}
        </div>
        {label && (
          <motion.span
            key={label}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-[13px] font-medium text-ink-muted"
          >
            {label}
          </motion.span>
        )}
      </div>
    </div>
  );
}
