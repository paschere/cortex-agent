/** Anillo de avance (0–100) con el tono por significado: verde al completar. */
export function ProgressRing({
  percent,
  size = 44,
  stroke = 5,
  color,
  doneColor = 'rgb(var(--emerald))',
  label = 'Avance',
}: {
  percent: number;
  size?: number;
  stroke?: number;
  color?: string;
  doneColor?: string;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, percent));
  return (
    <svg
      viewBox={`0 0 ${size} ${size}`}
      width={size}
      height={size}
      className="shrink-0"
      role="img"
      aria-label={`${label}: ${Math.round(pct)} %`}
    >
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="rgb(var(--surface-2))"
        strokeWidth={stroke}
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={pct >= 100 ? doneColor : (color ?? 'rgb(var(--primary))')}
        strokeWidth={stroke}
        strokeLinecap="round"
        opacity={pct <= 0 ? 0 : 1}
        strokeDasharray={`${(pct / 100) * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}
