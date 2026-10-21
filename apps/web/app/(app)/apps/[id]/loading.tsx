import { HomeSkeleton } from '@/components/apps/AppSkeleton';

/** Mientras llega el inicio de la app: su forma, no una pantalla en blanco. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl pt-4">
      <HomeSkeleton />
    </div>
  );
}
