'use client';

import type { ViewBrand } from '@/lib/branding/shape';
import { archiveViewAction, duplicateViewAction, setViewPinnedAction } from '@/lib/views/actions';
import { startersFor } from '@/lib/views/starter-templates';
import type { ModuleKey } from '@cortex/agent-tools';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import {
  Archive,
  ArrowDownUp,
  Copy,
  ExternalLink,
  Globe,
  LayoutPanelTop,
  Lock,
  MoreHorizontal,
  PencilRuler,
  Pin,
  PinOff,
  Plus,
  Search,
  Share2,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { type StudioLaunch, ViewStudio } from '../ViewStudio';
import { ViewThumbnail } from '../ViewThumbnail';
import { BrandScope, ViewBrandProvider } from '../blocks/brand';
import '../views.css';
import { ShareDialog, type ToolbarView } from '../ViewToolbar';
import { NewViewDialog, TemplateCard, launchFor } from './NewViewDialog';

/**
 * /views: LA ESTANTERÍA DE PANTALLAS DE LA EMPRESA.
 *
 * Arriba, lo que se busca: un buscador, filtros por lo que a la gente le
 * importa de una vista (las fijadas en Inicio, las que salen de Cortex por
 * enlace, las mías) y el orden. Abajo, tarjetas grandes con la miniatura de
 * cada vista —su forma, con el acento que le pusieron— y quién la tocó por
 * última vez. Cada tarjeta tiene un menú con lo que se hace sin abrirla:
 * editar, duplicar, fijar, compartir y archivar, por las mismas acciones de
 * servidor que la barra de la vista (las mismas reglas de quién puede).
 *
 * «Nueva vista» abre la galería (`NewViewDialog`) y de ahí el estudio en
 * pantalla completa, aquí mismo: una vista nueva no tiene dirección hasta que
 * se guarda. Con `?nueva=1` la galería abre sola.
 *
 * Sin ninguna vista todavía, la estantería vacía ya muestra las plantillas:
 * una pantalla vacía es una invitación a actuar.
 */

export interface ViewSummary {
  id: string;
  slug: string;
  name: string;
  description: string;
  blocks: Array<{ type: string; width: string }>;
  accent: string;
  kinds: string[];
  pinned: boolean;
  visibility: 'workspace' | 'link' | 'password';
  /** Tiene enlace y el enlace venció. */
  expired: boolean;
  mine: boolean;
  updatedAt: string;
  createdAt: string;
  /** «hace 2 h», calculado en el servidor para que no cambie al hidratar. */
  edited: string;
  editor: string | null;
  share: ToolbarView;
}

type Filter = 'all' | 'pinned' | 'shared' | 'mine';
type Sort = 'recent' | 'name' | 'created';

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'pinned', label: 'Fijadas' },
  { id: 'shared', label: 'Compartidas' },
  { id: 'mine', label: 'Mías' },
];

const SORT_LABEL: Record<Sort, string> = {
  recent: 'Editadas hace poco',
  name: 'Nombre (A–Z)',
  created: 'Creadas hace poco',
};

const DOOR = {
  workspace: { icon: Users, label: 'Equipo', tone: 'bg-surface-2 text-ink-muted' },
  link: { icon: Globe, label: 'Enlace', tone: 'bg-sky-soft text-sky' },
  password: { icon: Lock, label: 'Contraseña', tone: 'bg-amber-soft text-amber' },
} as const;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');

const MENU_ITEM =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs text-ink outline-none transition-colors data-[disabled]:cursor-not-allowed data-[highlighted]:bg-surface-2 data-[disabled]:opacity-40';

