'use client';

import {
  type SheetWindowInfo,
  loadMoreLabel,
  reachLabel,
  reachPresets,
  sizeFromText,
  windowRangeLabel,
  windowShortDay,
} from '@cortex/agent-tools/src/views/sheet-window';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { ArrowDownToLine, Check, ChevronDown, History, Loader2 } from 'lucide-react';

/**
 * LA VENTANA DE LA HOJA, a la vista: arriba el selector de alcance («Últimos 30
 * días») y la línea de lo que se muestra; abajo el botón para cargar hacia el
 * pasado y, al llegar al fondo, hasta dónde se ve. Todo lo calcula el servidor
 * (`block.window`); aquí sólo se pinta y se pide.
 */

const plural = (n: number, one: string, many: string) => (n === 1 ? `${n} ${one}` : `${n} ${many}`);
const nounOne = (noun: string) => (noun.endsWith('ces') ? `${noun.slice(0, -3)}z` : noun.replace(/s$/, ''));

/** La línea de lo que se muestra («Mostrando 24–30 oct · 120 guías en 8 manifiestos»). */
function windowSummary(win: SheetWindowInfo) {
  const range =
    win.shownFrom && win.shownTo ? windowRangeLabel(win.shownFrom, win.shownTo, win.today) : null;
  return win.search ? (
    <>
      <strong className="font-semibold text-ink">{plural(win.rows, nounOne(win.rowNoun), win.rowNoun)}</strong>{' '}
      · resultados en todo el histórico
    </>
  ) : (
    <>
      Mostrando{' '}
      {range ? <strong className="font-semibold text-ink">{range}</strong> : 'lo más reciente'} ·{' '}
      {plural(win.rows, nounOne(win.rowNoun), win.rowNoun)}
      {win.groupNoun && win.groupCount > 0
        ? ` en ${plural(win.groupCount, nounOne(win.groupNoun), win.groupNoun)}`
        : ''}
    </>
  );
}

/** El selector de alcance («Últimos 7 días», «Todo»…). */
export function WindowReach({
  win,
  loading,
  onReach,
  slim = false,
}: {
  win: SheetWindowInfo;
  loading: boolean;
  onReach: (id: string) => void;
  /** En la barra de la hoja: más bajo y sin sombra. */
  slim?: boolean;
}) {
  const presets = reachPresets(sizeFromText(win.size));
  const current = win.search ? '' : reachLabel(win, win.today);
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={win.search}
        title="Cuánto histórico ver"
        className={clsx(
          'inline-flex shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface text-xs font-semibold text-ink',
          slim ? 'h-8 px-2.5' : 'h-8 px-3 shadow-card',
          'hover:bg-surface-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50',
        )}
      >
        {loading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-ink-faint" aria-label="Cargando" />
        ) : (
          <History className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
        )}
        {slim ? (
          <>
            <span className="sm:hidden">{win.search ? 'Todo' : current.replace(/^Últimos /, '')}</span>
            <span className="hidden sm:inline">{win.search ? 'Todo el histórico' : current}</span>
          </>
        ) : win.search ? (
          'Todo el histórico'
        ) : (
          current
        )}
        <ChevronDown className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={6}
          className="view-no-print z-[70] min-w-[12rem] rounded-card border border-border bg-surface p-1 text-xs shadow-pop"
        >
          {presets.map((p) => {
            const on = p.label === current;
            return (
              <Menu.Item
                key={p.id}
                onSelect={() => onReach(p.id)}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-sm px-3 py-2 font-medium text-ink outline-none data-[highlighted]:bg-surface-2"
              >
                {p.label}
                {on && <Check className="h-3.5 w-3.5 text-primary" aria-hidden />}
              </Menu.Item>
            );
          })}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** La línea de lo que se muestra, sola (para la barra de estado de abajo). */
export function WindowSummary({ win }: { win: SheetWindowInfo }) {
  return (
    <span className="tabular min-w-0 truncate text-ink-muted" aria-live="polite">
      {windowSummary(win)}
    </span>
  );
}

export function WindowBar({
  win,
  loading,
  onReach,
}: {
  win: SheetWindowInfo;
  loading: boolean;
  onReach: (id: string) => void;
}) {
  return (
    <div
      className="view-no-print mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs"
      data-sheet-window
    >
      <WindowReach win={win} loading={loading} onReach={onReach} />
      <WindowSummary win={win} />
    </div>
  );
}

export function WindowFooter({
  win,
  loading,
  hasTotals,
  onMore,
}: {
  win: SheetWindowInfo;
  loading: boolean;
  hasTotals: boolean;
  onMore: () => void;
}) {
  const partial = win.more || win.search;
  return (
    <div className="view-no-print mt-3 flex flex-col items-center gap-1.5 text-center" data-sheet-window-footer>
      {win.search ? (
        <p className="text-xs text-ink-muted">
          Buscando en todo el histórico. Quita la búsqueda o los filtros para volver a la ventana.
        </p>
      ) : win.more ? (
        <button
          type="button"
          onClick={onMore}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-pill border border-border bg-surface px-4 text-xs font-semibold text-ink shadow-card hover:bg-surface-2 disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <ArrowDownToLine className="h-3.5 w-3.5" aria-hidden />
          )}
          {loading ? 'Cargando…' : loadMoreLabel(win)}
        </button>
      ) : (
        <p className="text-xs text-ink-muted">
          {win.shownFrom
            ? `Ya ves todo desde ${windowShortDay(win.shownFrom, true)}`
            : 'Ya ves todo el histórico'}
        </p>
      )}
      {win.more && win.frontier && (
        <p className="text-micro text-ink-faint">
          Lo anterior llega hasta el {windowShortDay(win.frontier, true)}.
        </p>
      )}
      {win.capped && (
        <p className="text-micro text-amber">Se muestran las más recientes; la hoja llegó a su tope de filas.</p>
      )}
      {hasTotals && partial && (
        <p className="text-micro text-ink-faint">
          Los totales al pie son {win.search ? 'de estos resultados' : 'del rango cargado'}; los subtotales de
          cada grupo son del grupo completo.
        </p>
      )}
    </div>
  );
}
