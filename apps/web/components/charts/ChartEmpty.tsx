import { clsx } from 'clsx';

/** La nota de «no hay con qué dibujar»: discreta, sobre una línea plana. */
export function ChartEmpty({
  note = 'Sin datos suficientes',
  height = 160,
  className,
}: {
  note?: string;
  height?: number;
  className?: string;
}) {
  return (
    <div
      className={clsx('relative w-full', className)}
      style={{ height }}
      role="img"
      aria-label={note}
    >
      <div
        aria-hidden
        className="absolute inset-x-0 border-t border-dashed border-border-strong"
        style={{ top: '62%' }}
      />
      <p className="absolute inset-x-0 top-[36%] text-center text-xs text-ink-faint">{note}</p>
    </div>
  );
}
