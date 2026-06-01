'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle2, AlertCircle, ChevronDown } from 'lucide-react';
import { clsx } from 'clsx';
import { toolLabel } from '@/lib/tool-labels';
import type { ToolInvocation } from 'ai';

export function ToolCallCard({ invocation }: { invocation: ToolInvocation }) {
  const [open, setOpen] = useState(false);
  const { label } = toolLabel(invocation.toolName);
  const isRunning = invocation.state === 'call' || invocation.state === 'partial-call';
  const result = invocation.state === 'result' ? invocation.result : undefined;
  const isError =
    invocation.state === 'result' &&
    !!result &&
    typeof result === 'object' &&
    '__error' in (result as Record<string, unknown>);

  const tint = isRunning
    ? 'border-amber/30 bg-amber-soft'
    : isError
      ? 'border-rose/30 bg-rose-soft'
      : 'border-emerald/30 bg-emerald-soft';

  return (
    <div className={clsx('overflow-hidden rounded-[12px] border text-xs', tint)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber" />
        ) : isError ? (
          <AlertCircle className="h-3.5 w-3.5 text-rose" />
        ) : (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald" />
        )}
        <span className="flex-1 font-semibold text-ink">{label}</span>
        <ChevronDown className={clsx('h-3.5 w-3.5 text-ink-faint transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            <div className="space-y-1.5 px-3 pb-2.5">
              {invocation.args !== undefined && (
                <pre className="scroll-slim overflow-x-auto rounded-[8px] bg-surface/70 p-2 text-[10px] leading-relaxed text-ink-muted ring-1 ring-border">
                  {JSON.stringify(invocation.args, null, 2)}
                </pre>
              )}
              {invocation.state === 'result' && result !== undefined && (
                <pre className="scroll-slim max-h-56 overflow-auto rounded-[8px] bg-surface/70 p-2 text-[10px] leading-relaxed text-ink-muted ring-1 ring-border">
                  {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
                </pre>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
