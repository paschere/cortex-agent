'use client';

import { createAppAction } from '@/lib/apps/actions';
import { clsx } from 'clsx';
import { LayoutGrid, Pencil, Plus, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/**
 * /apps: LA ESTANTERÍA DE APLICACIONES.
 *
 * Cada tarjeta abre la app corriendo (`/apps/<slug>`); quien administra ve
 * además «Editar» y el bloque de «Nueva aplicación» (plantillas o en blanco).
 * Crear una app es sólo un borrador: nadie más la ve hasta publicarla desde el
 * editor, que es donde se reparten pantallas, roles y miembros.
 */

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  status: 'draft' | 'published';
  screens: number;
}

export interface TemplateSummary {
  id: string;
  name: string;
  icon: string;
  body: string;
}

const PRIMARY =
  'cortex-primary-button inline-flex h-9 items-center justify-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong disabled:opacity-50';
const SECONDARY =
  'inline-flex h-9 items-center justify-center gap-1.5 rounded-pill border border-border bg-surface px-4 text-xs font-semibold text-ink transition-colors hover:border-primary/50 hover:text-primary';

export function AppsLibrary({
  apps,
  canManage,
  templates,
}: {
  apps: AppSummary[];
  canManage: boolean;
  templates: TemplateSummary[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [blankName, setBlankName] = useState('');

  function create(input: { template?: string; name?: string }) {
    setError(null);
    start(async () => {
      const res = await createAppAction(input);
      if (!res.ok) return setError(res.error);
      router.push(`/apps/${res.id}/edit`);
    });
  }

  return (
    <div>
      <header className="mb-6 flex min-w-0 items-start gap-3">
        <span className="page-identity mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-primary">
          <LayoutGrid className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <h1 className="page-heading text-xl font-bold tracking-tight text-ink">Aplicaciones</h1>
          <p className="page-subtitle mt-1.5 max-w-2xl text-pretty text-sm leading-relaxed text-ink-muted">
            Varias pantallas con roles: cada persona ve sólo lo suyo y registra desde el celular. Se
            arman con plantillas o desde cero, y se publican cuando están listas.
          </p>
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-4 rounded-card bg-rose-soft px-3 py-2 text-xs text-rose">
          {error}
        </p>
      )}

      {apps.length === 0 ? (
        <p className="mb-8 rounded-card border border-dashed border-border-strong bg-surface/40 p-8 text-center text-sm text-ink-muted">
          {canManage
            ? 'Todavía no hay aplicaciones. Empieza con una plantilla o en blanco, aquí abajo.'
            : 'Todavía no hay aplicaciones publicadas para ti. Cuando quien administra publique una, aparece aquí.'}
        </p>
      ) : (
        <ul className="mb-10 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {apps.map((a) => (
            <li
              key={a.id}
              className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-primary-soft text-2xl">
                  {a.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-base font-semibold text-ink">{a.name}</h2>
                  <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-ink-muted">
                    {a.description || 'Sin descripción.'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 text-micro">
                <span
                  className={clsx(
                    'rounded-pill px-2 py-0.5 font-semibold',
                    a.status === 'published'
                      ? 'bg-emerald-soft text-emerald'
                      : 'bg-amber-soft text-amber',
                  )}
                >
                  {a.status === 'published' ? 'Publicada' : 'Borrador'}
                </span>
                <span className="text-ink-faint">
                  {a.screens} {a.screens === 1 ? 'pantalla' : 'pantallas'}
                </span>
              </div>
              <div className="mt-auto flex flex-wrap gap-2 pt-1">
                <Link href={`/apps/${a.slug}`} className={PRIMARY}>
                  Abrir
                </Link>
                {canManage && (
                  <Link href={`/apps/${a.id}/edit`} className={SECONDARY}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <section aria-labelledby="nueva-app">
          <h2 id="nueva-app" className="mb-3 text-sm font-semibold text-ink">
            Nueva aplicación
          </h2>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex flex-col gap-3 rounded-card border border-primary/30 bg-gradient-to-br from-primary-soft/60 to-surface p-4"
              >
                <div className="flex items-start gap-3">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-surface text-2xl shadow-card">
                    {t.icon}
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-ink">{t.name}</h3>
                    <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{t.body}</p>
                  </div>
                </div>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => create({ template: t.id })}
                  className={clsx(PRIMARY, 'mt-auto self-start')}
                >
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> Crear desde plantilla
                </button>
              </li>
            ))}
            <li className="flex flex-col gap-3 rounded-card border-2 border-dashed border-border-strong bg-surface/40 p-4">
              <div className="flex items-start gap-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-primary-soft text-primary">
                  <Plus className="h-5 w-5" aria-hidden />
                </span>
                <div>
                  <h3 className="text-sm font-semibold text-ink">En blanco</h3>
                  <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                    Ponle nombre y arma las pantallas, los roles y los miembros tú.
                  </p>
                </div>
              </div>
              <form
                className="mt-auto flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (blankName.trim()) create({ name: blankName.trim() });
                }}
              >
                <label className="min-w-0 flex-1 basis-40">
                  <span className="sr-only">Nombre de la aplicación</span>
                  <input
                    value={blankName}
                    onChange={(e) => setBlankName(e.target.value)}
                    maxLength={80}
                    placeholder="Nombre de la aplicación"
                    className="h-9 w-full rounded-pill border border-border bg-surface px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-primary"
                  />
                </label>
                <button type="submit" disabled={pending || !blankName.trim()} className={PRIMARY}>
                  Crear
                </button>
              </form>
            </li>
          </ul>
        </section>
      )}
    </div>
  );
}
