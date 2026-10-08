import { clsx } from 'clsx';

/**
 * ESQUELETOS DE CARGA (0215): la forma de lo que viene, no un círculo girando.
 * Sin estado ni cliente: sirven en un `loading.tsx` del servidor. El brillo
 * se apaga con prefers-reduced-motion (app-runner.css).
 */

export function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('app-skeleton', className)} />;
}

/** Una pantalla de app mientras llega: título, tres cifras y una lista. */
export function ScreenSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <output className="sr-only">Cargando la pantalla</output>
      <SkeletonBlock className="h-8 w-48" />
      <div className="grid grid-cols-3 gap-3">
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
        <SkeletonBlock className="h-24" />
      </div>
      <SkeletonBlock className="h-10 w-full" />
      <div className="space-y-2">
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
        <SkeletonBlock className="h-14 w-full" />
      </div>
    </div>
  );
}

/** El Inicio mientras llega: saludo y cuatro tarjetas. */
export function HomeSkeleton() {
  return (
    <div aria-busy="true" className="space-y-5">
      <output className="sr-only">Cargando el inicio</output>
      <div className="space-y-2">
        <SkeletonBlock className="h-8 w-60" />
        <SkeletonBlock className="h-4 w-36" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <SkeletonBlock className="h-32" />
        <SkeletonBlock className="h-32" />
        <SkeletonBlock className="h-32" />
        <SkeletonBlock className="h-32" />
      </div>
    </div>
  );
}
