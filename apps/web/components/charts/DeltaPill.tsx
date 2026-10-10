import { clsx } from 'clsx';
import { formatDelta } from './scales';

/**
 * «▲ +12 %» / «▼ −8 %» con fondo suave: verde si el cambio es bueno, rosa si
 * es malo, gris si no se sabe. Nunca sólo color: la flecha y el signo dicen lo
 * mismo (y un texto para el lector de pantalla).
 */
export function DeltaPill({
  ratio,
  good,
  compact,
  className,
  label,
  text,
}: {
  /** Cambio relativo (0,12 = +12 %). `null` = sin base («nuevo»). */
  ratio: number | null;
  /** `true` = subir es bueno. `null`/`undefined` = neutro. */
  good?: boolean | null;
  compact?: boolean;
  className?: string;
  /** Texto a la derecha, p. ej. «vs. mes pasado». */
  label?: string;
  /** Cómo escribir el cambio, si no es el porcentaje entero (p. ej. «+12,5 %»). */
  text?: string;
}) {
  const pct = ratio === null ? 0 : Math.round(ratio * 100);
  const dir = ratio === null ? 'new' : pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const tone =
    good === null || good === undefined || dir === 'flat' || dir === 'new'
      ? 'bg-surface-2 text-ink-muted'
      : good
        ? 'bg-emerald-soft text-emerald'
        : 'bg-rose-soft text-rose';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : dir === 'flat' ? '■' : '●';
  return (
    <span className={clsx('inline-flex items-center gap-1.5', className)}>
      <span
        className={clsx(
          'tabular inline-flex shrink-0 items-center gap-1 rounded-pill tabular-nums font-semibold',
          compact ? 'px-1.5 py-px text-[0.65rem]' : 'px-2 py-0.5 text-micro',
          tone,
        )}
      >
        <span aria-hidden className="text-[0.55em] leading-none">
          {arrow}
        </span>
        {text ?? formatDelta(ratio)}
        {good !== null && good !== undefined && dir !== 'flat' && dir !== 'new' && (
          <span className="sr-only">{good ? ' (bien)' : ' (mal)'}</span>
        )}
      </span>
      {label && <span className="text-micro text-ink-faint">{label}</span>}
    </span>
  );
}
