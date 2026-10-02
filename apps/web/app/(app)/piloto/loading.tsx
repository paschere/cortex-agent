export default function PilotoLoading() {
  return (
    <div className="space-y-6" aria-label="Cargando el piloto automático" aria-busy="true">
      <div className="h-24 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="h-64 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="h-32 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="h-96 w-full animate-pulse rounded-card bg-surface-2" />
    </div>
  );
}
