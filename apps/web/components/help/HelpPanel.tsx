'use client';

import { helpPanelAction, searchHelpAction } from '@/app/(app)/ayuda/actions';
import { installRecentErrors } from '@/lib/help/recent-errors';
import {
  type HelpPanelData,
  type PanelArticle,
  askCortexHref,
  defaultQuestion,
} from '@/lib/help/shape';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import {
  ArrowRight,
  BookOpen,
  CircleHelp,
  LifeBuoy,
  Loader2,
  MessageSquare,
  Search,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';

/**
 * LA AYUDA DE ESTA PANTALLA: el botón «?» de la barra de arriba y su panel.
 *
 * El panel le pregunta al servidor qué artículos son de la ruta abierta (el
 * casado por ruta vive en `@cortex/agent-tools`, que no entra en el bundle de
 * cliente) y trae un buscador y «Pregúntale a Cortex», que abre el chat con la
 * pregunta escrita. Se cierra solo al navegar.
 */
export interface HelpLoaders {
  panel: (path: string) => Promise<HelpPanelData>;
  search: (query: string) => Promise<PanelArticle[]>;
}

const SERVER: HelpLoaders = { panel: helpPanelAction, search: searchHelpAction };

export function HelpButton({
  className,
  defaultOpen = false,
  loaders = SERVER,
}: {
  className?: string;
  /** Sólo la vitrina de desarrollo lo abre de entrada. */
  defaultOpen?: boolean;
  /** Las acciones de servidor; la vitrina pasa unas de mentira. */
  loaders?: HelpLoaders;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const path = usePathname();

  useEffect(() => {
    installRecentErrors();
  }, []);

  // Navegar (por un enlace del panel) lo cierra.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: se cierra al cambiar de ruta
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setOpen(false);
  }, [path]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          aria-label="Ayuda de esta pantalla"
          title="Ayuda"
          data-help-trigger
          className={clsx(
            'grid h-10 w-10 shrink-0 place-items-center rounded-full text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            className,
          )}
        >
          <CircleHelp className="h-5 w-5" />
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-ink/30 backdrop-blur-[2px]" />
        <Dialog.Content
          data-help-panel
          className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-2xl outline-none"
        >
          {open && <HelpPanelBody path={path} loaders={loaders} onClose={() => setOpen(false)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function HelpPanelBody({
  path,
  loaders,
  onClose,
}: { path: string; loaders: HelpLoaders; onClose: () => void }) {
  const router = useRouter();
  const [data, setData] = useState<HelpPanelData | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PanelArticle[] | null>(null);
  const [searching, startSearch] = useTransition();
  const [question, setQuestion] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let alive = true;
    loaders
      .panel(path)
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [path, loaders]);

  const onQuery = (value: string) => {
    setQuery(value);
    if (timer.current) clearTimeout(timer.current);
    if (!value.trim()) {
      setResults(null);
      return;
    }
    timer.current = setTimeout(() => {
      startSearch(async () => {
        try {
          setResults(await loaders.search(value));
        } catch {
          setResults([]);
        }
      });
    }, 250);
  };

  const ask = () => {
    const q = question.trim() || query.trim() || defaultQuestion(data?.screen ?? null);
    router.push(askCortexHref(q));
    onClose();
  };

  const list = results ?? data?.articles ?? [];

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <Dialog.Title className="text-lg font-extrabold text-ink">
            {data?.screen ? `Ayuda: ${data.screen}` : 'Ayuda'}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-sm text-ink-muted">
            Cómo se usa esta pantalla, en pocos pasos.
          </Dialog.Description>
        </div>
        <Dialog.Close asChild>
          <button
            type="button"
            aria-label="Cerrar la ayuda"
            className="grid h-9 w-9 place-items-center rounded-full text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-5 w-5" />
          </button>
        </Dialog.Close>
      </div>

      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <label className="relative block">
          <span className="sr-only">Buscar en la ayuda</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
          <input
            type="search"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder="Buscar: extracto, Siigo, WhatsApp…"
            className="h-10 w-full rounded-pill border border-border-strong bg-surface pl-9 pr-9 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          {searching && (
            <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-ink-faint" />
          )}
        </label>

        <h3 className="mb-2 mt-5 text-micro font-bold uppercase tracking-wide text-ink-faint">
          {results ? 'Resultados' : 'En esta pantalla'}
        </h3>
        {!data && !failed && !results && (
          <p className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Buscando la ayuda de esta pantalla…
          </p>
        )}
        {failed && !results && (
          <p className="text-sm text-ink-muted">
            No pude cargar la ayuda. Abre <Link href="/ayuda">el centro de ayuda</Link>.
          </p>
        )}
        {results && results.length === 0 && !searching && (
          <p className="text-sm text-ink-muted">
            No encontré un artículo para «{query}». Pregúntale a Cortex abajo.
          </p>
        )}
        <ul className="space-y-2">
          {list.map((a) => (
            <li key={a.slug}>
              <Link
                href={`/ayuda/${a.slug}`}
                className="group block rounded-card border border-border bg-surface px-4 py-3 transition-colors hover:border-primary/40 hover:bg-surface-2"
              >
                <span className="flex items-center gap-2 text-sm font-bold text-ink">
                  <BookOpen className="h-4 w-4 shrink-0 text-primary" />
                  <span className="min-w-0 flex-1">{a.title}</span>
                  <ArrowRight className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-hover:translate-x-0.5" />
                </span>
                <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                  {a.excerpt ?? a.summary}
                </span>
              </Link>
            </li>
          ))}
        </ul>

        <div className="mt-6 rounded-card bg-primary-soft p-4">
          <p className="flex items-center gap-2 text-sm font-bold text-ink">
            <MessageSquare className="h-4 w-4 text-primary" /> Pregúntale a Cortex
          </p>
          <p className="mt-1 text-xs text-ink-muted">
            Contesta con los pasos y te deja el enlace al artículo.
          </p>
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={2}
            placeholder={defaultQuestion(data?.screen ?? null)}
            className="mt-3 w-full resize-none rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          />
          <button
            type="button"
            onClick={ask}
            className="cortex-primary-button mt-2 inline-flex min-h-10 items-center gap-2 rounded-pill bg-primary px-4 text-sm font-bold text-white hover:bg-primary-strong"
          >
            Preguntar en el chat <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-sm">
        <Link href="/ayuda" className="font-semibold text-primary hover:underline">
          Ver toda la ayuda
        </Link>
        {data?.supportEnabled !== false && (
          <Link
            href={`/ayuda/soporte?desde=${encodeURIComponent(path)}`}
            className="inline-flex items-center gap-1.5 font-semibold text-ink-muted hover:text-ink"
          >
            <LifeBuoy className="h-4 w-4" /> Escribir a soporte
          </Link>
        )}
      </div>
    </>
  );
}
