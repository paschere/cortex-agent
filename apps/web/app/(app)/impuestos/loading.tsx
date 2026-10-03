export default function TaxLoading() {
  return (
    <div className="space-y-6" aria-label="Cargando impuestos" aria-busy="true">
      <div className="h-24 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="h-24 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
        <div className="h-[32rem] animate-pulse rounded-card bg-surface-2" />
        <div className="h-80 animate-pulse rounded-card bg-surface-2" />
      </div>
    </div>
  );
}
