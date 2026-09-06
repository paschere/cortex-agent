import { useId } from 'react';

// Seeded, irregular positions keep SSR and hydration identical. Three depth
// planes move with the page's existing scroll clock; no extra animation loop.
const layers = Array.from({ length: 3 }, (_, depth) => {
  let seed = 709 + depth * 997;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return Array.from({ length: depth === 0 ? 340 : depth === 1 ? 190 : 70 }, (_, index) => {
    const x = random() * 1600;
    const y = random() * 1300;
    const bright = depth === 2 && index % 8 === 0;
    return {
      x,
      y,
      bright,
      radius: bright ? 1.8 + random() * 0.8 : 0.35 + random() * (depth + 1) * 0.4,
      opacity: 0.22 + random() * 0.65,
      color: index % 11 === 0 ? '#e8c5a2' : index % 3 === 0 ? '#afc9ed' : '#eef1fa',
    };
  });
});

export function StarField() {
  const glow = `starlight-${useId().replace(/:/g, '')}`;
  return (
    <div className="journey-starfield" aria-hidden="true">
      {layers.map((stars, depth) => (
        <svg
          aria-hidden="true"
          key={stars[0]?.x}
          className={`journey-starfield__layer journey-starfield__layer--${depth}`}
          viewBox="0 0 1600 1300"
          preserveAspectRatio="xMidYMid slice"
        >
          {depth === 2 && (
            <defs>
              <filter id={glow} x="-200%" y="-200%" width="500%" height="500%">
                <feGaussianBlur stdDeviation="2" />
              </filter>
            </defs>
          )}
          {stars.map((star) => (
            <g key={`${star.x}-${star.y}`} opacity={star.opacity}>
              {star.bright && (
                <circle
                  cx={star.x}
                  cy={star.y}
                  r={star.radius * 2}
                  fill={star.color}
                  opacity=".4"
                  filter={`url(#${glow})`}
                />
              )}
              <circle cx={star.x} cy={star.y} r={star.radius} fill={star.color} />
            </g>
          ))}
        </svg>
      ))}
    </div>
  );
}
