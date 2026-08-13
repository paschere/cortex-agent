/**
 * El vocabulario de los avisos, en un archivo que el navegador puede importar.
 *
 * POR QUÉ ESTÁ SEPARADO DE `lib/notifications/`. Todo lo de esa carpeta empieza
 * con `import 'server-only'` y toca la base. La bandeja y la campana son
 * componentes de cliente, así que lo que ambos lados necesitan —los nombres de
 * las clases de aviso, su tono y su etiqueta— vive aquí, sin una sola
 * dependencia. Es la misma razón por la que existen `actions-shape.ts`,
 * `commitments-shape.ts` y `errands-shape.ts`: el barril de `@cortex/agent-tools`
 * alcanza `node:dns` y rompería el build del navegador, y ni `typecheck` ni
 * `test` lo notan porque ninguno de los dos empaqueta para el navegador.
 *
 * A diferencia de esos tres, aquí NO hay una copia que pueda desviarse: los
 * avisos no tienen módulo en el paquete, así que esta lista es el original. Lo
 * que sí tiene que seguir cuadrando es el CHECK de `notifications.kind` en la
 * migración 0096, y `notifications/notify.test.ts` compara las dos listas
 * leyendo el SQL, para que añadir una clase aquí sin migrarla falle en CI.
 */

/**
 * Las nueve clases de aviso, y ninguna más sin una migración.
 *
 * LO QUE NO ESTÁ AQUÍ ES LA MITAD DE LA DECISIÓN. No hay `approval_pending`,
 * `action_proposed`, `commitment_due` ni `errand_blocked`: eso es ESTADO, sigue
 * ahí hasta que alguien actúe, y ya tiene cuatro pantallas y un índice que lo
 * reúne. Convertir una cola en avisos produce el peor resultado posible — la
 * campana repite lo que el menú ya dice, y como el hecho sigue siendo verdad
 * mañana, o vuelve a avisar (ruido) o miente (peor).
 */
export const NOTIFICATION_KINDS = [
  'flow_finished',
  'flow_failed',
  'flow_needs_person',
  'routine_finished',
  'routine_failed',
  'errand_asked',
  'errand_finished',
  'action_sent',
  'action_failed',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** El color, y sólo el color. Se guarda en la fila; ver la 0096. */
export const NOTIFICATION_TONES = ['info', 'good', 'warning', 'bad'] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

/** De qué habla el aviso. Sirve para agrupar y para saber a qué se refiere. */
export const NOTIFICATION_SOURCES = ['flow_run', 'routine_run', 'errand', 'action'] as const;
export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

/**
 * El tono por defecto de cada clase.
 *
 * Es un DEFECTO y no una definición: `notify()` acepta un tono explícito porque
 * hay clases que pueden acabar de dos maneras — un encargo que se cierra puede
 * haber entregado o haberse agotado, y son la misma clase con distinto color.
 */
export const NOTIFICATION_TONE_BY_KIND: Record<NotificationKind, NotificationTone> = {
  flow_finished: 'good',
  flow_failed: 'bad',
  flow_needs_person: 'warning',
  routine_finished: 'good',
  routine_failed: 'bad',
  errand_asked: 'warning',
  errand_finished: 'good',
  action_sent: 'good',
  action_failed: 'bad',
};

/** Cómo se llama cada clase en la bandeja, en dos palabras. */
export const NOTIFICATION_KIND_LABEL: Record<NotificationKind, string> = {
  flow_finished: 'Trámite',
  flow_failed: 'Trámite',
  flow_needs_person: 'Trámite',
  routine_finished: 'Rutina',
  routine_failed: 'Rutina',
  errand_asked: 'Encargo',
  errand_finished: 'Encargo',
  action_sent: 'Acción',
  action_failed: 'Acción',
};

/** Una fila de la bandeja, tal y como viaja del servidor a la pantalla. */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  tone: NotificationTone;
  title: string;
  body: string | null;
  href: string | null;
  /** Cuántas veces pasó lo mismo desde que se escribió la fila. Casi siempre 1. */
  occurrences: number;
  occurredAt: string;
  readAt: string | null;
}

/**
 * «pasó 3 veces» — sólo cuando pasó más de una.
 *
 * Vive aquí y no en la pantalla porque la bandeja y cualquier otra superficie
 * que dibuje un aviso tienen que decirlo igual.
 */
export function repeatNote(occurrences: number): string | null {
  if (occurrences <= 1) return null;
  return `pasó ${occurrences} veces`;
}
