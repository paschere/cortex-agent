export default function FinanceLoading() {
  return (
    <div className="space-y-6" aria-label="Cargando finanzas" aria-busy="true">
      <div className="h-24 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="h-14 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="grid gap-6 xl:grid-cols-[minmax(300px,1fr)_minmax(0,2.1fr)]">
        <div className="h-80 animate-pulse rounded-card bg-surface-2" />
        <div className="h-[28rem] animate-pulse rounded-card bg-surface-2" />
      </div>
      <div className="h-32 animate-pulse rounded-card bg-surface-2" />
      <div className="h-96 animate-pulse rounded-card bg-surface-2" />
    </div>
  );
}
