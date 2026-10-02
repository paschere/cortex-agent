/**
 * «QUE CORTEX LO RESUELVA»: EL SIGUIENTE PASO SEGURO DE ALGO PENDIENTE.
 *
 * Mucho de lo que se queda esperando no espera una decisión difícil: espera a
 * que alguien redacte el correo, proponga a quién pasárselo o vuelva a correr
 * una sincronización. Eso lo puede preparar Cortex. Este archivo decide, para
 * cada clase de pendiente, cuál es ESE paso y cómo se le pide.
 *
 * ===========================================================================
 * POR QUÉ ES UNA PREGUNTA AL CHAT Y NO UN BOTÓN QUE EJECUTA
 * ===========================================================================
 * El botón abre el chat con la petición escrita (`/chat?prompt=…`). Todo lo que
 * de ahí salga con efecto —mandar un correo, reasignar, reintentar— pasa por la
 * misma puerta de siempre: las herramientas que escriben piden confirmación y
 * la tarjeta de aprobación es la pregunta. Por eso cada petición termina en
 * «muéstramelo antes»: lo que se ahorra es redactar la petición, no el sí.
 *
 * Un pendiente sin paso seguro (una aprobación, que sólo decide quien la pidió)
 * devuelve `null` y la pantalla no dibuja el botón. Mejor ningún botón que uno
 * que no sabe qué hacer.
 *
 * Puro y sin dependencias. Lo llaman los componentes de SERVIDOR (el índice de
 * «Te espera», Acciones, Mi semana) y le pasan al cliente el enlace ya armado:
 * un componente de cliente no puede importar valores de este paquete.
 */

export type ResolvableKind =
  | 'action'
  | 'commitment'
  | 'errand'
  | 'work_item'
  | 'work_item_mine'
  | 'routine'
  | 'sync';

export interface ResolvableItem {
  kind: ResolvableKind;
  title: string;
  /** Con quién, de qué cliente, o a quién está asignado. */
  detail?: string | null;
  /** Días que lleva esperando o vencido, si se sabe. */
  days?: number | null;
}

export interface ResolveStep {
  /** El texto del botón. */
  label: string;
  /** Lo que se le escribe a Cortex. */
  prompt: string;
}

function quote(text: string, max = 120): string {
  const t = text.trim().replace(/\s+/g, ' ').replace(/[«»]/g, '"');
  return `«${t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`}»`;
}

/** El paso seguro, o `null` si no lo hay. */
export function resolveStepFor(item: ResolvableItem): ResolveStep | null {
  const title = item.title?.trim();
  if (!title) return null;
  const q = quote(title);
  const detail = item.detail?.trim() ? ` (${item.detail.trim()})` : '';
  switch (item.kind) {
    case 'action':
      return {
        label: 'Que Cortex lo actualice',
        prompt: `El borrador ${q}${detail} lleva días esperando. Revisa si las cifras siguen vigentes, actualízalo si hace falta y muéstramelo listo para aprobar o dime si conviene descartarlo.`,
      };
    case 'commitment':
      return {
        label: 'Que Cortex redacte el aviso',
        prompt: `El vencimiento ${q}${detail} ya está encima. Redacta el correo para quien corresponde y muéstramelo antes de enviarlo.`,
      };
    case 'errand':
      return {
        label: 'Que Cortex me ayude a contestar',
        prompt: `El encargo ${q} está esperando una respuesta mía. Muéstrame qué preguntó y propón qué contestarle.`,
      };
    case 'work_item':
      return {
        label: 'Que Cortex proponga a quién',
        prompt: `${q}${detail} está vencido. Mira la carga del equipo en el registro de trabajo y propón a quién pasárselo; muéstramelo antes de reasignar.`,
      };
    case 'work_item_mine':
      return {
        label: 'Que Cortex redacte el aviso',
        prompt: `Tengo vencido ${q}${detail}. Redacta un aviso corto para quien lo espera diciendo cuándo queda, o propón a quién pedirle ayuda; muéstramelo antes de hacer nada.`,
      };
    case 'routine':
      return {
        label: 'Que Cortex la revise',
        prompt: `La rutina ${q} falló. Revisa qué pasó, dime cómo arreglarla y, si es seguro, vuelve a correrla.`,
      };
    case 'sync':
      return {
        label: 'Que Cortex lo reintente',
        prompt: `La sincronización ${q} se quedó atascada. Revisa el error y reinténtala si es seguro; si falta algo de mi lado, dime qué.`,
      };
  }
}

/** El enlace al chat con la petición escrita. */
export function resolveHref(step: ResolveStep | null, base = '/chat'): string | null {
  if (!step) return null;
  return `${base}?prompt=${encodeURIComponent(step.prompt)}`;
}
