'use client';

import { type CatalogGroup, type CatalogItem, promptFor } from '@/lib/sources/catalog';
import { workspaceHref } from '@/lib/workspace-context';
import { clsx } from 'clsx';
import { ArrowRight, ChevronDown } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { CATALOG_ICON, SourceTile } from './visuals';

/**
 * «CONECTA ALGO NUEVO»: el catálogo agrupado por lo que la gente quiere traer.
 *
 * Cada tarjeta lleva a su flujo: el permiso del proveedor, una ruta de la app,
 * o —para una carpeta de Drive o una hoja— un campo para pegar el enlace que
 * abre el chat con la petición escrita. `slots` deja que la página meta algo
 * que se dibuja en el servidor dentro de un grupo (la sección de programas
 * contables, con sus llaves).
 */

function scoped(workspaceId: string | null, href: string): string {
  if (!workspaceId || !href.startsWith('/')) return href;
  return workspaceHref(workspaceId, href);
}

export function ConnectCatalog({
  groups,
  workspaceId,
  googleConnected,
  slots,
  id = 'conecta',
}: {
  groups: CatalogGroup[];
  workspaceId: string | null;
  googleConnected: boolean;
  slots?: Partial<Record<NonNullable<CatalogGroup['slot']>, ReactNode>>;
  id?: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} id={id} className="scroll-mt-6">
      <div className="mb-4">
        <h2 id={`${id}-title`} className="text-lg font-extrabold tracking-tight text-ink">
          Conecta algo nuevo
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-muted">
          Elige por lo que quieres traer. Cortex te muestra lo que encontró y pregunta antes de
          crear nada.
        </p>
      </div>
      <nav aria-label="Grupos" className="-mx-1 mb-5 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {groups
          .filter((g) => !g.folded)
          .map((g) => (
            <a
              key={g.id}
              href={`#${g.id}`}
              className="shrink-0 rounded-pill border border-border bg-surface px-3 py-1 text-xs font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
            >
              {g.title}
            </a>
          ))}
      </nav>
      <div className="flex flex-col gap-7">
        {groups.map((group) =>
          group.folded ? (
            <details key={group.id} id={group.id} className="group scroll-mt-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card [&::-webkit-details-marker]:hidden">
                <span>
                  <span className="text-sm font-extrabold text-ink">{group.title}</span>
                  <span className="ml-2 text-xs text-ink-faint">{group.hint}</span>
                </span>
                <ChevronDown
                  className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-open:rotate-180 motion-reduce:transition-none"
                  aria-hidden
                />
              </summary>
              <div className="mt-3">
                <ItemGrid
                  items={group.items}
                  workspaceId={workspaceId}
                  googleConnected={googleConnected}
                />
              </div>
            </details>
          ) : (
            <div key={group.id} id={group.id} className="scroll-mt-6">
              <div className="mb-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <h3 className="text-base font-extrabold text-ink">{group.title}</h3>
                <p className="text-xs text-ink-muted">{group.hint}</p>
              </div>
              {group.slot && slots?.[group.slot]}
              {group.items.length > 0 && (
                <ItemGrid
                  items={group.items}
                  workspaceId={workspaceId}
                  googleConnected={googleConnected}
                />
              )}
            </div>
          ),
        )}
      </div>
    </section>
  );
}

function ItemGrid({
  items,
  workspaceId,
  googleConnected,
}: {
  items: CatalogItem[];
  workspaceId: string | null;
  googleConnected: boolean;
}) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {items.map((item) => (
        <li key={item.id} className="flex">
          <CatalogCard item={item} workspaceId={workspaceId} googleConnected={googleConnected} />
        </li>
      ))}
    </ul>
  );
}

const BADGE = {
  emerald: 'bg-emerald-soft text-emerald',
  amber: 'bg-amber-soft text-amber',
  neutral: 'bg-surface-2 text-ink-muted',
};

export function CatalogCard({
  item,
  workspaceId,
  googleConnected,
}: {
  item: CatalogItem;
  workspaceId: string | null;
  googleConnected: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const action = item.action;
  const badge = item.badge && (
    <span className={clsx('rounded-pill px-2 py-0.5 text-micro font-bold', BADGE[item.badge.tone])}>
      {item.badge.label}
    </span>
  );

  const primary =
    'inline-flex min-h-9 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';
  const quiet =
    'inline-flex min-h-9 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-4 text-xs font-bold text-ink transition-colors hover:bg-surface-2';

  let footer: ReactNode = null;
  if (action.type === 'none') {
    footer = <span className="text-xs font-semibold text-ink-faint">{action.label}</span>;
  } else if (action.type === 'link') {
    const href = scoped(workspaceId, action.href);
    const cls = item.badge?.tone === 'emerald' ? quiet : primary;
    footer =
      action.external || href.startsWith('#') ? (
        <a href={href} className={cls}>
          {action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </a>
      ) : (
        <Link href={href} className={cls}>
          {action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      );
  } else if (action.needsGoogle && !googleConnected) {
    footer = (
      <span className="flex flex-wrap items-center gap-2">
        <a href={scoped(workspaceId, '/api/integrations/google?preset=all')} className={primary}>
          Conectar Google primero <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </a>
        <span className="text-micro text-ink-faint">Para leer la carpeta</span>
      </span>
    );
  } else if (!open) {
    footer = (
      <button type="button" onClick={() => setOpen(true)} className={primary}>
        {action.label} <ArrowRight className="h-3.5 w-3.5" aria-hidden />
      </button>
    );
  } else {
    const ok = new RegExp(action.pattern).test(url.trim());
    const fieldId = `catalog-${item.id}-url`;
    footer = (
      <form
        className="flex w-full flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok) return;
          const href = `/chat?prompt=${encodeURIComponent(promptFor(action.prompt, url))}`;
          router.push(scoped(workspaceId, href));
        }}
      >
        <label htmlFor={fieldId} className="text-xs font-bold text-ink">
          {action.fieldLabel}
        </label>
        <div className="flex gap-2">
          <input
            id={fieldId}
            type="url"
            inputMode="url"
            // biome-ignore lint/a11y/noAutofocus: el campo aparece porque la persona lo pidió.
            autoFocus
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={action.placeholder}
            aria-invalid={url.trim() !== '' && !ok}
            className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface-2/60 px-3 py-2 font-mono text-xs text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
          />
          <button type="submit" disabled={!ok} className={primary}>
            Seguir
          </button>
        </div>
        {url.trim() !== '' && !ok ? (
          <p className="text-micro text-rose">Ese enlace no parece el correcto.</p>
        ) : (
          <p className="text-micro text-ink-faint">
            Se abre el chat con la petición escrita: Cortex te muestra las columnas antes de crear
            la tabla.
          </p>
        )}
      </form>
    );
  }

  return (
    <article className="flex w-full flex-col gap-3 rounded-card border border-border bg-surface p-4 shadow-card transition-colors hover:border-border-strong">
      <SourceTile
        icon={CATALOG_ICON[item.icon]}
        tone={item.tone}
        title={item.title}
        body={item.body}
        badge={badge}
      />
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">{footer}</div>
    </article>
  );
}
