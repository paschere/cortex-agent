export default function FinanceLoading() {
  return (
    <div className="space-y-6" aria-label="Cargando finanzas" aria-busy="true">
      <div className="h-16 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-32 animate-pulse rounded-card bg-surface-2" />
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.45fr)_minmax(300px,.75fr)]">
        <div className="h-96 animate-pulse rounded-card bg-surface-2" />
        <div className="h-72 animate-pulse rounded-card bg-surface-2" />
      </div>
    </div>
  );
}
