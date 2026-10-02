import { ViewSkeleton } from '@/components/views/blocks/ViewChrome';

/** Mientras se calculan los datos de la vista: su forma, no un spinner. */
export default function Loading() {
  return <ViewSkeleton />;
}
