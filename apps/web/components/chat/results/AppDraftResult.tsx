'use client';

import { AppPreviewPanel } from '@/components/apps/AppPreviewPanel';
import { clsx } from 'clsx';
import { AlertTriangle, LayoutGrid } from 'lucide-react';
import { useChatArtifacts } from '../ChatArtifacts';
import { useChatCompose } from '../ChatCompose';
import type { ResultViewProps } from './registry';

/**
 * EL BORRADOR DE UNA APP (`apps.design`).
 *
 * En la conversación: qué se va a crear (tablas, pantallas, roles), lo que no
 * cuadra y lo que conviene saber. Al abrirlo al lado: «Vista previa de la app»
 * —la app corriendo con filas de ejemplo— y los dos gestos que siguen: pedir
 * cambios (se escribe en el chat y el borrador se rehace) o crearla de una vez
 * (una sola aprobación para tablas, roles y pantallas).
 */

interface Draft {
  name?: string;
  icon?: string;
  description?: string;
  roles?: Array<{ key: string; name: string }>;
  screens?: Array<{ title: string }>;
  tables?: Array<{ slug: string; name: string }>;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export function AppDraftResult({ result, toolCallId }: ResultViewProps) {
  const r = asRecord(result);
  const draft = (r.draft ?? null) as Draft | null;
  const problems = Array.isArray(r.problems) ? (r.problems as string[]) : [];
  const warnings = Array.isArray(r.warnings) ? (r.warnings as string[]) : [];
  const api = useChatArtifacts();
  const compose = useChatCompose();
  const inPanel = api?.current?.id === toolCallId;

  return (
    <div className="space-y-3 rounded-card border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary-soft text-lg"
          aria-hidden
        >
          {draft?.icon ?? <LayoutGrid className="h-5 w-5 text-primary" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-extrabold tracking-tight text-ink">
            {draft?.name ?? 'Borrador de aplicación'}
          </p>
          <p className="text-xs text-ink-muted">
            Borrador: nada se ha creado.
            {draft &&
              ` ${draft.tables?.length ? `${draft.tables.length} tablas · ` : ''}${draft.screens?.length ?? 0} pantallas · ${draft.roles?.length ?? 0} roles`}
          </p>
        </div>
      </div>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded-card border border-rose/30 bg-rose-soft p-3 text-xs text-ink">
          {problems.map((p) => (
            <li key={p} className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-rose" aria-hidden />
              {p}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-xs text-ink-muted">
          {warnings.slice(0, 5).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      {draft && inPanel && (
        <>
          <AppPreviewPanel draft={draft} />
          {compose && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => compose.ask('Crea la aplicación tal como está en la vista previa.')}
                disabled={problems.length > 0}
                className={clsx(
                  'view-press inline-flex min-h-9 items-center rounded-pill bg-primary px-4 text-xs font-semibold text-white shadow-card hover:bg-primary-strong disabled:opacity-50',
                )}
              >
                Crear la app
              </button>
              <button
                type="button"
                onClick={() => compose.compose('Cambia la aplicación: ')}
                className="view-press inline-flex min-h-9 items-center rounded-pill border border-border px-4 text-xs font-semibold text-ink-muted hover:text-ink"
              >
                Pedir cambios
              </button>
            </div>
          )}
        </>
      )}
      {draft && !inPanel && api && (
        <p className="text-xs text-ink-muted">
          Ábrela al lado para verla funcionando, cambiar de rol y de pantalla, y crearla con una
          sola aprobación.
        </p>
      )}
    </div>
  );
}
