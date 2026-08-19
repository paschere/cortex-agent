'use client';

import { Brain } from 'lucide-react';
import type { ResultViewProps } from './registry';

/**
 * UNA LÍNEA: LO QUE DIJO YA QUEDÓ GUARDADO.
 *
 * `cortex.remember` escribe en el acto, sin aprobación, porque la persona
 * acaba de decirlo. Lo que faltaba era verlo en el turno: sin esta vista el
 * resultado era un JSON plegado y la instrucción parecía no haber entrado.
 */

const KIND_LINE: Record<string, string> = {
  instruction: 'Guardado como instrucción tuya.',
  preference: 'Guardado como preferencia tuya.',
  vocabulary: 'Guardado como vocabulario tuyo.',
  fact: 'Guardado como un hecho tuyo.',
};

export function Remembered({ result }: ResultViewProps) {
  const view = rememberedOf(result);
  if (!view) return null;

  return (
    <div className="flex items-start gap-2 rounded-card border border-border bg-surface px-4 py-3 text-sm leading-relaxed text-ink shadow-card">
      <Brain className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0">
        <p className="font-medium text-ink">{view.line}</p>
        <p className="mt-0.5 text-ink-muted">{view.remembered}</p>
        {view.evicted.length > 0 && (
          <p className="mt-1 text-xs text-amber">
            Para hacerle sitio, dejó de cargar: {view.evicted.join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}

function rememberedOf(result: unknown): {
  line: string;
  remembered: string;
  evicted: string[];
} | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const r = result as Record<string, unknown>;
  if (typeof r.remembered !== 'string' || !r.remembered.trim()) return null;
  const kind = typeof r.kind === 'string' ? r.kind : 'fact';
  const evicted = Array.isArray(r.evicted)
    ? r.evicted.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  return {
    line: KIND_LINE[kind] ?? 'Guardado como un hecho tuyo.',
    remembered: r.remembered.trim(),
    evicted,
  };
}
