export type SourceHealth = {
  state:
    | 'healthy'
    | 'stale'
    | 'incomplete'
    | 'expired'
    | 'missing'
    | 'disconnected'
    | 'error'
    | 'review';
  label: string;
  detail: string;
  affectedActivations: number;
  needsReview: number;
};
type Source = {
  enabled: boolean;
  status: string;
  last_checked_at: string | null;
  freshness_minutes?: number;
  latest_attachment_id: string | null;
};
type Capture = { id: string; purge_at: string; feed_truncated: boolean } | null;
type Automation = { status: string; name?: string };
export function sourceHealth(
  source: Source,
  capture: Capture,
  automations: Automation[],
  now = new Date(),
): SourceHealth {
  const affectedActivations = automations.filter(
    (a) => a.status === 'active' || a.status === 'needs_review',
  ).length;
  const needsReview = automations.filter((a) => a.status === 'needs_review').length;
  const result = (state: SourceHealth['state'], label: string, detail: string): SourceHealth => ({
    state,
    label,
    detail,
    affectedActivations,
    needsReview,
  });
  if (!source.enabled)
    return result(
      'disconnected',
      'Desconectada',
      'Vuelve a conectar la fuente. Las activaciones pausadas necesitan tu confirmación para continuar.',
    );
  if (source.status === 'error')
    return result(
      'error',
      'Necesita reparación',
      'Revisa acceso y configuración, luego vuelve a consultar la fuente.',
    );
  if (!capture)
    return result(
      'missing',
      'Sin captura vigente',
      'Actualiza la conexión o añade una nueva versión para poder revisar sus datos.',
    );
  if (new Date(capture.purge_at).getTime() <= now.getTime())
    return result(
      'expired',
      'Captura vencida',
      'La conexión se conserva; vuelve a obtener los datos.',
    );
  if (capture.feed_truncated)
    return result(
      'incomplete',
      'Lectura incompleta',
      'Acota la consulta o divide el archivo. Una lectura parcial no permite autorizar seguimiento.',
    );
  if (needsReview)
    return result(
      'review',
      'Reglas por revisar',
      'Hay activaciones detenidas. Revisa sus campos y simula la versión actual antes de autorizarlas.',
    );
  const checked = Date.parse(source.last_checked_at ?? '');
  if (
    !Number.isFinite(checked) ||
    now.getTime() - checked > (source.freshness_minutes ?? 1440) * 60000
  )
    return result(
      'stale',
      'Revisión atrasada',
      'La última consulta supera el plazo de vigencia que definiste. No demuestra que el origen esté actualizado.',
    );
  return result(
    'healthy',
    'Lectura vigente',
    'La captura está completa y dentro del plazo de revisión.',
  );
}
