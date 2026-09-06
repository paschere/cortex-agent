import { clsx } from 'clsx';

/** The same folded signal identifies Cortex in the rail and the work surface. */
export function CortexSignature({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 240"
      fill="none"
      aria-hidden="true"
      className={clsx('cortex-signature', className)}
    >
      <path
        d="M52 153C19 89 65 35 130 52c64 17 80 108 25 136C101 216 37 157 62 97c26-61 121-52 130 14"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M60 157C28 96 69 43 130 59c58 15 72 97 22 122-49 26-107-27-83-82 23-55 110-47 117 14"
        stroke="currentColor"
        strokeWidth="2"
      />
      <path
        d="M68 160C39 103 74 52 131 67c51 14 64 84 18 108-43 22-94-24-73-74 21-49 99-42 104 14"
        stroke="currentColor"
        strokeWidth="2.5"
      />
      <path
        d="M77 163C50 110 79 61 131 75c45 12 55 73 15 93-37 20-81-20-63-64 19-43 86-38 91 13"
        stroke="currentColor"
        strokeWidth="3"
      />
      <path
        d="M86 165C61 118 85 70 131 83c38 10 47 60 12 78-31 16-68-16-53-54 16-37 74-33 78 13"
        stroke="currentColor"
        strokeWidth="3.5"
      />
    </svg>
  );
}
