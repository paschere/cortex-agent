import {
  Briefcase,
  Building2,
  CalendarClock,
  FileBarChart,
  Inbox,
  Table2,
  Wallet,
} from 'lucide-react';

/**
 * QUÉ ES UN PANEL, Y POR QUÉ ESTE ARCHIVO NO ES `server-only` NI `'use client'`.
 *
 * ===========================================================================
 * LA IDEA, EN UNA FRASE
 * ===========================================================================
 * Un panel NO es una pantalla. Es un RESULTADO DE HERRAMIENTA fijado al lado
 * del chat. Se llama a la misma herramienta que llamaría el modelo, y se pinta
 * con el mismo componente con el que el chat pinta ese resultado
 * (`components/chat/results/registry.tsx`). Un camino de datos, un componente,
 * dos colocaciones. No hay una segunda versión de nada, así que no hay nada que
 * se pueda desincronizar.
 *
 * Eso resuelve el problema de verdad, que no era estético: hoy ir a `/payments`
 * desde el chat DESMONTA `ChatRoot` entero, y con él se van los fotogramas de
 * la pantalla compartida (la migración 0092 no guarda bytes a propósito), la
 * sesión de `getDisplayMedia`, el razonamiento del turno, el borrador del
 * compositor y cualquier turno en vuelo. Navegar era abandonar.
 *
 * ===========================================================================
 * POR QUÉ NO SE REUTILIZAN LAS PÁGINAS DE `app/(app)/**\/page.tsx`
 * ===========================================================================
 * Tres razones, en orden de dureza:
 *
 *   1. No se puede montar un componente de servidor dentro de un árbol de
 *      cliente. `ChatRoot` es `'use client'`; esas páginas son `async` y llaman
 *      a `requireSession()`.
 *   2. Rutas paralelas/interceptoras son otro mecanismo de ROUTER sobre un
 *      `useChat` con un `fetch` en vuelo. Este código ya perdió mensajes por
 *      eso una vez — ver el comentario de `ChatRoot.tsx` sobre por qué usa
 *      `window.history.replaceState` y no `router.replace()`.
 *   3. Una pantalla pensada para `max-w-6xl` con un `PageHeader` de 22px no cabe
 *      en 460px.
 *
 * ===========================================================================
 * POR QUÉ ESTE ARCHIVO LO IMPORTAN LOS DOS LADOS
 * ===========================================================================
 * El `toolId` NUNCA viaja desde el navegador. Del cliente sale un `panelId` —
 * una palabra cerrada de esta tabla — y, si la superficie es de una entidad,
 * una clave. El servidor lo resuelve CONTRA ESTA TABLA antes de tocar nada.
 * Un cliente que pudiera nombrar la herramienta podría nombrar
 * `gmail.send_message`.
 *
 * Para que eso funcione, la tabla tiene que ser la MISMA en los dos sitios: el
 * rail necesita saber qué destinos tienen panel, y la ruta necesita saber qué
 * herramienta corre cada uno. De ahí que este archivo no lleve `server-only`
 * (lo rompería para el rail) ni `'use client'` (lo rompería para la ruta), y de
 * ahí que no importe NADA de `@cortex/agent-tools`: un id de herramienta aquí
 * es una cadena, y las cadenas cruzan la frontera sin arrastrar `node:dns`
 * detrás. Es la misma disciplina que `lib/reports-shape.ts` ya documenta.
 */

/** Lo poco que un icono necesita ser para que lo dibujen el rail y el panel. */
type PanelIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

