import Link from 'next/link';

/** Una dirección que no existe (o que tu rol no ve): dicho con calma y con salida, no el 404 pelado. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-extrabold tracking-tight text-ink">No encontramos esta pantalla</h1>
      <p className="text-sm text-ink-muted">
        Puede que ya no exista o que tu rol no tenga acceso. Vuelve al inicio y sigue desde ahí.
      </p>
      <Link
        href="/"
        className="mt-1 inline-flex min-h-12 items-center justify-center rounded-pill bg-primary px-6 text-sm font-bold text-white shadow-pop hover:bg-primary-strong"
      >
        Ir al inicio
      </Link>
    </main>
  );
}