export function ViewsLibrary({
  views,
  suggestions,
  brand = null,
  modulesOff = [],
}: {
  views: ViewSummary[];
  suggestions: string[];
  /** Los módulos apagados de la empresa: sus plantillas no se ofrecen. */
  modulesOff?: ModuleKey[];
  /**
   * La marca de la empresa (0170): las miniaturas con el acento de siempre
   * («primary») se tiñen con su color, y el estudio que se abre desde aquí la
   * hereda. Sin marca, el índigo de Cortex.
   */
  brand?: ViewBrand | null;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('recent');
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [launch, setLaunch] = useState<StudioLaunch | null>(null);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    if (params.get('nueva') === '1') setGalleryOpen(true);
  }, [params]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(id);
  }, [notice]);

  const counts: Record<Filter, number> = {
    all: views.length,
    pinned: views.filter((v) => v.pinned).length,
    shared: views.filter((v) => v.visibility !== 'workspace').length,
    mine: views.filter((v) => v.mine).length,
  };

  const shown = useMemo(() => {
    const q = fold(query.trim());
    const list = views.filter((v) => {
      if (filter === 'pinned' && !v.pinned) return false;
      if (filter === 'shared' && v.visibility === 'workspace') return false;
      if (filter === 'mine' && !v.mine) return false;
      return !q || fold(`${v.name} ${v.description} ${v.kinds.join(' ')}`).includes(q);
    });
    return [...list].sort((a, b) =>
      sort === 'name'
        ? a.name.localeCompare(b.name, 'es')
        : sort === 'created'
          ? b.createdAt.localeCompare(a.createdAt)
          : Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt),
    );
  }, [views, query, filter, sort]);

  const sharing = views.find((v) => v.id === shareFor) ?? null;

  function openLaunch(next: StudioLaunch) {
    setGalleryOpen(false);
    setLaunch(next);
  }

  function run(task: () => Promise<{ ok: boolean; error?: string }>, ok?: string) {
    start(async () => {
      const res = await task();
      if (!res.ok) setNotice({ tone: 'error', text: res.error ?? 'No se pudo.' });
      else {
        if (ok) setNotice({ tone: 'ok', text: ok });
        router.refresh();
      }
    });
  }

  return (
    <ViewBrandProvider brand={brand}>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="page-identity mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-primary">
            <LayoutPanelTop className="h-5 w-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="page-heading text-xl font-bold tracking-tight text-ink">Vistas</h1>
            <p className="page-subtitle mt-1.5 max-w-2xl text-pretty text-sm leading-relaxed text-ink-muted">
              Pantallas a la medida sobre los datos de tu empresa: tableros, portales y formularios.
              Se piden escribiendo o se arman a mano en el estudio; se fijan en Inicio o se
              comparten por enlace.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setGalleryOpen(true)}
          className="cortex-primary-button inline-flex h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-semibold text-white shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong"
        >
          <Plus className="h-4 w-4" aria-hidden /> Nueva vista
        </button>
      </header>

      {views.length === 0 ? (
        <EmptyShelf
          onGallery={() => setGalleryOpen(true)}
          onLaunch={openLaunch}
          modulesOff={modulesOff}
        />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1 basis-56 sm:max-w-xs">
              <span className="sr-only">Buscar vistas</span>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nombre o tipo de bloque…"
                className="h-9 w-full rounded-pill border border-border bg-surface pl-9 pr-3 text-sm text-ink shadow-card outline-none transition-colors placeholder:text-ink-faint focus:border-primary"
              />
            </label>
            <fieldset className="flex max-w-full gap-1 overflow-x-auto rounded-pill bg-surface-2 p-0.5 [scrollbar-width:none]">
              <legend className="sr-only">Mostrar</legend>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={clsx(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-pill px-3 py-1.5 text-xs font-semibold transition-colors duration-150',
                    filter === f.id
                      ? 'bg-surface text-ink shadow-card'
                      : 'text-ink-muted hover:text-ink',
                  )}
                >
                  {f.label}
                  <span className="tabular font-mono text-micro text-ink-faint">
                    {counts[f.id]}
                  </span>
                </button>
              ))}
            </fieldset>
            <label className="ml-auto inline-flex items-center gap-1.5 text-xs text-ink-muted">
              <ArrowDownUp className="h-3.5 w-3.5" aria-hidden />
              <span className="sr-only">Ordenar</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="h-8 rounded-pill border border-border bg-surface px-2.5 text-xs font-semibold text-ink outline-none focus:border-primary"
              >
                {(Object.keys(SORT_LABEL) as Sort[]).map((s) => (
                  <option key={s} value={s}>
                    {SORT_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {/* En el teléfono ya está el botón de arriba: la tarjeta sería media pantalla vacía. */}
            <li className="hidden sm:block">
              <button
                type="button"
                onClick={() => setGalleryOpen(true)}
                className="group flex h-full min-h-[18rem] w-full flex-col items-center justify-center gap-3 rounded-card border-2 border-dashed border-border-strong bg-surface/40 p-6 text-center transition-all duration-150 hover:border-primary/60 hover:bg-primary-soft/20 motion-reduce:transition-none"
              >
                <span className="grid h-12 w-12 place-items-center rounded-pill bg-primary-soft text-primary transition-transform duration-150 group-hover:scale-105 motion-reduce:transition-none">
                  <Plus className="h-6 w-6" aria-hidden />
                </span>
                <span className="text-base font-semibold text-ink group-hover:text-primary">
                  Nueva vista
                </span>
                <span className="max-w-[18rem] text-xs leading-relaxed text-ink-muted">
                  Descríbela a Cortex, parte de una de {startersFor(modulesOff).length} plantillas o
                  ármala a mano en el estudio.
                </span>
              </button>
            </li>
            {shown.map((v) => (
              <ViewCard
                key={v.id}
                view={v}
                pending={pending}
                onPin={() =>
                  run(
                    () => setViewPinnedAction(v.id, !v.pinned),
                    v.pinned
                      ? `«${v.name}» ya no está en Inicio.`
                      : `«${v.name}» quedó fijada en Inicio.`,
                  )
                }
                onDuplicate={() =>
                  run(async () => duplicateViewAction(v.id), `Se creó «${v.name} (copia)».`)
                }
                onShare={() => setShareFor(v.id)}
                onArchive={() => {
                  if (
                    !window.confirm(
                      `¿Archivar «${v.name}»? Desaparece de la lista y su enlace deja de abrir. Los datos no se tocan.`,
                    )
                  )
                    return;
                  run(() => archiveViewAction(v.id), `«${v.name}» quedó archivada.`);
                }}
              />
            ))}
          </ul>

          {shown.length === 0 && (
            <div className="mt-4 flex flex-col items-center gap-2 rounded-card border border-dashed border-border px-6 py-10 text-center">
              <p className="text-sm font-semibold text-ink">Ninguna vista coincide</p>
              <p className="text-xs text-ink-muted">Prueba con otra palabra o quita el filtro.</p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setFilter('all');
                }}
                className="mt-1 inline-flex items-center gap-1 rounded-pill px-3 py-1.5 text-xs font-semibold text-primary hover:bg-primary-soft"
              >
                <X className="h-3.5 w-3.5" aria-hidden /> Quitar filtros
              </button>
            </div>
          )}
        </>
      )}

      <NewViewDialog
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        suggestions={suggestions}
        onLaunch={openLaunch}
        modulesOff={modulesOff}
      />
      {sharing && (
        <ShareDialog
          view={sharing.share}
          trigger={null}
          open
          onOpenChange={(open) => {
            if (!open) setShareFor(null);
          }}
        />
      )}
      {launch && <ViewStudio launch={launch} onExit={() => setLaunch(null)} />}

      {notice && (
        <output
          className={clsx(
            'fixed bottom-6 left-1/2 z-50 flex w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-card border bg-surface px-4 py-3 text-sm shadow-pop',
            notice.tone === 'error' ? 'border-rose/40 text-rose' : 'border-border text-ink',
          )}
        >
          <p className="min-w-0 flex-1">{notice.text}</p>
          <button
            type="button"
            aria-label="Cerrar aviso"
            onClick={() => setNotice(null)}
            className="shrink-0 text-ink-faint hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </output>
      )}
    </ViewBrandProvider>
  );
}

