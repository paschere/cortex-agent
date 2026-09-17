export default function ActivationsLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Cargando Activaciones">
      <div className="h-16 max-w-2xl animate-pulse rounded-lg bg-surface-2" />
      <div className="h-14 animate-pulse rounded-card bg-surface-2" />
      <div className="h-[32rem] animate-pulse rounded-card bg-surface-2" />
    </div>
  );
}
