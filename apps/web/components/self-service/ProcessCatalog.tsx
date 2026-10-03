'use client';

import { type ProcessTemplate, templatesFor } from '@/lib/self-service/catalog';
import type { ModuleKey } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  ArrowRight,
  BadgeDollarSign,
  BarChart3,
  Briefcase,
  CalendarClock,
  CalendarDays,
  ClipboardList,
  FileCheck2,
  FileSignature,
  FileText,
  Gavel,
  Handshake,
  Inbox,
  Landmark,
  type LucideIcon,
  MailOpen,
  Package,
  PlaneLanding,
  Receipt,
  Scale,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Truck,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

/**
 * EL CATÁLOGO DE PROCESOS LISTOS.
 *
 * Lo usan /procesos y el paso 3 de los primeros 10 minutos. Cada tarjeta abre
 * el chat con la petición escrita (lib/self-service/catalog.ts): activar un
 * proceso es una conversación en la que Cortex pregunta lo justo, no un
 * formulario que hay que entender antes de empezar.
 *
 * Cada proceso tiene su ícono y cada área su color, para que la lista se lea
 * de un vistazo; un buscador y las áreas (con cuántos hay en cada una) ayudan
 * cuando la lista crece con los módulos prendidos.
 */

type Area = ProcessTemplate['area'];

const AREA_STYLE: Record<Area, { tile: string; dot: string; icon: LucideIcon }> = {
  Plata: { tile: 'bg-emerald-soft text-emerald', dot: 'bg-emerald', icon: BadgeDollarSign },
  'Ventas y clientes': { tile: 'bg-primary-soft text-primary', dot: 'bg-primary', icon: Handshake },
  Operación: { tile: 'bg-amber-soft text-amber', dot: 'bg-amber', icon: Truck },
  Equipo: { tile: 'bg-sky-soft text-sky', dot: 'bg-sky', icon: Users },
  Impuestos: { tile: 'bg-rose-soft text-rose', dot: 'bg-rose', icon: Landmark },
  Legal: { tile: 'bg-surface-2 text-ink-muted', dot: 'bg-ink-faint', icon: Scale },
};

const ICON: Record<string, LucideIcon> = {
  receivables: Receipt,
  shipments: PlaneLanding,
  document_expirations: CalendarClock,
  contract_drafts: FileSignature,
  contract_obligations: FileCheck2,
  compliance_checklist: ShieldCheck,
  pqrs_inbox: Inbox,
  rama_judicial: Gavel,
  pipeline: Handshake,
  quote_to_invoice: FileText,
  inventory: Package,
  service_orders: Briefcase,
  fleet: Truck,
  requests: ClipboardList,
  company_pulse: BarChart3,
  weekly_review: CalendarDays,
  team_follow_up: Users,
  tax_calendar: CalendarDays,
  dian_invoices: Receipt,
  dian_mailbox: MailOpen,
  dian_rut: FileText,
  dian_account: Landmark,
  morning: Sun,
};

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