function ViewCard({
  view: v,
  pending,
  onPin,
  onDuplicate,
  onShare,
  onArchive,
}: {
  view: ViewSummary;
  pending: boolean;
  onPin: () => void;
  onDuplicate: () => void;
  onShare: () => void;
  onArchive: () => void;
}) {
  const door = DOOR[v.visibility];
  return (
    <li className="group relative">
      <Link
        href={`/views/${v.slug}`}
        className="flex h-full flex-col overflow-hidden rounded-card border border-border bg-surface shadow-card transition-all duration-150 hover:-translate-y-0.5 hover:border-border-strong hover:shadow-pop motion-reduce:transition-none motion-reduce:hover:translate-y-0"
      >
        <BrandScope className="border-b border-border bg-canvas/50 p-2.5">
          <ViewThumbnail blocks={v.blocks} accent={v.accent} size="lg" />
        </BrandScope>
        <div className="flex flex-1 flex-col p-4">
          <div className="flex items-start gap-2 pr-6">
            <span className="min-w-0 flex-1 text-base font-semibold text-ink group-hover:text-primary">
              {v.name}
            </span>
            {v.pinned && (
              <Pin
                className="mt-1 h-3.5 w-3.5 shrink-0 text-primary"
                aria-label="Fijada en Inicio"
              />
            )}
          </div>
          {v.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-ink-muted">
              {v.description}
            </p>
          )}
          <p className="mt-2 text-micro text-ink-faint">{v.kinds.join(' · ')}</p>
          <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1.5 pt-3">
            <span
              className={clsx(
                'inline-flex items-center gap-1 rounded-pill px-2 py-0.5 text-micro font-semibold',
                v.expired ? 'bg-rose-soft text-rose' : door.tone,
              )}
            >
              <door.icon className="h-3 w-3" aria-hidden />
              {v.expired ? 'Enlace vencido' : door.label}
            </span>
            <span className="min-w-0 truncate text-micro text-ink-faint">
              Editada {v.edited}
              {v.editor ? ` por ${v.editor}` : ''}
            </span>
          </div>
        </div>
      </Link>

      <DropdownMenu.Root>
        <DropdownMenu.Trigger
          aria-label={`Más acciones para «${v.name}»`}
          className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-pill border border-border-strong bg-surface/95 text-ink-muted shadow-card backdrop-blur transition-all duration-150 hover:text-ink focus-visible:opacity-100 data-[state=open]:opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
        >
          <MoreHorizontal className="h-4 w-4" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-[12rem] rounded-card border border-border bg-surface p-1 shadow-pop"
          >
            <DropdownMenu.Item asChild className={MENU_ITEM}>
              <Link href={`/views/${v.slug}`}>
                <ExternalLink className="h-3.5 w-3.5 text-ink-faint" aria-hidden /> Abrir
              </Link>
            </DropdownMenu.Item>
            <DropdownMenu.Item asChild className={MENU_ITEM}>
              <Link href={`/views/${v.slug}?editar=1`}>
                <PencilRuler className="h-3.5 w-3.5 text-ink-faint" aria-hidden /> Editar en el
                estudio
              </Link>
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} disabled={pending} onSelect={onDuplicate}>
              <Copy className="h-3.5 w-3.5 text-ink-faint" aria-hidden /> Duplicar
            </DropdownMenu.Item>
            <DropdownMenu.Separator className="my-1 h-px bg-border" />
            <DropdownMenu.Item className={MENU_ITEM} disabled={pending} onSelect={onPin}>
              {v.pinned ? (
                <PinOff className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
              ) : (
                <Pin className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
              )}
              {v.pinned ? 'Quitar de Inicio' : 'Fijar en Inicio'}
            </DropdownMenu.Item>
            <DropdownMenu.Item className={MENU_ITEM} onSelect={onShare}>
              <Share2 className="h-3.5 w-3.5 text-ink-faint" aria-hidden /> Compartir…
            </DropdownMenu.Item>
            {v.share.canManage && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  className={clsx(
                    MENU_ITEM,
                    'data-[highlighted]:bg-rose-soft data-[highlighted]:text-rose',
                  )}
                  disabled={pending}
                  onSelect={onArchive}
                >
                  <Archive className="h-3.5 w-3.5" aria-hidden /> Archivar
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}

