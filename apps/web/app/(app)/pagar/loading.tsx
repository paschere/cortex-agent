export default function PagarLoading() {
  return (
    <div
      className="mx-auto max-w-[1320px] space-y-5 px-4 py-6 sm:px-6 sm:py-8"
      aria-label="Cargando por pagar"
      aria-busy="true"
    >
      <div className="h-20 w-2/3 animate-pulse rounded-card bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="h-24 animate-pulse rounded-card bg-surface-2" />
        <div className="h-24 animate-pulse rounded-card bg-surface-2" />
        <div className="h-24 animate-pulse rounded-card bg-surface-2" />
        <div className="h-24 animate-pulse rounded-card bg-surface-2" />
      </div>
      <div className="h-[28rem] animate-pulse rounded-card bg-surface-2" />
    </div>
  );
}