export interface PanelShape {
  /**
   * La herramienta que se ejecuta al abrir. Del cliente no llega nunca: llega
   * el `panelId` y esto es lo que lo traduce, en el servidor.
   */
  toolId: string;
  /**
   * La entrada, FIJA y escrita aquí. Tampoco viaja desde el cliente, por la
   * misma razón que el `toolId`: un panel es una pregunta concreta, no un
   * formulario libre contra el catálogo de herramientas.
   *
   * Los límites son más cortos que los de la pantalla completa a propósito. En
   * 460px caben unas cuantas filas; para el resto está la puerta a la pantalla,
   * que es lo que `href` existe para abrir.
   */
  input: Record<string, unknown>;
  /** Lo que dice la cabecera del panel. */
  title: string;
  icon: PanelIcon;
  /**
   * La pantalla completa que este panel resume.
   *
   * Va en los dos sentidos: el rail lo usa para decidir si una fila abre panel
   * en vez de navegar, y el panel lo usa para su enlace «Ver todo». Ningún
   * destino desaparece — lo único que cambia es que, estando en el chat, el
   * primer clic ya no cuesta la conversación.
   */
  href: string;
  /**
   * Esta superficie necesita una clave (un cliente, no «los clientes»).
   *
   * El navegador manda `key` como texto. El servidor la pone en `keyField` de
   * la entrada FIJA. Sin `key` no se abre: una ficha sin decir de quién sería
   * un ejecutor con la sesión de quien pulsa.
   */
  keyed?: boolean;
  /** El campo de la entrada donde va la clave. Sólo tiene sentido con `keyed`. */
  keyField?: string;
  /**
   * Un poco más ancha: directorio y ficha merecen el segundo ancho del marco,
   * no un segundo mecanismo. Ver PanelHost.
   */
  wide?: boolean;
}

/**
 * LAS SUPERFICIES DEL MARCO. No quince.
 *
 * El criterio no es «qué pantalla cabe», es qué se pregunta CON el chat delante.
 * Las cinco de lectura de siempre, más el directorio de clientes y la ficha de
 * uno — ésta última parametrizada: el navegador manda el id (o el nombre) de
 * ESTE espacio, nunca el `toolId`.
 *
 * NO ESTÁ `/actions`, que es la OTRA cola de «esperando tu sí», y la diferencia
 * importa: una acción es un borrador ya redactado que se sigue vigilando
 * después de enviarse; una aprobación es una llamada a herramienta PARADA a
 * mitad de vuelo que no se ha ejecutado y que vence. El rail no las fusiona y
 * esto tampoco. Entra la segunda porque es la que tiene la palabra «no se ha
 * hecho todavía» encima, que es lo que uno quiere ver sin soltar el chat.
 *
 * `approvals.list` es de sólo lectura y no tiene compañera que apruebe: eso lo
 * decide la persona en la tarjeta. Ver la cabecera de
 * `packages/agent-tools/src/approvals/tools.ts`, que explica por qué esa
 * herramienta no existe a propósito.
 */
const TABLE = {
  payments: {
    toolId: 'payments.receivables',
    input: {},
    title: 'Cartera',
    icon: Wallet,
    href: '/payments',
  },
  commitments: {
    toolId: 'commitments.due_soon',
    input: { withinDays: 30, includeOverdue: true, limit: 25 },
    title: 'Vencimientos',
    icon: CalendarClock,
    href: '/commitments',
  },
  errands: {
    toolId: 'errands.status',
    input: { includeFinished: true, limit: 8 },
    title: 'Encargos',
    icon: Briefcase,
    href: '/errands',
  },
  reports: {
    toolId: 'reports.list',
    input: { limit: 10 },
    title: 'Informes',
    icon: FileBarChart,
    href: '/reports',
  },
  approvals: {
    toolId: 'approvals.list',
    input: { limit: 10 },
    title: 'Aprobaciones',
    icon: Inbox,
    href: '/approvals',
  },
  clients: {
    toolId: 'clients.directory',
    input: { limit: 40 },
    title: 'Clientes',
    icon: Building2,
    href: '/clients',
    wide: true,
  },
  client: {
    toolId: 'clients.overview',
    input: {},
    title: 'Cliente',
    icon: Building2,
    href: '/clients',
    keyed: true,
    keyField: 'client',
    wide: true,
  },
  trackers: {
    toolId: 'trackers.list',
    input: { limit: 40 },
    title: 'Tablas',
    icon: Table2,
    href: '/trackers',
    wide: true,
  },
  tracker: {
    toolId: 'trackers.query',
    input: { limit: 40 },
    title: 'Tabla',
    icon: Table2,
    href: '/trackers',
    keyed: true,
    keyField: 'tracker',
    wide: true,
  },
} satisfies Record<string, PanelShape>;

