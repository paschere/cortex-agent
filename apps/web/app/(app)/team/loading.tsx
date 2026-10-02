export default function TeamLoading() {
  return (
    <div className="space-y-6" aria-label="Cargando el equipo" aria-busy="true">
      <div className="h-24 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="h-10 w-2/3 animate-pulse rounded-pill bg-surface-2" />
      <div className="h-56 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
        <div className="h-72 animate-pulse rounded-card bg-surface-2" />
        <div className="h-72 animate-pulse rounded-card bg-surface-2" />
        <div className="h-72 animate-pulse rounded-card bg-surface-2" />
      </div>
    </div>
  );
}
