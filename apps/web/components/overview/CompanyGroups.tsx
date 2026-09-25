'use client';

/**
 * Grupos empresariales: ordenar empresas propias, nada más.
 *
 * Un grupo no comparte datos, cerebros, conexiones ni permisos (0140); sólo es
 * el filtro de la consola y una forma de nombrar «las tres empresas de
 * logística». Por eso aquí se puede crear, renombrar, borrar y mover empresas
 * sin confirmaciones pesadas: borrar un grupo no toca ninguna empresa, sólo
 * las devuelve a «sin grupo», y eso se dice en el propio diálogo.
 *
 * Antes este panel se pintaba con hexadecimales a mano (#19171e, zinc-600…)
 * sobre la paleta del tema; ahora usa los tokens y hereda claro y oscuro.
 * Tras cada cambio se refresca la página del servidor además del propio panel,
 * porque los filtros de la consola salen de los mismos grupos.
 */

import { Button } from '@/components/ui/button';
import type { CompanyGroup } from '@/lib/company-groups';
import { clsx } from 'clsx';
import { Building2, Check, FolderKanban, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

const FIELD =
  'min-h-9 min-w-0 rounded-sm border border-border bg-surface px-3 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:opacity-60';

const ICON_BUTTON =
  'grid h-8 w-8 shrink-0 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40';

export function CompanyGroups({
  initialGroups,
  initialAvailable,
}: { initialGroups: CompanyGroup[]; initialAvailable: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [groups, setGroups] = useState(initialGroups);
  const [available, setAvailable] = useState(initialAvailable);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch('/api/company-groups');
    if (!response.ok) throw new Error('No se pudieron actualizar los grupos.');
    const data = (await response.json()) as {
      groups: CompanyGroup[];
      availableCompanies: Array<{ id: string; name: string }>;
    };
    setGroups(data.groups);
    setAvailable(data.availableCompanies);
    router.refresh();
  }

  async function mutate(body: unknown, method: 'POST' | 'PATCH' | 'DELETE') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/company-groups', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'No se pudo guardar.');
      }
      await refresh();
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo guardar.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="company-groups-title"
      className="overflow-hidden rounded-card border border-border bg-surface shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
            <FolderKanban className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <h2 id="company-groups-title" className="text-base font-semibold text-ink">
              Grupos empresariales
            </h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-ink-muted">
              Ordenan tus empresas y filtran la consola. Un grupo no comparte datos, cerebros,
              conexiones ni permisos.
            </p>
          </div>
        </div>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (name.trim() && (await mutate({ name }, 'POST'))) setName('');
          }}
          className="flex w-full gap-2 sm:w-auto"
        >
          <label htmlFor="group-name" className="sr-only">
            Nombre del grupo
          </label>
          <input
            id="group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            placeholder="Nombre del grupo"
            className={clsx(FIELD, 'flex-1 sm:w-52')}
          />
          <Button
            type="submit"
            disabled={busy || !name.trim()}
            className="min-h-9 px-3 py-1.5 text-xs"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-3.5 w-3.5" aria-hidden />
            )}
            Crear grupo
          </Button>
        </form>
      </div>
      {error && (
        <p
          role="alert"
          className="mx-4 mt-4 rounded-sm border border-rose/30 bg-rose-soft px-3 py-2 text-xs text-rose sm:mx-5"
        >
          {error}
        </p>
      )}
      <div className={clsx('grid gap-px bg-border', groups.length > 1 && 'md:grid-cols-2')}>
        {groups.map((group) => (
          <article key={group.id} className="min-w-0 bg-surface p-4 sm:p-5">
            <div className="flex min-h-9 items-center gap-2">
              {editing?.id === group.id ? (
                <form
                  className="flex min-w-0 flex-1 items-center gap-1.5"
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const next = editing.name.trim();
                    if (!next || next === group.name) return setEditing(null);
                    if (await mutate({ groupId: group.id, action: 'rename', name: next }, 'PATCH'))
                      setEditing(null);
                  }}
                >
                  <label htmlFor={`rename-${group.id}`} className="sr-only">
                    Nuevo nombre de {group.name}
                  </label>
                  <input
                    id={`rename-${group.id}`}
                    // biome-ignore lint/a11y/noAutofocus: el campo aparece porque la persona pulsó «Renombrar»; el foco va donde está escribiendo.
                    autoFocus
                    value={editing.name}
                    maxLength={120}
                    onChange={(event) => setEditing({ id: group.id, name: event.target.value })}
                    onKeyDown={(event) => event.key === 'Escape' && setEditing(null)}
                    className={clsx(FIELD, 'flex-1')}
                  />
                  <button
                    type="submit"
                    disabled={busy}
                    aria-label="Guardar nombre"
                    className={ICON_BUTTON}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    aria-label="Cancelar"
                    className={ICON_BUTTON}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </form>
              ) : (
                <>
                  <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
                    {group.name}
                  </h3>
                  <span className="tabular text-micro text-ink-faint">
                    {group.companies.length} {group.companies.length === 1 ? 'empresa' : 'empresas'}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setConfirmDelete(null);
                      setEditing({ id: group.id, name: group.name });
                    }}
                    aria-label={`Renombrar ${group.name}`}
                    className={ICON_BUTTON}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmDelete(confirmDelete === group.id ? null : group.id)}
                    aria-label={`Borrar ${group.name}`}
                    aria-expanded={confirmDelete === group.id}
                    className={clsx(ICON_BUTTON, 'hover:bg-rose-soft hover:text-rose')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
            {confirmDelete === group.id && (
              <div className="mt-3 rounded-sm border border-rose/30 bg-rose-soft px-3 py-2.5 text-xs text-ink-muted">
                <p>
                  Se borra el grupo, no las empresas: vuelven a «sin grupo» con todo lo suyo
                  intacto.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    disabled={busy}
                    className="min-h-8 px-3 py-1 text-xs"
                    onClick={async () => {
                      if (await mutate({ groupId: group.id }, 'DELETE')) setConfirmDelete(null);
                    }}
                  >
                    Borrar grupo
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="min-h-8 px-3 py-1 text-xs"
                    onClick={() => setConfirmDelete(null)}
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            )}
            <ul className="mt-3 space-y-1.5">
              {group.companies.map((company) => (
                <li
                  key={company.id}
                  className="flex items-center gap-2 rounded-sm border border-border bg-surface-2 py-1 pl-3 pr-1"
                >
                  <Building2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{company.name}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        { groupId: group.id, organizationId: company.id, action: 'remove' },
                        'PATCH',
                      )
                    }
                    aria-label={`Quitar ${company.name} de ${group.name}`}
                    className={ICON_BUTTON}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
              {group.companies.length === 0 && (
                <li className="py-1 text-xs text-ink-faint">Todavía no contiene empresas.</li>
              )}
            </ul>
            {available.length > 0 && (
              <select
                aria-label={`Añadir empresa a ${group.name}`}
                value=""
                disabled={busy}
                onChange={(event) =>
                  event.target.value &&
                  void mutate(
                    { groupId: group.id, organizationId: event.target.value, action: 'add' },
                    'PATCH',
                  )
                }
                className={clsx(FIELD, 'mt-3 w-full text-ink-muted')}
              >
                <option value="">Añadir una empresa…</option>
                {available.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            )}
          </article>
        ))}
        {groups.length === 0 && (
          <div className="bg-surface px-4 py-7 sm:px-5 md:col-span-2">
            <p className="text-sm text-ink">Aún no organizas empresas en grupos.</p>
            <p className="mt-1 text-xs text-ink-faint">
              Crea uno cuando dirijas varias empresas que quieras ver juntas.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
