'use client';

import { useState } from 'react';

interface ToolCallCardProps {
  name: string;
  args: unknown;
  result?: unknown;
  state?: 'partial-call' | 'call' | 'result';
}

export function ToolCallCard({ name, args, result, state }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);

  const stateLabel =
    state === 'result' ? '✓' : state === 'partial-call' ? '...' : '⟳';

  return (
    <div className="rounded-md border bg-white/40 dark:bg-neutral-900/40 px-2 py-1 text-xs">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-mono w-full text-left"
      >
        <span className="text-neutral-400">{stateLabel}</span>
        <span>{open ? '▾' : '▸'}</span>
        <span className="text-neutral-700 dark:text-neutral-300">{name}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          <div>
            <div className="text-neutral-500 mb-0.5">Input:</div>
            <pre className="overflow-auto rounded bg-neutral-100 dark:bg-neutral-900 p-1 text-[10px]">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {result !== undefined && (
            <div>
              <div className="text-neutral-500 mb-0.5">Output:</div>
              <pre className="overflow-auto rounded bg-neutral-100 dark:bg-neutral-900 p-1 text-[10px]">
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
