'use client';

import { type EditorSource, type PaletteType, sourceRefusal } from '@/lib/views/editor-spec';
import { clsx } from 'clsx';
import {
  Calendar,
  ChevronRight,
  CircleDollarSign,
  Database,
  Hash,
  Inbox,
  List,
  Lock,
  Plus,
  Search,
  Sparkles,
  Type,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { blockIcon, blockLabel } from '../editor/block-meta';

/**
 * «DATOS»: DE DÓNDE PUEDE SACAR UNA VISTA SUS FILAS.
 *
 * El mismo catálogo que los menús del inspector (/api/views/catalog), en tres
 * estantes con el nombre que la gente les da: las tablas de la empresa, los
 * datos que Cortex ya lleva (ventas, pagos, clientes…) y el Feed propio. Cada
 * fuente se abre para ver sus campos —con un icono por tipo, porque «Valor»
 * puede ser plata o un número— y trae botones para agregar una pieza sobre
 * ella: un clic en la fuente agrega su tabla, que es lo que casi siempre se
 * quiere primero; los botones chicos, una cifra, un gráfico o un tablero.
 *
 * Las piezas que una fuente no admite (un formulario sobre ventas, que son de
 * sólo lectura; un tablero sin un campo de opciones) salen apagadas con el
 * motivo de `sourceRefusal`, el mismo que usa el inspector.
 *
 * CUÁNTAS FILAS: las tablas de la empresa traen su conteo; las de la
 * plataforma no (contarlas cuesta una lectura por fuente), y dicen «en vivo».
 */

export type CatalogSource = EditorSource & { rowCount?: number | null };

const KIND_SHELF: Array<{ kind: EditorSource['kind']; title: string; empty: string }> = [
  {
    kind: 'tracker',
    title: 'Tablas de tu empresa',
    empty: 'Todavía no hay tablas. Pídele a Cortex una vista y él propone crearlas.',
  },
  { kind: 'platform', title: 'Datos de Cortex', empty: '' },
  { kind: 'feed', title: 'Tu Feed', empty: '' },
];

const FIELD_ICON: Record<string, typeof Type> = {
  text: Type,
  number: Hash,
  money: CircleDollarSign,
  date: Calendar,
  select: List,
};

const QUICK: PaletteType[] = ['metric', 'chart', 'board', 'form'];

const fmt = new Intl.NumberFormat('es-CO');

export function DataPanel({
  sources,
  loading,
  error,
  used,
  canAdd,
  onAdd,
}: {
  sources: CatalogSource[];
  loading: boolean;
  error: string | null;
  /** Las fuentes que la vista ya usa. */
  used: Set<string>;
  canAdd: boolean;
  onAdd: (type: PaletteType, source: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const shelves = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (s: CatalogSource) =>
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.fields.some((f) => f.label.toLowerCase().includes(q));
    return KIND_SHELF.map((shelf) => ({
      ...shelf,
      items: sources.filter((s) => s.kind === shelf.kind && match(s)),
    }));
  }, [sources, query]);

  if (error) return <p className="rounded-sm bg-rose-soft px-3 py-2 text-xs text-rose">{error}</p>;

  return (
    <div className="space-y-4">
      <label className="relative block">
        <span className="sr-only">Buscar una tabla o un campo</span>
        <Search
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint"
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar tabla o campo…"
          className="w-full rounded-pill border border-border bg-surface-2/60 py-1.5 pl-8 pr-3 text-xs text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-primary"
        />
      </label>

      {loading && (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 animate-pulse rounded-sm bg-surface-2" />
          ))}
        </div>
      )}

      {!loading &&
        shelves.map((shelf) =>
          !shelf.items.length && (!shelf.empty || query) ? null : (
            <section key={shelf.kind}>
              <h3 className="field-label mb-2 flex items-center gap-1.5">
                {shelf.kind === 'tracker' ? (
                  <Database className="h-3 w-3" aria-hidden />
                ) : shelf.kind === 'platform' ? (
                  <Sparkles className="h-3 w-3" aria-hidden />
                ) : (
                  <Inbox className="h-3 w-3" aria-hidden />
                )}
                {shelf.title}
                <span className="tabular font-mono text-ink-faint">{shelf.items.length}</span>
              </h3>
              {!shelf.items.length ? (
                <p className="rounded-sm border border-dashed border-border px-3 py-2.5 text-micro leading-relaxed text-ink-muted">
                  {shelf.empty}
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {shelf.items.map((s) => {
                    const expanded = open === s.slug;
                    const inUse = used.has(s.slug);
                    return (
                      <li
                        key={s.slug}
                        className={clsx(
                          'rounded-sm border bg-surface transition-colors duration-150',
                          expanded ? 'border-border-strong shadow-card' : 'border-border',
                        )}
                      >
                        <div className="flex items-center gap-1 p-1">
                          <button
                            type="button"
                            aria-expanded={expanded}
                            onClick={() => setOpen(expanded ? null : s.slug)}
                            disabled={s.opaque}
                            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
                          >
                            <ChevronRight
                              className={clsx(
                                'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
                                expanded && 'rotate-90',
                              )}
                              aria-hidden
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-xs font-semibold text-ink">
                                  {s.name}
                                </span>
                                {s.readOnly && (
                                  <Lock
                                    className="h-3 w-3 shrink-0 text-ink-faint"
                                    aria-label="Sólo lectura"
                                  />
                                )}
                              </span>
                              <span className="flex items-center gap-1.5 text-micro text-ink-faint">
                                <span className="tabular font-mono">
                                  {typeof s.rowCount === 'number'
                                    ? `${fmt.format(s.rowCount)} ${s.rowCount === 1 ? 'fila' : 'filas'}`
                                    : 'en vivo'}
                                </span>
                                <span aria-hidden>·</span>
                                <span>
                                  {s.fields.length} {s.fields.length === 1 ? 'campo' : 'campos'}
                                </span>
                                {inUse && (
                                  <span className="rounded-pill bg-primary-soft px-1.5 font-semibold text-primary">
                                    En uso
                                  </span>
                                )}
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            disabled={!canAdd || s.opaque}
                            onClick={() => onAdd('table', s.slug)}
                            aria-label={`Agregar una tabla de ${s.name}`}
                            title="Agregar su tabla al lienzo"
                            className="grid h-7 w-7 shrink-0 place-items-center rounded-pill text-ink-muted transition-colors hover:bg-primary-soft hover:text-primary disabled:opacity-35"
                          >
                            <Plus className="h-4 w-4" />
                          </button>
                        </div>
                        {expanded && (
                          <div className="border-t border-border px-2.5 pb-2.5 pt-2">
                            {s.description && (
                              <p className="mb-2 line-clamp-3 text-micro leading-relaxed text-ink-muted">
                                {s.description}
                              </p>
                            )}
                            <ul className="mb-2.5 space-y-0.5">
                              {s.fields.map((f) => {
                                const FieldIcon = FIELD_ICON[f.type] ?? Type;
                                return (
                                  <li
                                    key={f.key}
                                    className="flex items-center gap-1.5 text-micro text-ink-muted"
                                  >
                                    <FieldIcon
                                      className="h-3 w-3 shrink-0 text-ink-faint"
                                      aria-hidden
                                    />
                                    <span className="truncate text-ink">{f.label}</span>
                                    {f.type === 'select' && f.options?.length ? (
                                      <span className="ml-auto truncate text-ink-faint">
                                        {f.options.slice(0, 3).join(' · ')}
                                      </span>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ul>
                            <div className="flex flex-wrap gap-1">
                              {QUICK.map((type) => {
                                const Icon = blockIcon(type);
                                const why = sourceRefusal(type, s);
                                return (
                                  <button
                                    key={type}
                                    type="button"
                                    disabled={!canAdd || Boolean(why)}
                                    title={why ?? `Agregar ${blockLabel(type).toLowerCase()}`}
                                    onClick={() => onAdd(type, s.slug)}
                                    className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-2/60 px-2 py-0.5 text-micro font-semibold text-ink-muted transition-colors hover:border-primary/50 hover:text-primary disabled:opacity-40"
                                  >
                                    <Icon className="h-3 w-3" aria-hidden />
                                    {blockLabel(type)}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ),
        )}
      {!loading && query && shelves.every((s) => !s.items.length) && (
        <p className="px-1 py-6 text-center text-xs text-ink-muted">
          Ninguna tabla ni campo se llama así.
        </p>
      )}
    </div>
  );
}
