import { clsx } from 'clsx';
import { useId } from 'react';

// One continuous, tapered spiral. The silhouette stays intact while rotating.
const spiral = Array.from({ length: 221 }, (_, index) => {
  const u = index / 220;
  const angle = -Math.PI / 2 + u * Math.PI * 4.6;
  const radius = 6 + 85 * u;
  const width = (1.2 + 8 * Math.sqrt(u)) * Math.min(1, (1 - u) / 0.08 + 0.035);
  const slope = 85 / (Math.PI * 4.6);
  const normal = angle - Math.atan2(slope, radius);
  return {
    x: 120 + radius * Math.cos(angle),
    y: 120 + radius * Math.sin(angle),
    nx: (Math.cos(normal) * width) / 2,
    ny: (Math.sin(normal) * width) / 2,
  };
});
const edge = (side: number) =>
  (side === 1 ? spiral : [...spiral].reverse())
    .map(
      ({ x, y, nx, ny }, index) =>
        `${index === 0 && side === 1 ? 'M' : 'L'}${(x + nx * side).toFixed(2)} ${(y + ny * side).toFixed(2)}`,
    )
    .join(' ');
const silhouette = `${edge(1)} ${edge(-1)} Z`;

/** Decorative brand motion, controlled by the host's pause and reduce settings. */
export function CortexSignature({ className }: { className?: string }) {
  const id = `cortex-spiral-${useId().replace(/:/g, '')}`;
  return (
    <svg
      viewBox="0 0 240 240"
      fill="none"
      aria-hidden="true"
      className={clsx('cortex-signature', className)}
    >
      <defs>
        <linearGradient id={id} x1="40" y1="35" x2="190" y2="210" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset=".44" stopColor="#f0edff" />
          <stop offset="1" stopColor="currentColor" />
        </linearGradient>
      </defs>
      <g className="cortex-signature-rotor">
        <path d={silhouette} fill={`url(#${id})`} className="cortex-signature-spiral" />
      </g>
    </svg>
  );
}
