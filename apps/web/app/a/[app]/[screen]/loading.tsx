import { ScreenSkeleton } from '@/components/apps/AppSkeleton';

/** Mientras llega la pantalla: su forma, no un círculo girando (0215). */
export default function Loading() {
  return (
    <div className="mx-auto max-w-3xl pt-4">
      <ScreenSkeleton />
    </div>
  );
}
