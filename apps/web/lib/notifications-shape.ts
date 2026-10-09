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
 * Las diez clases de aviso, y ninguna más sin una migración.
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
  /**
   * El parte semanal quedó guardado y el correo NO salió.
   *
   * Es la única clase que habla de algo que salió bien, y sólo se escribe
   * cuando el canal que debía llevarlo falló: si el correo llegó, la campana no
   * lo repite. Ver la 0100, sección 3.
   */
  'report_ready',
  /**
   * Llegó al buzón algo que no puede esperar al resumen de mañana: toca a un
   * cliente, a un compromiso con fecha, o alguien de fuera está esperando.
   *
   * Es la única clase que NO habla de un desenlace de Cortex sino de un hecho
   * del mundo, y la única con tres frenos propios — techo diario, franja
   * horaria y una vez por hilo — porque es la única que puede sonar sola. Ver
   * la migración 0126 y `mail/alerts.ts`.
   */
  'mail_worth_seeing',
  'management_attention',
  /**
   * Una o varias facturas por cobrar cruzaron un escalón de mora (vencida, 30,
   * 60, 90 días). Una vez por escalón y factura; ver la 0159.
   */
  'receivables_overdue',
  /**
   * Alguien usó una vista: un botón de «avisar» en una fila, o entró una fila
   * por un formulario con alerta de campana. Ver la 0160.
   */
  'view_activity',
  /** Una tabla que se llena sola recibió filas nuevas o cambios. Ver la 0161. */
  'table_sync',
  /** A alguien le pasaron trabajo del registro de trabajo (work.assign). Ver la 0174. */
  'work_assigned',
  /**
   * Lo redactado lleva tiempo esperando tu visto bueno —o ya tanto que conviene
   * descartarlo—. Uno por persona y día, nunca uno por borrador. Ver la 0177.
   */
  'approval_waiting',
  /** Tu resumen diario de lo vencido en el registro de trabajo. Ver la 0177. */
  'work_overdue',
  /**
   * «Tu día»: el resumen de la mañana (07:00 de Bogotá, días hábiles). Uno por
   * persona y día, escrito por reglas. Puede traer botones. Ver la 0220.
   */
  'briefing',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** El color, y sólo el color. Se guarda en la fila; ver la 0096. */
export const NOTIFICATION_TONES = ['info', 'good', 'warning', 'bad'] as const;
export type NotificationTone = (typeof NOTIFICATION_TONES)[number];

/** De qué habla el aviso. Sirve para agrupar y para saber a qué se refiere. */
export const NOTIFICATION_SOURCES = [
  'flow_run',
  'routine_run',
  'errand',
  'action',
  'report',
] as const;
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
  // Ámbar y no verde: lo que cuenta no es que el informe exista, es que no
  // llegó a quien tenía que leerlo.
  report_ready: 'warning',
  // Ámbar: no es una mala noticia, es una que no puede esperar. El verde diría
  // «ya está resuelto» y esto es exactamente lo contrario.
  mail_worth_seeing: 'warning',
  management_attention: 'warning',
  receivables_overdue: 'warning',
  view_activity: 'info',
  table_sync: 'info',
  work_assigned: 'info',
  approval_waiting: 'warning',
  work_overdue: 'warning',
  briefing: 'info',
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
  report_ready: 'Informe',
  mail_worth_seeing: 'Correo',
  management_attention: 'Gerencia',
  receivables_overdue: 'Cartera',
  view_activity: 'Vistas',
  table_sync: 'Tablas',
  work_assigned: 'Trabajo',
  approval_waiting: 'Aprobaciones',
  work_overdue: 'Trabajo',
  briefing: 'Tu día',
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
  /** Botones del aviso (0220). Vacío casi siempre. */
  actions: NotificationAction[];
}

/**
 * Un botón de un aviso (0220): referencia una cosa del piloto por su id y su
 * huella. NUNCA una herramienta suelta; el servidor ejecuta por el mismo camino
 * que `ItemDecision` en /piloto.
 */
export interface NotificationAction {
  kind: 'autopilot_item';
  itemId: string;
  contentHash: string;
  /** Qué se hace, en una línea. */
  title: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Lee `notifications.actions` sin confiar en lo que haya en la base. */
export function parseNotificationActions(raw: unknown): NotificationAction[] {
  if (!Array.isArray(raw)) return [];
  const out: NotificationAction[] = [];
  for (const entry of raw.slice(0, 3)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.kind !== 'autopilot_item') continue;
    if (typeof e.itemId !== 'string' || !UUID_RE.test(e.itemId)) continue;
    if (typeof e.contentHash !== 'string' || e.contentHash.length < 8 || e.contentHash.length > 200)
      continue;
    out.push({
      kind: 'autopilot_item',
      itemId: e.itemId,
      contentHash: e.contentHash,
      title: typeof e.title === 'string' ? e.title.slice(0, 160) : 'Hacerlo',
    });
  }
  return out;
}

/** Un aviso acompañado del espacio al que pertenece en la bandeja global. */
export interface GlobalNotificationView extends NotificationView {
  organizationId: string;
  organizationName: string;
  organizationKind: 'personal' | 'company';
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
