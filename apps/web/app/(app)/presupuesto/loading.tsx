export default function BudgetLoading() {
  return (
    <div className="space-y-6" aria-label="Cargando el presupuesto" aria-busy="true">
      <div className="h-24 w-full animate-pulse rounded-card bg-surface-2" />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-card bg-surface-2" />
        ))}
      </div>
      <div className="h-[28rem] w-full animate-pulse rounded-card bg-surface-2" />
    </div>
  );
}
