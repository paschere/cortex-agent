import { clsx } from 'clsx';

/**
 * ESQUELETOS DE CARGA (0215): la forma de lo que viene, no un círculo girando.
 * Sin estado ni cliente: sirven en un `loading.tsx` del servidor. El brillo
 * se apaga con prefers-reduced-motion (app-runner.css).
 */

export function SkeletonBlock({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('app-skeleton', className)} />;
}

/** Una pantalla de app mientras llega: título, tres cifras y una lista de tarjetas. */
export function ScreenSkeleton() {
  return (
    <div aria-busy="true" className="space-y-4">
      <output className="sr-only">Cargando la pantalla</output>
      <SkeletonBlock className="h-7 w-44 !rounded-pill" />
      <div className="grid grid-cols-3 gap-3">
        <SkeletonBlock className="h-24 !rounded-card" />
        <SkeletonBlock className="h-24 !rounded-card" />
        <SkeletonBlock className="h-24 !rounded-card" />
      </div>
      <SkeletonBlock className="h-12 w-full !rounded-pill" />
      <div className="space-y-3">
        <SkeletonBlock className="h-28 w-full !rounded-card" />
        <SkeletonBlock className="h-28 w-full !rounded-card" />
        <SkeletonBlock className="h-28 w-full !rounded-card" />
      </div>
    </div>
  );
}

/** El Inicio mientras llega: saludo, cuatro cifras y un acceso rápido. */
export function HomeSkeleton() {
  return (
    <div aria-busy="true" className="space-y-6">
      <output className="sr-only">Cargando el inicio</output>
      <SkeletonBlock className="h-32 w-full !rounded-card" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SkeletonBlock className="h-36 !rounded-card" />
        <SkeletonBlock className="h-36 !rounded-card" />
        <SkeletonBlock className="h-36 !rounded-card" />
        <SkeletonBlock className="h-36 !rounded-card" />
      </div>
      <SkeletonBlock className="h-28 w-full !rounded-card" />
    </div>
  );
}
