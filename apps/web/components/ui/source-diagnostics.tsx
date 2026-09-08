'use client';

import type { SetupCheck } from '@/lib/management/diagnostics';
import { workspaceHref } from '@/lib/workspace-context';
import { ArrowUpRight, CheckCircle2, CircleHelp, RefreshCw, TriangleAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

const STATES = {
  blocked: { label: 'Requiere atención', icon: TriangleAlert, color: 'text-amber' },
  unknown: { label: 'Por comprobar', icon: CircleHelp, color: 'text-ink-muted' },
  checked: { label: 'Lectura comprobada', icon: CheckCircle2, color: 'text-emerald' },
};

export function SourceDiagnostics({
  checks,
  workspaceId,
  workspaceName,
}: {
  checks: SetupCheck[];
  workspaceId: string;
  workspaceName: string;
}) {
  const router = useRouter();
  const [refreshing, refresh] = useTransition();
  const [filter, setFilter] = useState<'all' | 'blocked'>('all');
  const blocked = checks.filter((check) => check.state === 'blocked').length;
  const visible = checks.filter((check) => filter === 'all' || check.state === 'blocked');
  const checkedAt = checks[0]?.checkedAt;
  return (
    <section
      aria-labelledby="source-diagnostics-title"
      className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border p-5 sm:p-6">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold text-primary">Diagnóstico de {workspaceName}</p>
          <h2 id="source-diagnostics-title" className="mt-1 text-lg font-semibold">
            Qué puede empezar y qué falta comprobar
          </h2>
          <p className="mt-2 text-sm text-ink-muted">
            Estas lecturas corresponden a este espacio y a las fuentes que puedes consultar.
            Conectar un sistema no demuestra que un proceso completo funcione. Las fuentes
            opcionales dependen de tu misión.
          </p>
        </div>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => refresh(() => router.refresh())}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-border px-3 text-sm font-semibold hover:bg-surface-2 disabled:opacity-50"
        >
          <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Comprobando…' : 'Volver a comprobar'}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 sm:px-6">
        <div className="flex flex-wrap gap-2" aria-label="Filtrar diagnóstico">
          {(
            [
              { value: 'all', label: `Todo · ${checks.length}` },
              { value: 'blocked', label: `Requiere atención · ${blocked}` },
            ] as const
          ).map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
              className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${filter === item.value ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:bg-surface-2'}`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {checkedAt && (
          <time dateTime={checkedAt} className="text-xs text-ink-faint">
            Leído{' '}
            {new Intl.DateTimeFormat('es-CO', {
              dateStyle: 'short',
              timeStyle: 'short',
              timeZone: 'America/Bogota',
            }).format(new Date(checkedAt))}{' '}
            · Bogotá
          </time>
        )}
      </div>
      <div
        aria-live="polite"
        aria-busy={refreshing}
        className="divide-y divide-border px-5 sm:px-6"
      >
        {!visible.length && (
          <p className="py-5 text-sm text-ink-muted">
            {checks.length
              ? 'No se detectaron bloqueos en estas lecturas. Revisa también lo que sigue por comprobar.'
              : 'No hay resultados disponibles. Vuelve a comprobar para reintentar.'}
          </p>
        )}
        {visible.map((check) => {
          const state = STATES[check.state];
          const Icon = state.icon;
          return (
            <article key={check.id} className="grid gap-3 py-5 md:grid-cols-[190px_1fr_auto]">
              <div>
                <h3 className="text-sm font-semibold">{check.label}</h3>
                <p className={`mt-1.5 flex items-center gap-1.5 text-xs ${state.color}`}>
                  <Icon size={14} />
                  {state.label}
                </p>
              </div>
              <div className="min-w-0 text-sm">
                <p className="text-ink-muted">{check.detail}</p>
                <p className="mt-2 text-xs text-ink-faint">Para: {check.affects}</p>
              </div>
              <Link
                href={workspaceHref(workspaceId, check.href)}
                className="inline-flex min-h-10 items-center gap-1 self-start text-sm font-semibold text-primary"
              >
                Revisar <ArrowUpRight size={15} />
              </Link>
            </article>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-primary-soft/30 px-5 py-4 sm:px-6">
        <p className="text-sm text-ink-muted">
          Comprueba el recorrido completo con un proceso real.
        </p>
        <Link
          className="inline-flex min-h-10 items-center gap-2 text-sm font-semibold text-primary"
          href={workspaceHref(workspaceId, '/management/mission')}
        >
          Abrir primera misión <ArrowUpRight size={15} />
        </Link>
      </div>
    </section>
  );
}