export function ProcessCatalog({
  modulesOff,
}: {
  /** Módulos que la empresa apagó (0186): sus procesos no se ofrecen. */
  modulesOff?: ModuleKey[];
} = {}) {
  const [area, setArea] = useState<Area | 'Todos'>('Todos');
  const [query, setQuery] = useState('');
  const templates = useMemo(() => templatesFor(modulesOff), [modulesOff]);

  const counts = useMemo(() => {
    const map = new Map<Area, number>();
    for (const t of templates) map.set(t.area, (map.get(t.area) ?? 0) + 1);
    return map;
  }, [templates]);

  const q = fold(query.trim());
  const shown = templates.filter(
    (t) =>
      (area === 'Todos' || t.area === area) &&
      (!q || fold(`${t.title} ${t.body} ${t.needs} ${t.area}`).includes(q)),
  );
  const featured = !q && area === 'Todos' ? shown.filter((t) => t.featured) : [];
  const rest = shown.filter((t) => !featured.includes(t));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2.5 text-ink-faint shadow-card focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15 sm:max-w-sm">
          <Search className="h-4 w-4 shrink-0" aria-hidden />
          <span className="sr-only">Buscar un proceso</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Busca: cobrar, inventario, DIAN, contratos…"
            className="min-w-0 flex-1 border-0 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Borrar la búsqueda"
              className="grid h-5 w-5 place-items-center rounded-full text-ink-faint hover:text-ink"
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </label>
        <div role="tablist" aria-label="Áreas" className="flex flex-wrap gap-2">
          {(['Todos', ...counts.keys()] as Array<Area | 'Todos'>).map((a) => {
            const active = area === a;
            const count = a === 'Todos' ? templates.length : (counts.get(a) ?? 0);
            return (
              <button
                key={a}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setArea(a)}
                className={clsx(
                  'inline-flex items-center gap-1.5 rounded-pill px-3.5 py-1.5 text-xs font-bold transition-colors',
                  active
                    ? 'bg-ink text-surface'
                    : 'border border-border bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {a !== 'Todos' && (
                  <span
                    aria-hidden
                    className={clsx('h-1.5 w-1.5 rounded-full', AREA_STYLE[a].dot)}
                  />
                )}
                {a}
                <span
                  className={clsx('tabular text-micro', active ? 'opacity-70' : 'text-ink-faint')}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {featured.length > 0 && (
        <ul className="grid gap-4 lg:grid-cols-2">
          {featured.map((t) => (
            <ProcessCard key={t.id} template={t} big />
          ))}
        </ul>
      )}

      {rest.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rest.map((t) => (
            <ProcessCard key={t.id} template={t} />
          ))}
        </ul>
      ) : (
        featured.length === 0 && (
          <p className="rounded-card border border-dashed border-border-strong bg-surface px-5 py-6 text-center text-sm text-ink-muted">
            No hay un proceso listo con «{query}». Descríbelo abajo y Cortex lo arma.
          </p>
        )
      )}

      <div className="flex flex-wrap items-center gap-4 rounded-card border-2 border-dashed border-border-strong bg-surface p-5">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
          <Sparkles className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-base font-extrabold text-ink">
            ¿No está el tuyo? Descríbelo y Cortex lo arma.
          </h2>
          <p className="mt-0.5 text-sm text-ink-muted">
            «Cuando llegue un pedido nuevo al correo, ponlo en la tabla y avísale al de turno.»
          </p>
        </div>
        <Link
          href={`/chat?prompt=${encodeURIComponent(
            query.trim()
              ? `Quiero que hagas esto solo, cada vez que pase: ${query.trim()}`
              : 'Quiero que hagas esto solo, cada vez que pase: ',
          )}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-pill bg-ink px-4 py-2.5 text-sm font-bold text-surface hover:opacity-90"
        >
          Describir mi proceso
        </Link>
      </div>
    </div>
  );
}

function ProcessCard({ template: t, big = false }: { template: ProcessTemplate; big?: boolean }) {
  const style = AREA_STYLE[t.area];
  const Icon = ICON[t.id] ?? style.icon;
  return (
    <li
      className={clsx(
        'group flex flex-col gap-3 rounded-card border bg-surface shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:shadow-pop motion-reduce:transform-none',
        big ? 'border-primary/30 p-6' : 'border-border p-5',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={clsx(
            'grid shrink-0 place-items-center rounded-card',
            big ? 'h-12 w-12' : 'h-10 w-10',
            style.tile,
          )}
        >
          <Icon className={big ? 'h-6 w-6' : 'h-5 w-5'} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-micro font-bold uppercase tracking-wider text-ink-faint">
              {t.area}
            </span>
            {t.featured && (
              <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-bold text-amber">
                El más usado
              </span>
            )}
          </div>
          <h3 className={clsx('mt-0.5 font-extrabold text-ink', big ? 'text-lg' : 'text-base')}>
            {t.title}
          </h3>
        </div>
      </div>
      <p className="text-sm leading-relaxed text-ink-muted">{t.body}</p>
      <p className="inline-flex items-start gap-1.5 text-xs text-ink-faint">
        <ClipboardList className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold text-ink-muted">Necesita:</span> {t.needs}
        </span>
      </p>
      <Link
        href={`/chat?prompt=${encodeURIComponent(t.prompt)}`}
        className={clsx(
          'mt-auto inline-flex items-center justify-center gap-1.5 rounded-pill px-4 py-2.5 text-sm font-bold transition-colors',
          t.featured || big
            ? 'cortex-primary-button bg-primary text-white hover:bg-primary-strong'
            : 'border border-border-strong bg-surface text-ink group-hover:border-primary/40 hover:bg-surface-2',
        )}
      >
        Activar en 2 minutos
        <ArrowRight
          className="h-4 w-4 transition-transform group-hover:translate-x-0.5 motion-reduce:transform-none"
          aria-hidden
        />
      </Link>
    </li>
  );
}
