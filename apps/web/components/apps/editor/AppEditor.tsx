'use client';

import { Glyph } from '@/components/apps/AppGlyph';
import { DeleteDialog } from '@/components/ui/DeleteDialog';
import { archiveAppAction, deleteAppAction, updateAppAction } from '@/lib/apps/actions';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { Archive, ChevronLeft, ExternalLink, Loader2, MoreHorizontal, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { AppearanceTab } from './AppearanceTab';
import { AutomationsTab } from './AutomationsTab';
import { HomeTab } from './HomeTab';
import { IconPicker } from './IconPicker';
import { MembersTab } from './MembersTab';
import { PreviewTab } from './PreviewTab';
import { RolesTab } from './RolesTab';
import { ScreensTab } from './ScreensTab';
import { UsersTab } from './UsersTab';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  ErrorLine,
  MENU_CONTENT,
  MenuItem,
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

type Tab = 'screens' | 'look' | 'home' | 'roles' | 'members' | 'users' | 'automations' | 'preview';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'screens', label: 'Pantallas' },
  { id: 'home', label: 'Inicio' },
  { id: 'look', label: 'Apariencia' },
  { id: 'roles', label: 'Roles y permisos' },
  { id: 'members', label: 'Miembros' },
  { id: 'users', label: 'Usuarios' },
  { id: 'automations', label: 'Automatizaciones' },
  { id: 'preview', label: 'Ver como…' },
];

