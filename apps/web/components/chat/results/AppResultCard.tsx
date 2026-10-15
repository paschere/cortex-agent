'use client';

import { Glyph } from '@/components/apps/AppGlyph';
import { type AppRef, appRefOfSummary, appRefsFromList, statusLabel } from '@/lib/chat-app-panel';
import { clsx } from 'clsx';
import { Eye, PanelRightOpen, Pencil } from 'lucide-react';
import { useChatArtifacts } from '../ChatArtifacts';
import type { ResultViewProps } from './registry';

/**
 * UNA APP EN LA CONVERSACIÓN (`apps.create`, `apps.update`, `apps.apply_draft`,
 * `apps.publish`, `apps.get`, `apps.list`).
 *
 * Una tarjeta corta —nombre, estado, pantallas— y la puerta a abrirla al lado:
 * «Abrir al lado» (la fila que añade `ArtifactFrame`) o, en la lista, un botón
 * por app para elegir una. Lo que se hace con la app (verla, editarla,
 * publicarla) vive en el panel; aquí no se repite.
 */

function field(v: unknown, key: string): unknown {
  return v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
}

function screensOf(app: unknown): string[] {
  const list = field(app, 'screens');
  return Array.isArray(list)
    ? list.flatMap((s) =>
        typeof field(s, 'title') === 'string' ? [field(s, 'title') as string] : [],
      )
    : [];
}

function StatusChip({ app }: { app: AppRef }) {
  return (
    <span
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-2 py-0.5 text-micro font-semibold',
        app.status === 'published' ? 'bg-emerald-soft text-emerald' : 'bg-amber-soft text-amber',
      )}
    >
      {statusLabel(app.status, app.version)}
    </span>
  );
}

export function AppResultCard({ result }: ResultViewProps) {
  const api = useChatArtifacts();
  const app = appRefOfSummary(
    field(result, 'app'),
    'read',
    Number(field(result, 'version')) || null,
  );
  if (!app) return null;
  const screens = screensOf(field(result, 'app'));
  const changes = field(result, 'changes');
  const list = Array.isArray(changes)
    ? (changes as unknown[]).filter((c) => typeof c === 'string')
    : [];
  const draft = app.status !== 'published';
  const open = !!api?.panelOpen && api.tab === 'app' && api.app?.id === app.id;
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-3 rounded-[14px] border border-border bg-well p-3.5">
      <div className="flex min-w-[15rem] flex-1 items-center gap-3.5">
        <span
          aria-hidden
          className="grid h-[52px] w-[52px] shrink-0 place-items-center rounded-[13px] bg-primary-soft text-lg text-primary-ink"
        >
          <Glyph name={app.icon} className="h-[22px] w-[22px] text-lg" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="min-w-0 truncate text-sm font-bold tracking-tight text-ink">{app.name}</p>
          <p className="mt-0.5 text-micro text-ink-muted">
            <span className={clsx('font-semibold', draft ? 'text-amber' : 'text-emerald')}>
              {statusLabel(app.status, app.version)}
            </span>
            {screens.length > 0
              ? ` · ${screens.length} ${screens.length === 1 ? 'pantalla' : 'pantallas'}: ${screens
                  .slice(0, 4)
                  .join(', ')}${screens.length > 4 ? '…' : ''}`
              : ' · App de la empresa'}
            {draft ? ' · nadie la ve hasta publicar' : ''}
          </p>
          {list.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-micro text-ink-muted">
              {(list as string[]).slice(0, 4).map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {api && (
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => (open ? api.close() : api.openApp(app, 'vista'))}
            aria-pressed={open}
            className="inline-flex h-[34px] items-center gap-1.5 rounded-pill border border-border bg-transparent px-3.5 text-micro font-semibold text-ink transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
          >
            <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
            {open ? 'Abierta al lado' : 'Abrir al lado'}
          </button>
          {draft && (
            <button
              type="button"
              onClick={() => api.openApp(app, 'vista')}
              title="Se abre al lado para que la revises y la publiques desde ahí"
              className="inline-flex h-[34px] items-center rounded-pill bg-primary px-4 text-micro font-semibold text-white transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
            >
              Publicar
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AppListResult({ result }: ResultViewProps) {
  const api = useChatArtifacts();
  const apps = appRefsFromList(result);
  const raw = field(result, 'apps');
  return (
    <ul className="divide-y divide-border rounded-card border border-border bg-surface shadow-card">
      {apps.map((app, i) => {
        const screens = screensOf(Array.isArray(raw) ? raw[i] : null);
        const open = api?.panelOpen && api.tab === 'app' && api.app?.id === app.id;
        return (
          <li key={app.id} className="flex items-center gap-3 px-3.5 py-3">
            <span
              aria-hidden
              className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary-ink"
            >
              <Glyph name={app.icon} className="h-4 w-4 text-base" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="min-w-0 truncate text-sm font-semibold text-ink">{app.name}</p>
                <StatusChip app={app} />
              </div>
              {screens.length > 0 && (
                <p className="truncate text-xs text-ink-muted">{screens.join(', ')}</p>
              )}
            </div>
            {api && (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => api.openApp(app, 'vista')}
                  aria-pressed={open}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
                >
                  <Eye className="h-3.5 w-3.5" aria-hidden />
                  Abrir al lado
                </button>
                <button
                  type="button"
                  onClick={() => api.openApp(app, 'editar')}
                  className="inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Editar
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
