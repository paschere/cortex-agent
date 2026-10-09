import { detailOf, str } from './detail';
import type { ActivityEvent, UndoPlan } from './types';

/**
 * QUÉ SE PUEDE DESHACER, Y CON QUÉ.
 *
 * Un registro chico y explícito: cada herramienta reversible con su inversa. Una
 * acción sólo se ofrece para deshacer si (1) su herramienta está aquí, (2) salió
 * bien y (3) la fila de auditoría trae los datos que la inversa necesita. Sin
 * alguno de los tres, no hay botón: preferimos no ofrecer a prometer algo que no
 * se puede cumplir.
 *
 * Deshacer NO escribe en la base: devuelve un plan que `actions.ts` ejecuta con
 * `runTool` (permisos, confirmación, límites y auditoría de siempre).
 *
 * Cobertura hoy:
 *   · trackers.upsert que CREÓ una fila     → trackers.remove de esa fila
 *   · trackers.upsert que EDITÓ una fila    → trackers.upsert con los valores de antes
 *                                             (sólo si la auditoría los guardó)
 *   · views.archive                          → views.restore
 *   · views.create                           → views.archive (se puede restaurar)
 * Lo demás (correos enviados, pagos, facturas…) NO es reversible y no se ofrece.
 */
export const REVERSIBLE_TOOLS = ['trackers.upsert', 'views.archive', 'views.create'] as const;

/** Ids que caben en un slug / uuid: nada de lo que se reinyecta puede traer otra cosa. */
const SAFE_REF = /^[A-Za-z0-9_.-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function undoPlanFor(
  event: Pick<ActivityEvent, 'tool_id' | 'status' | 'metadata'>,
): UndoPlan | null {
  if (event.status !== 'ok') return null;
  const { input, result, before } = detailOf(event);

  switch (event.tool_id) {
    case 'trackers.upsert': {
      const tracker = str(input.tracker, 80);
      if (!tracker || !SAFE_REF.test(tracker)) return null;
      const row = result.row;
      const rowId =
        row && typeof row === 'object' ? (row as Record<string, unknown>).id : undefined;
      if (typeof rowId !== 'string' || !UUID.test(rowId)) return null;
      if (result.created === true) {
        return {
          toolId: 'trackers.remove',
          input: { tracker, rowId },
          label: 'Quitar la fila',
        };
      }
      if (result.created !== false) return null;
      // Edición: sólo con los valores de antes, de TODOS los campos escritos.
      const written =
        input.values && typeof input.values === 'object'
          ? Object.keys(input.values as Record<string, unknown>)
          : [];
      if (!before || written.length === 0) return null;
      if (!written.every((k) => k in before)) return null;
      const values: Record<string, string | number | boolean> = {};
      for (const k of written) {
        const v = before[k];
        if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
        values[k] = v;
      }
      return {
        toolId: 'trackers.upsert',
        input: { tracker, rowId, values },
        label: 'Volver a los valores de antes',
      };
    }
    case 'views.archive': {
      const view = str(input.view, 80);
      if (!view || !SAFE_REF.test(view)) return null;
      if (result.archived !== true) return null;
      return { toolId: 'views.restore', input: { view }, label: 'Restaurar la vista' };
    }
    case 'views.create': {
      const v = result.view;
      const slug = v && typeof v === 'object' ? str((v as Record<string, unknown>).slug, 80) : null;
      if (!slug || !SAFE_REF.test(slug)) return null;
      return { toolId: 'views.archive', input: { view: slug }, label: 'Archivar la vista' };
    }
    default:
      return null;
  }
}

/** ¿Se ofrece «Deshacer»? Tiene plan y todavía no se deshizo. */
export function canUndo(
  event: Pick<ActivityEvent, 'id' | 'tool_id' | 'status' | 'metadata'>,
  undoneIds: ReadonlySet<string>,
): boolean {
  return !undoneIds.has(event.id) && undoPlanFor(event) !== null;
}
