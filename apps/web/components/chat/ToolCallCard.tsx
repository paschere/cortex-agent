'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Loader2, CheckCircle2, AlertCircle, ChevronDown } from 'lucide-react';
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

  return (
    <div
      className={`rounded-lg border text-xs overflow-hidden ${
        isRunning
          ? 'border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30'
          : isError
            ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30'
            : 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30'
      }`}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 w-full px-3 py-2 text-left"
      >
        {isRunning ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin text-amber-600" />
        ) : isError ? (
          <AlertCircle className="w-3.5 h-3.5 text-red-600" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />
        )}
        <span className="flex-1 font-medium">{label}</span>
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: 'auto' }}
            exit={{ height: 0 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-2 space-y-1">
              {invocation.args !== undefined && (
                <pre className="text-[10px] bg-white/50 dark:bg-black/20 rounded p-1.5 overflow-x-auto">
                  {JSON.stringify(invocation.args, null, 2)}
                </pre>
              )}
              {invocation.state === 'result' && result !== undefined && (
                <pre className="text-[10px] bg-white/50 dark:bg-black/20 rounded p-1.5 overflow-x-auto">
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
