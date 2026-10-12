'use client';

import { AppRunner } from '@/components/apps/AppRunner';
import { ViewCanvas } from '@/components/views/ViewCanvas';
import { ViewBrandProvider } from '@/components/views/blocks/brand';
import type { RecordNav } from '@/components/views/blocks/record-nav';
import { previewAppDraftAction } from '@/lib/apps/preview-actions';
import type { AppPreview } from '@cortex/agent-tools';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * La app del borrador, corriendo. Habla con el panel del chat por postMessage
 * (sólo del mismo origen):
 *   ← {type:'cortex-preview-set', draft, role, theme, screen?}
 *   → {type:'cortex-preview-ready'} al montar, {type:'cortex-preview-state', roles, screens, screen}
 * Todo es de lectura: las filas son de ejemplo y los botones no escriben.
 */

interface Msg {
  type: 'cortex-preview-set';
  draft?: unknown;
  role?: string | null;
  theme?: 'light' | 'dark';
  screen?: string | null;
  /** Para pruebas y capturas: un borrador ya calculado, sin pasar por el servidor. */
  fixture?: AppPreview;
}

export function PreviewFrame() {
  const [draft, setDraft] = useState<unknown>(null);
  const [role, setRole] = useState<string | null>(null);
  const [screen, setScreen] = useState<string | null>(null);
  const [record, setRecord] = useState<{ screen: string; blockId: string; rowId: string } | null>(
    null,
  );
  const [data, setData] = useState<AppPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const m = e.data as Msg | null;
      if (!m || m.type !== 'cortex-preview-set') return;
      if (m.theme) document.documentElement.dataset.theme = m.theme;
      if (m.fixture) setData(m.fixture);
      if (m.draft !== undefined) {
        setDraft(m.draft);
        setRecord(null);
      }
      if (m.role !== undefined) {
        setRole(m.role);
        setRecord(null);
      }
      if (m.screen !== undefined) setScreen(m.screen);
    };
    window.addEventListener('message', onMessage);
    window.parent?.postMessage({ type: 'cortex-preview-ready' }, window.location.origin);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (draft === null) return;
    const mine = ++seq.current;
    previewAppDraftAction({ draft, roleKey: role, record }).then((res) => {
      if (mine !== seq.current) return;
      if (res.ok) {
        setData(res.preview);
        setError(null);
      } else setError(res.error);
    });
  }, [draft, role, record]);

  const current = useMemo(() => {
    if (!data) return null;
    return (
      data.screens.find((s) => s.slug === screen)?.slug ??
      data.screens.find((s) => s.slug === data.meta.home)?.slug ??
      data.screens[0]?.slug ??
      null
    );
  }, [data, screen]);

  // El panel de afuera necesita saber qué roles y pantallas hay para sus pestañas.
  useEffect(() => {
    if (!data) return;
    window.parent?.postMessage(
      {
        type: 'cortex-preview-state',
        roles: data.meta.roles,
        screens: data.screens,
        screen: current,
        notes: data.notes,
        samples: data.samples,
      },
      window.location.origin,
    );
  }, [data, current]);

  const select = useCallback((slug: string) => {
    setRecord(null);
    setScreen(slug);
  }, []);

  const nav = useMemo<RecordNav>(
    () => ({
      open: (blockId, rowId) => current && setRecord({ screen: current, blockId, rowId }),
      close: () => setRecord(null),
      href: () => '#',
    }),
    [current],
  );

  if (error)
    return (
      <p role="alert" className="p-6 text-sm font-semibold text-rose">
        {error}
      </p>
    );
  if (!data || !current)
    return (
      <p className="p-6 text-sm text-ink-muted">
        {draft === null && !data ? 'Esperando el borrador…' : 'Armando la vista previa…'}
      </p>
    );
  const view = data.views[current];
  const roleMeta =
    data.meta.roles.find((r) => r.key === (role ?? 'administrador')) ?? data.meta.roles[0];
  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <ViewBrandProvider
        brand={{ name: data.meta.app.name, logoUrl: null, primary: null, secondary: null }}
      >
        <div className="mx-auto max-w-5xl px-3 py-3 sm:px-5">
          <AppRunner
            app={{
              id: 'preview',
              slug: 'preview',
              name: data.meta.app.name,
              icon: data.meta.app.icon,
            }}
            screens={data.screens}
            current={current}
            role={{
              key: roleMeta?.key ?? 'administrador',
              name: roleMeta?.name ?? 'Administrador',
            }}
            readOnly={false}
            canExport={false}
            canManage={false}
            title={data.screens.find((s) => s.slug === current)?.title ?? ''}
            basePath="/__preview"
            preview={{ onSelect: select }}
            screenContent={
              view ? (
                <ViewCanvas view={view} target={{ kind: 'demo' }} nav={nav} />
              ) : (
                <p className="p-6 text-sm text-ink-muted">
                  Esta pantalla no tiene datos de ejemplo.
                </p>
              )
            }
          />
        </div>
      </ViewBrandProvider>
    </div>
  );
}