export type PanelId = keyof typeof TABLE;
export const PANELS: Record<PanelId, PanelShape> = TABLE;

/** El guardia de la frontera: lo que llega del navegador pasa por aquí. */
export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && Object.hasOwn(PANELS, value);
}

/** Qué panel resume esta pantalla, si alguno. Lo pregunta el rail. */
export function panelForHref(href: string): PanelId | null {
  for (const [id, shape] of Object.entries(PANELS)) {
    // Una ficha parametrizada comparte href con su directorio. El rail abre
    // el directorio; la ficha se abre desde una tarjeta, con clave.
    if (shape.keyed) continue;
    if (shape.href === href) return id as PanelId;
  }
  return null;
}

/**
 * EL PANEL EN LA URL, Y POR QUÉ ES UNA CONSULTA Y NO UN SEGMENTO.
 *
 * `?panel=payments` queda enlazable y sobrevive a un refresco, y se escribe con
 * `window.history.replaceState` — el mismo mecanismo, y por la misma razón
 * documentada, que `ChatRoot.tsx` ya usa para pasar de `/chat` a
 * `/chat/<id>` a mitad de stream. Un segmento de ruta obligaría al router, y el
 * router es exactamente lo que no puede tocar esto.
 */
export const PANEL_PARAM = 'panel';
/** La clave de una superficie parametrizada. Nunca un `toolId`. */
export const PANEL_KEY_PARAM = 'key';

/** Qué panel pide esta búsqueda. `null` cuando no pide ninguno o pide uno que no existe. */
export function panelFromSearch(search: string): PanelId | null {
  const value = new URLSearchParams(search).get(PANEL_PARAM);
  return isPanelId(value) ? value : null;
}

/** La clave que pide esta búsqueda, si hay una. */
export function panelKeyFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get(PANEL_KEY_PARAM);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * La misma búsqueda con el panel puesto o quitado, sin tocar lo demás.
 *
 * Devuelve `''` o `'?...'`, listo para concatenar con `pathname`. Conserva
 * cualquier otro parámetro porque no es suyo: quien abre un panel sobre una
 * pantalla filtrada no ha pedido que se le caiga el filtro.
 */
export function searchWithPanel(
  search: string,
  panel: PanelId | null,
  key?: string | null,
): string {
  const params = new URLSearchParams(search);
  if (panel) {
    params.set(PANEL_PARAM, panel);
    const shape = PANELS[panel];
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (shape.keyed && trimmed) params.set(PANEL_KEY_PARAM, trimmed);
    else params.delete(PANEL_KEY_PARAM);
  } else {
    params.delete(PANEL_PARAM);
    params.delete(PANEL_KEY_PARAM);
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/**
 * La entrada que el servidor le pasa a la herramienta.
 *
 * El navegador nunca la construye: manda un id de superficie y, si aplica, una
 * clave. Aquí se decide qué campo recibe esa clave. Una superficie `keyed` sin
 * clave no se abre — no hay ficha de «nadie».
 */
export function resolvePanelInput(
  id: PanelId,
  key?: string | null,
): { ok: true; input: Record<string, unknown> } | { ok: false; message: string } {
  const panel = PANELS[id];
  if (!panel.keyed) return { ok: true, input: panel.input };
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) return { ok: false, message: 'Falta qué abrir.' };
  if (trimmed.length > 200) return { ok: false, message: 'Eso no cabe como clave.' };
  if (!panel.keyField) return { ok: false, message: 'Esta superficie está mal definida.' };
  return { ok: true, input: { ...panel.input, [panel.keyField]: trimmed } };
}