/** Un campo de texto que crece con lo que tiene: el nombre largo se parte en dos líneas en vez de cortarse. */
function autosize(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

export function AppEditor({ data }: { data: AppEditorData }) {
  const { app } = data;
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('screens');
  const [deleting, setDeleting] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(app.name);
  const [description, setDescription] = useState(app.description);
  const [icon, setIcon] = useState(app.icon);

  function run(task: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      if (after) after();
      else router.refresh();
    });
  }

  function save(patch: { name?: string; description?: string; icon?: string }) {
    const next = { name, description, icon, ...patch };
    if (!next.name.trim()) return setName(app.name);
    if (next.name === app.name && next.description === app.description && next.icon === app.icon)
      return;
    run(() => updateAppAction(app.id, next));
  }

  const counts: Partial<Record<Tab, number>> = {
    screens: data.screens.length,
    roles: data.roles.length,
    members: data.members.length,
    users: data.appUsers.length,
  };
  const published = app.status === 'published';

  return (
    <div className="space-y-5">
      <Link
        href="/apps"
        className="inline-flex items-center gap-1 text-xs font-semibold text-ink-faint transition-colors hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" aria-hidden /> Aplicaciones
      </Link>

      <section className="space-y-3">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
          <IconPicker
            value={icon}
            emoji
            label="Cambiar el icono de la app"
            onChange={(next) => {
              setIcon(next);
              save({ icon: next });
            }}
          >
            <span className="grid h-14 w-14 shrink-0 place-items-center rounded-card border border-border bg-primary-soft text-primary-ink shadow-card transition-transform hover:scale-105">
              <Glyph name={icon} className="h-7 w-7 text-2xl" />
            </span>
          </IconPicker>

          <div className="min-w-0 flex-1 basis-60">
            <label className="block">
              <span className="sr-only">Nombre de la aplicación</span>
              <textarea
                ref={autosize}
                rows={1}
                value={name}
                onChange={(e) => {
                  setName(e.target.value.replace(/\n/g, ' '));
                  autosize(e.currentTarget);
                }}
                onBlur={() => save({})}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    e.currentTarget.blur();
                  }
                  if (e.key === 'Escape') {
                    setName(app.name);
                    e.currentTarget.blur();
                  }
                }}
                maxLength={80}
                placeholder="Nombre de la aplicación"
                className="block w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-0.5 -mx-2 text-xl font-semibold leading-snug text-ink outline-none transition-colors placeholder:text-ink-faint hover:bg-surface-2 focus:border-primary focus:bg-surface"
              />
            </label>
            <label className="mt-0.5 block">
              <span className="sr-only">Descripción</span>
              <textarea
                value={description}
                ref={autosize}
                onChange={(e) => {
                  setDescription(e.target.value);
                  autosize(e.currentTarget);
                }}
                onBlur={() => save({})}
                maxLength={500}
                rows={1}
                placeholder="Agrega una descripción: para qué sirve y quién la usa"
                className="block w-full resize-none overflow-hidden rounded-lg border border-transparent bg-transparent px-2 py-0.5 -mx-2 text-sm text-ink-muted outline-none transition-colors placeholder:text-ink-faint hover:bg-surface-2 focus:border-primary focus:bg-surface"
              />
            </label>
            <div className="mt-1.5 flex items-center gap-2">
              <span
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-semibold',
                  published ? 'bg-emerald-soft text-emerald' : 'bg-amber-soft text-amber',
                )}
              >
                <span
                  className={clsx(
                    'h-1.5 w-1.5 rounded-full',
                    published ? 'bg-emerald' : 'bg-amber',
                  )}
                  aria-hidden
                />
                {published ? 'Publicada' : 'Borrador'}
              </span>
              {pending && (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint" aria-hidden />
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                run(() =>
                  updateAppAction(app.id, {
                    status: published ? 'draft' : 'published',
                  }),
                )
              }
              className={BTN_SECONDARY}
            >
              {published ? 'Despublicar' : 'Publicar'}
            </button>
            <Link href={`/apps/${app.slug}`} className={BTN_PRIMARY}>
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Abrir la app
            </Link>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  aria-label="Más acciones"
                  className="grid h-8 w-8 place-items-center rounded-pill border border-border bg-surface text-ink-muted transition-colors hover:text-ink data-[state=open]:text-ink"
                >
                  <MoreHorizontal className="h-4 w-4" aria-hidden />
                </button>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className={MENU_CONTENT}>
                  <MenuItem
                    tone="rose"
                    disabled={pending}
                    onSelect={() => {
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
                  >
                    <Archive className="h-3.5 w-3.5" aria-hidden /> Archivar la app
                  </MenuItem>
                  <MenuItem tone="rose" disabled={pending} onSelect={() => setDeleting(true)}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Eliminar la app…
                  </MenuItem>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
        <ErrorLine error={error} />
        <DeleteDialog
          open={deleting}
          onOpenChange={setDeleting}
          title="¿Eliminar esta aplicación?"
          name={app.name}
          confirmLabel="Eliminar la aplicación"
          consequences={[
            'Se borran para siempre sus pantallas, roles, miembros, usuarios externos, kioscos, automatizaciones y avisos. No se puede deshacer.',
            'Su enlace y la app instalada en los teléfonos dejan de funcionar.',
            'Los datos de las tablas no se tocan.',
          ]}
          onConfirm={async () => {
            const res = await deleteAppAction(app.id);
            if (!res.ok) return res.error;
            router.push('/apps');
            router.refresh();
            return null;
          }}
        />
      </section>

      <div className="sticky top-0 z-20 -mx-1 bg-canvas/90 px-1 backdrop-blur">
        <div
          role="tablist"
          className="flex gap-1 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {TABS.map((t) => {
            const active = tab === t.id;
            const count = counts[t.id];
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setTab(t.id)}
                className={clsx(
                  '-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors',
                  active
                    ? 'border-primary text-ink'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {t.label}
                {count !== undefined && count > 0 && (
                  <span
                    className={clsx(
                      'rounded-pill px-1.5 text-micro font-semibold',
                      active ? 'bg-primary-soft text-primary-ink' : 'bg-surface-2 text-ink-faint',
                    )}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {tab === 'screens' && <ScreensTab data={data} />}
      {tab === 'home' && <HomeTab data={data} />}
      {tab === 'look' && <AppearanceTab data={data} />}
      {tab === 'roles' && <RolesTab data={data} />}
      {tab === 'members' && <MembersTab data={data} />}
      {tab === 'users' && <UsersTab data={data} />}
      {tab === 'automations' && <AutomationsTab data={data} />}
      {tab === 'preview' && <PreviewTab data={data} />}
    </div>
  );
}
