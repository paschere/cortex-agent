import { Briefcase, CalendarClock, FileBarChart, Inbox, Wallet } from 'lucide-react';

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
 * una de cinco palabras cerradas — y el servidor lo resuelve CONTRA ESTA TABLA
 * antes de tocar nada. Un cliente que pudiera nombrar la herramienta podría
 * nombrar `gmail.send_message`.
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
}

/**
 * LOS CINCO DE v1. No quince.
 *
 * El criterio no es «qué pantalla cabe», es qué se pregunta CON el chat delante:
 * lo que se debe, lo que vence, lo que Cortex está haciendo solo, lo que ya se
 * calculó y lo que espera un sí. Todas son de lectura y todas contestan en una
 * sola llamada.
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
export const PANELS = {
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
} satisfies Record<string, PanelShape>;

export type PanelId = keyof typeof PANELS;

/** El guardia de la frontera: lo que llega del navegador pasa por aquí. */
export function isPanelId(value: unknown): value is PanelId {
  return typeof value === 'string' && Object.hasOwn(PANELS, value);
}

/** Qué panel resume esta pantalla, si alguno. Lo pregunta el rail. */
export function panelForHref(href: string): PanelId | null {
  for (const [id, shape] of Object.entries(PANELS)) {
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

/** Qué panel pide esta búsqueda. `null` cuando no pide ninguno o pide uno que no existe. */
export function panelFromSearch(search: string): PanelId | null {
  const value = new URLSearchParams(search).get(PANEL_PARAM);
  return isPanelId(value) ? value : null;
}

/**
 * La misma búsqueda con el panel puesto o quitado, sin tocar lo demás.
 *
 * Devuelve `''` o `'?...'`, listo para concatenar con `pathname`. Conserva
 * cualquier otro parámetro porque no es suyo: quien abre un panel sobre una
 * pantalla filtrada no ha pedido que se le caiga el filtro.
 */
export function searchWithPanel(search: string, panel: PanelId | null): string {
  const params = new URLSearchParams(search);
  if (panel) params.set(PANEL_PARAM, panel);
  else params.delete(PANEL_PARAM);
  const query = params.toString();
  return query ? `?${query}` : '';
}
