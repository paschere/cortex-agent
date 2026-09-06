import { clsx } from 'clsx';

const folds = [
  'M52 153C19 89 65 35 130 52c64 17 80 108 25 136C101 216 37 157 62 97c26-61 121-52 130 14',
  'M60 157C28 96 69 43 130 59c58 15 72 97 22 122-49 26-107-27-83-82 23-55 110-47 117 14',
  'M68 160C39 103 74 52 131 67c51 14 64 84 18 108-43 22-94-24-73-74 21-49 99-42 104 14',
  'M77 163C50 110 79 61 131 75c45 12 55 73 15 93-37 20-81-20-63-64 19-43 86-38 91 13',
  'M86 165C61 118 85 70 131 83c38 10 47 60 12 78-31 16-68-16-53-54 16-37 74-33 78 13',
];

/** Brand motion, not an activity indicator. CSS respects reduced motion and print. */
export function CortexSignature({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 240"
      fill="none"
      aria-hidden="true"
      className={clsx('cortex-signature', className)}
    >
      <g className="cortex-signature-rotor">
        {folds.map((d, index) => (
          <g
            key={d}
            className="cortex-signature-fold"
            style={{ animationDelay: `${index * -1.2}s` }}
          >
            <path d={d} stroke="currentColor" strokeWidth={1.5 + index * 0.5} />
            <path
              d={d}
              pathLength={100}
              stroke="currentColor"
              strokeWidth={2 + index * 0.5}
              strokeLinecap="round"
              className="cortex-signature-trace"
              style={{ animationDelay: `${index * -1.2}s` }}
            />
          </g>
        ))}
      </g>
    </svg>
  );
}