function EmptyShelf({
  onGallery,
  onLaunch,
  modulesOff,
}: {
  onGallery: () => void;
  onLaunch: (launch: StudioLaunch) => void;
  modulesOff: ModuleKey[];
}) {
  return (
    <section className="rounded-card border border-border bg-surface/60 p-5 shadow-card sm:p-8">
      <div className="max-w-2xl">
        <p className="flex items-center gap-1.5 text-micro font-semibold text-primary">
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Tu primera vista
        </p>
        <h2 className="mt-1 text-lg font-semibold text-ink">
          Una pantalla con lo que tu equipo necesita ver, sin pedírsela a nadie
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-ink-muted">
          Empieza con una plantilla —abre con tus datos y la ajustas en el estudio— o describe la
          pantalla y Cortex la arma.
        </p>
      </div>
      <ul className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {startersFor(modulesOff)
          .slice(0, 4)
          .map((t) => (
            <li key={t.id}>
              <TemplateCard template={t} compact onPick={() => onLaunch(launchFor(t))} />
            </li>
          ))}
      </ul>
      <button
        type="button"
        onClick={onGallery}
        className="mt-5 inline-flex items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink shadow-card transition-all duration-150 hover:-translate-y-px hover:bg-surface-2"
      >
        Ver todas las plantillas, describirla o empezar en blanco
      </button>
    </section>
  );
}
