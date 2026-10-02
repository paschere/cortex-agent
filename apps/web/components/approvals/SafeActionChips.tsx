import { type StatusTone, chipClass } from '@/lib/status-chip';

/**
 * LAS FICHAS DE «ACCIÓN SEGURA DE REPETIR» (migración 0168).
 *
 * Tres cosas que `runTool` sabe de una acción con efectos y que una persona
 * tiene que poder ver sin abrir el JSON: si se comprobó que de verdad ocurrió,
 * si no se pudo comprobar, y si NO se hizo porque ya estaba hecha. Se leen de
 * dos sitios con la misma forma pequeña:
 *
 *   · el resultado de la herramienta (`_verification`, `_idempotency`), que es
 *     lo que vuelve a la tarjeta de aprobación;
 *   · los metadatos de la fila de auditoría (`verification`, `idempotency`).
 *
 * Presentación pura, sin estado y sin importar `@cortex/agent-tools`: se monta
 * en componentes de cliente y de servidor por igual.
 */

interface Chip {
  label: string;
  tone: StatusTone;
  title?: string;
}

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function safeActionChips(source: unknown): Chip[] {
  const root = obj(source);
  if (!root) return [];
  const chips: Chip[] = [];

  const idem = obj(root._idempotency) ?? obj(root.idempotency);
  const outcome = idem?.outcome;
  if (outcome === 'replayed') {
    chips.push({
      label: 'No repetido (ya hecho)',
      tone: 'primary',
      title: typeof idem?.notice === 'string' ? idem.notice : 'Ya se había hecho; no se repitió.',
    });
  } else if (outcome === 'repeated') {
    chips.push({ label: 'Repetido a pedido', tone: 'amber' });
  }

  const ver = obj(root._verification) ?? obj(root.verification);
  const status = ver?.status;
  const detail =
    typeof ver?.notice === 'string'
      ? ver.notice
      : typeof ver?.detail === 'string'
        ? ver.detail
        : undefined;
  if (status === 'verified') chips.push({ label: 'Verificado', tone: 'emerald', title: detail });
  else if (status === 'not_verified')
    chips.push({ label: 'No se pudo verificar', tone: 'rose', title: detail });
  else if (status === 'unverifiable')
    chips.push({ label: 'No se pudo verificar', tone: 'neutral', title: detail });

  return chips;
}

export function SafeActionChips({ source, className }: { source: unknown; className?: string }) {
  const chips = safeActionChips(source);
  if (chips.length === 0) return null;
  return (
    <span className={`flex flex-wrap items-center gap-1.5 ${className ?? ''}`}>
      {chips.map((c) => (
        <span key={c.label} className={chipClass(c.tone)} title={c.title}>
          {c.label}
        </span>
      ))}
    </span>
  );
}
