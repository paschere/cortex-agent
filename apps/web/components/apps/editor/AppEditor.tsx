'use client';

import { archiveAppAction, updateAppAction } from '@/lib/apps/actions';
import { clsx } from 'clsx';
import { ChevronLeft, ExternalLink } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { MembersTab } from './MembersTab';
import { PreviewTab } from './PreviewTab';
import { RolesTab } from './RolesTab';
import { ScreensTab } from './ScreensTab';
import { UsersTab } from './UsersTab';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  ErrorLine,
  INPUT,
} from './shared';

export type { AppEditorData } from './shared';

/**
 * EL EDITOR DE UNA APLICACIÓN: cinco pestañas y una cabecera.
 *
 * La cabecera es la app misma (nombre, descripción, icono, publicar,
 * archivar). Las pestañas siguen el orden en que se arma una app: primero las
 * pantallas, luego quién ve y hace qué en cada una (roles), luego las personas del equipo (miembros) y las de afuera (usuarios: operarios, clientes
 * que entran con un código por correo) y al final «Ver como…», que abre la app corriendo con los datos reales y con
 * los ojos de un rol para comprobar que nadie ve de más.
 *
 * Todo cambio es una acción de servidor con su resultado a la vista (errores
 * en la misma pantalla, nada de alertas) y `router.refresh()` para traer lo
 * que quedó guardado. Publicar puede ser rechazado —por ejemplo si una
 * pantalla lee una fuente interna—; el texto del rechazo se muestra tal cual.
 */

type Tab = 'screens' | 'roles' | 'members' | 'users' | 'preview';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'screens', label: 'Pantallas' },
  { id: 'roles', label: 'Roles y permisos' },
  { id: 'members', label: 'Miembros' },
  { id: 'users', label: 'Usuarios' },
  { id: 'preview', label: 'Ver como…' },
];

export function AppEditor({ data }: { data: AppEditorData }) {
  const { app } = data;
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('screens');
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [icon, setIcon] = useState(app.icon);
  const dirty = name !== app.name || description !== app.description || icon !== app.icon;

  function run(task: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      if (after) after();
      else router.refresh();
    });
  }

  return (
    <div className="space-y-5">
      <Link
        href="/apps"
        className="inline-flex items-center gap-1 text-xs font-semibold text-ink-faint transition-colors hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Aplicaciones
      </Link>

      <section className={clsx(CARD, 'space-y-3')}>
        <div className="flex flex-wrap items-start gap-3">
          <label className="shrink-0">
            <span className="sr-only">Icono (un emoji)</span>
            <input
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              maxLength={8}
              className="h-12 w-12 rounded-lg border border-border bg-primary-soft text-center text-2xl outline-none focus:border-primary"
            />
          </label>
          <div className="min-w-0 flex-1 basis-64 space-y-2">
            <label className="block">
              <span className="sr-only">Nombre</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={80}
                className={clsx(INPUT, 'w-full text-base font-semibold')}
              />
            </label>
            <label className="block">
              <span className="sr-only">Descripción</span>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder="Para qué sirve esta aplicación y quién la usa"
                className="w-full resize-y rounded-lg border border-border bg-surface px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={clsx(
                'rounded-pill px-2.5 py-1 text-micro font-semibold',
                app.status === 'published'
                  ? 'bg-emerald-soft text-emerald'
                  : 'bg-amber-soft text-amber',
              )}
            >
              {app.status === 'published' ? 'Publicada' : 'Borrador'}
            </span>
            {dirty && (
              <button
                type="button"
                disabled={pending || !name.trim()}
                onClick={() => run(() => updateAppAction(app.id, { name, description, icon }))}
                className={BTN_PRIMARY}
              >
                Guardar cambios
              </button>
            )}
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  updateAppAction(app.id, {
                    status: app.status === 'published' ? 'draft' : 'published',
                  }),
                )
              }
              className={BTN_SECONDARY}
            >
              {app.status === 'published' ? 'Despublicar' : 'Publicar'}
            </button>
            <Link href={`/apps/${app.slug}`} className={BTN_SECONDARY}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Abrir la app
            </Link>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (
                  window.confirm(
                    `¿Archivar «${app.name}»? Sus pantallas se archivan; los datos de las tablas no se tocan.`,
                  )
                )
                  run(
                    () => archiveAppAction(app.id),
                    () => router.push('/apps'),
                  );
              }}
              className={BTN_DANGER}
            >
              Archivar
            </button>
          </div>
        </div>
        <ErrorLine error={error} />
      </section>

      <div role="tablist" className="flex gap-1 overflow-x-auto rounded-pill bg-surface-2 p-0.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              'shrink-0 rounded-pill px-3.5 py-1.5 text-xs font-semibold transition-colors',
              tab === t.id ? 'bg-surface text-ink shadow-card' : 'text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'screens' && <ScreensTab data={data} />}
      {tab === 'roles' && <RolesTab data={data} />}
      {tab === 'members' && <MembersTab data={data} />}
      {tab === 'users' && <UsersTab data={data} />}
      {tab === 'preview' && <PreviewTab data={data} />}
    </div>
  );
}
