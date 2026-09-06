export default function Loading() {
  return (
    <div className="space-y-4 p-6">
      <output>Cargando la gerencia de tu empresa…</output>
      <div className="h-24 animate-pulse rounded-lg bg-surface-2" />
      <div className="h-80 animate-pulse rounded-lg bg-surface-2" />
    </div>
  );
}
