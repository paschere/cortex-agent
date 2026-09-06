import Link from 'next/link';
/** Leaving setup never dismisses it or changes its progress. */
export function DismissGuide() {
  return (
    <Link href="/management" className="text-sm font-semibold text-primary">
      Continuar con mi agenda
    </Link>
  );
}
