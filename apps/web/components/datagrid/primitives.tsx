'use client';

import type { GridColumnType } from '@/components/datagrid/types';
import { clsx } from 'clsx';
import {
  AlignLeft,
  AtSign,
  Calendar,
  CalendarClock,
  CircleDollarSign,
  CircleDot,
  Hash,
  Link2,
  type LucideIcon,
  Percent,
  Phone,
  SquareCheck,
  Tags,
  Type,
  User,
  X,
} from 'lucide-react';
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * Las piezas pequeñas de la grilla: el globo que se abre bajo un botón, los
 * avisos, el tamaño de pantalla y los íconos por tipo. Sin dependencias nuevas.
 */

export const TYPE_ICON: Record<GridColumnType, LucideIcon> = {
  text: Type,
  long_text: AlignLeft,
  number: Hash,
  money: CircleDollarSign,
  percent: Percent,
  date: Calendar,
  datetime: CalendarClock,
  select: CircleDot,
  status: CircleDot,
  multi_select: Tags,
  person: User,
  boolean: SquareCheck,
  link: Link2,
  email: AtSign,
  phone: Phone,
};

export const TYPE_LABEL: Record<GridColumnType, string> = {
  text: 'Texto',
  long_text: 'Texto largo',
  number: 'Número',
  money: 'Plata',
  percent: 'Porcentaje',
  date: 'Fecha',
  datetime: 'Fecha y hora',
  select: 'Opción',
  status: 'Estado',
  multi_select: 'Varias opciones',
  person: 'Persona',
  boolean: 'Sí / no',
  link: 'Enlace',
  email: 'Correo',
  phone: 'Teléfono',
};

// ---------------------------------------------------------------------------
// Clases compartidas
// ---------------------------------------------------------------------------

export const toolbarButton =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none';
export const toolbarButtonActive = 'border-primary/30 bg-primary-soft text-primary-ink';
export const primaryButton =
  'cortex-primary-button inline-flex h-9 shrink-0 items-center gap-1.5 rounded-pill bg-primary px-4 text-xs font-bold text-white transition-colors duration-150 hover:bg-primary-strong disabled:cursor-not-allowed disabled:opacity-50';
export const ghostButton =
  'inline-flex h-8 items-center gap-1.5 rounded-pill px-2.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink disabled:opacity-50';
export const dangerButton =
  'inline-flex h-9 items-center gap-1.5 rounded-pill bg-rose px-4 text-xs font-bold text-white hover:brightness-95 disabled:opacity-50';
export const inputClass =
  'h-9 w-full rounded-sm border border-border-strong bg-surface px-3 text-xs text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
export const selectClass =
  'h-9 rounded-sm border border-border-strong bg-surface px-2 text-xs text-ink focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20';
export const menuItem =
  'flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-xs text-ink transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 disabled:opacity-50';

export function Count({ n, className }: { n: number; className?: string }) {
  return (
    <span
      className={clsx(
        'tabular inline-grid min-w-5 place-items-center rounded-pill bg-primary px-1.5 text-micro font-semibold leading-5 text-white',
        className,
      )}
    >
      {n}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Popover: un globo anclado a un botón, en un portal, que se cierra solo
// ---------------------------------------------------------------------------

export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = 'start',
  width = 320,
  label,
  className,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: 'start' | 'end';
  width?: number;
  label: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const place = useCallback(() => {
    const a = anchorRef.current?.getBoundingClientRect();
    if (!a) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(width, vw - 16);
    let left = align === 'end' ? a.right - w : a.left;
    left = Math.max(8, Math.min(left, vw - w - 8));
    const below = vh - a.bottom - 12;
    const above = a.top - 12;
    if (below < 240 && above > below) {
      const maxHeight = Math.min(above, 520);
      setPos({ top: Math.max(8, a.top - 6 - maxHeight), left, maxHeight });
    } else {
      setPos({ top: a.bottom + 6, left, maxHeight: Math.min(Math.max(below, 160), 560) });
    }
  }, [anchorRef, align, width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    const onMove = () => place();
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      // Un globo dentro de otro (un selector dentro del filtro) vive en su
      // propio portal: tocarlo no cierra al de afuera.
      if ((t as Element).closest?.('[data-grid-popover]')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey);
    const t = window.setTimeout(() => {
      const first = ref.current?.querySelector<HTMLElement>(
        '[data-autofocus], input, select, textarea, button:not([disabled])',
      );
      first?.focus();
    }, 0);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.clearTimeout(t);
    };
  }, [open, onClose, anchorRef]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: globo no modal anclado a un botón; <dialog> abre en la capa superior y no se posiciona junto al ancla.
    <div
      role="dialog"
      ref={ref}
      aria-label={label}
      data-grid-popover=""
      className={clsx(
        'fixed z-[70] overflow-y-auto rounded-card border border-border bg-surface p-3 text-ink shadow-pop',
        className,
      )}
      style={{
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        width: Math.min(width, typeof window === 'undefined' ? width : window.innerWidth - 16),
        maxHeight: pos?.maxHeight ?? 400,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** Un botón que abre su propio globo. */
export function PopoverButton({
  label,
  icon,
  active,
  badge,
  children,
  align,
  width,
  className,
  title,
}: {
  label: ReactNode;
  icon?: ReactNode;
  active?: boolean;
  badge?: number;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  width?: number;
  className?: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((o) => !o)}
        className={clsx(toolbarButton, (active || open) && toolbarButtonActive, className)}
      >
        {icon}
        {label}
        {badge ? <Count n={badge} /> : null}
      </button>
      <Popover
        open={open}
        onClose={close}
        anchorRef={ref}
        align={align}
        width={width}
        label={title}
      >
        {children(close)}
      </Popover>
    </>
  );
}

// ---------------------------------------------------------------------------
// Avisos
// ---------------------------------------------------------------------------

export type Toast = { id: number; tone: 'ok' | 'error'; text: string };

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    seq.current += 1;
    const id = seq.current;
    setToasts((t) => [...t.slice(-2), { id, tone, text }]);
    window.setTimeout(
      () => setToasts((t) => t.filter((x) => x.id !== id)),
      tone === 'error' ? 7000 : 3500,
    );
  }, []);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  return { toasts, push, dismiss };
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-[80] flex flex-col items-center gap-2 px-4"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={clsx(
            'pointer-events-auto flex max-w-md items-start gap-3 rounded-card border px-4 py-3 text-xs font-semibold shadow-pop',
            t.tone === 'error'
              ? 'border-rose/30 bg-rose-soft text-rose'
              : 'border-border bg-surface text-ink',
          )}
        >
          <span className="min-w-0 flex-1">{t.text}</span>
          <button
            type="button"
            onClick={() => dismiss(t.id)}
            className="-m-1 rounded-pill p-1 opacity-70 hover:opacity-100"
            aria-label="Cerrar aviso"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * Una función con identidad fija que siempre llama a la última versión: así
 * una fila memorizada no se vuelve a dibujar porque el padre se re-pintó.
 */
// biome-ignore lint/suspicious/noExplicitAny: firma genérica de callback.
export function useStable<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  return useCallback(((...args) => ref.current(...args)) as T, []);
}

// ---------------------------------------------------------------------------
// Tamaño de pantalla
// ---------------------------------------------------------------------------

export function useIsMobile(breakpoint = 768): boolean {
  const [mobile, setMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);
    const on = () => setMobile(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [breakpoint]);
  return mobile;
}

/** Un mensaje para la persona a partir de lo que lanzó una acción. */
export function errorText(err: unknown, fallback: string): string {
  const m = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  // Next en producción reemplaza el mensaje de una acción de servidor por uno
  // genérico en inglés: ese no se le muestra a nadie.
  if (!m || m.length > 280 || /Server Components|digest|fetch failed|NEXT_/i.test(m))
    return fallback;
  return m;
}
