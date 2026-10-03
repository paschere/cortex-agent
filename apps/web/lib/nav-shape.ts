import { type ModuleKey, moduleForRoute } from '@cortex/agent-tools/src/modules/catalog';
import {
  AlarmClock,
  BadgeCheck,
  BarChart3,
  BookOpen,
  Briefcase,
  Building2,
  CalendarCheck,
  CalendarClock,
  Database,
  FileBarChart,
  FileSignature,
  FolderKanban,
  Globe,
  HandCoins,
  Handshake,
  Home,
  Hourglass,
  IdCard,
  Inbox,
  Landmark,
  LayoutDashboard,
  LayoutGrid,
  LayoutPanelTop,
  LifeBuoy,
  MessageCircle,
  MessageSquare,
  MoreHorizontal,
  Package,
  PhoneCall,
  Plug,
  Radar,
  Receipt,
  Scale,
  ScrollText,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Table2,
  Target,
  Truck,
  Users,
  UsersRound,
  Wallet,
  Workflow,
} from 'lucide-react';
import { MODULE } from './browser-shape';
import {
  QUEUE_HREF,
  QUEUE_LABEL,
  WAITING_QUEUES,
  type WaitingCounts,
  type WaitingQueue,
  noticeFromCounts,
} from './waiting-shape';

/**
 * EL RAIL, COMO DATO. LA PINTURA ESTÁ EN `components/nav/Sidebar.tsx`.
 *
 * ===========================================================================
 * QUÉ ESTABA MAL, MEDIDO
 * ===========================================================================
 * El rail llegó a 28 destinos, más Plan y Ajustes abajo. No sobraban enlaces:
 * sobraba que fuera el ÍNDICE COMPLETO DEL PRODUCTO ordenado por cómo está
 * construido el producto, en vez de por lo que alguien hace un martes. Veintiocho
 * filas con el mismo peso significan que ninguna destaca, y una persona usa
 * cinco. Tres cosas concretas:
 *
 *   1. CUATRO FILAS ERAN LA MISMA PREGUNTA. `/approvals`, `/commitments`,
 *      `/actions` y `/errands` son cuatro vistas de «¿qué está parado
 *      esperándome?», y `waiting-shape.ts` ya unifica exactamente esas cuatro
 *      para el aviso del chat y para los contadores de este rail. El producto ya
 *      sabía contestarlo de una vez; el rail lo preguntaba cuatro veces.
 *   2. SEIS FILAS ERAN `adminOnly` y una persona normal no las ve jamás. Era la
 *      sección más larga y estaba ahí por un rol, no por una tarea.
 *   3. RUIDO DE JERARQUÍA: `/integrations/whatsapp` es una subpágina ascendida a
 *      fila propia, y `/orchestrator`, `/dev-work`, `/learning` y `/prospects` no
 *      se abren en una semana normal.
 *
 * ===========================================================================
 * LA FORMA NUEVA, Y LO QUE NO CAMBIA
 * ===========================================================================
 * Un bloque corto arriba — Chat, Te espera, Brain Knowledge —, «Todo» con el
 * resto dentro, y «La empresa» aparte y plegada. NO DESAPARECE NI UN DESTINO:
 * siguen estando, y `nav-shape.test.ts` lo comprueba sumando la unión de todo lo
 * que este archivo devuelve. La diferencia es cuántos hay que mirar para
 * encontrar el tuyo. El chat es el producto; Brain Knowledge es el archivo; lo
 * demás se abre desde el chat o desde «Todo».
 *
 * ===========================================================================
 * POR QUÉ ESTO ES UN `.ts` Y NO VIVE EN EL COMPONENTE
 * ===========================================================================
 * Porque la propiedad que de verdad importa —que ningún destino se pierda por el
 * camino— es una propiedad de la ESTRUCTURA, y el runner de pruebas de esta app
 * corre en Node sin DOM (`vitest.config.ts`, `environment: 'node'`). Con la lista
 * dentro del `.tsx` la única manera de comprobarlo sería renderizar, que aquí no
 * se puede; con la lista aquí es una función pura y una prueba de tres líneas.
 * Es la misma disciplina que `actions-shape.ts`, `commitments-shape.ts` o
 * `browser-shape.ts` ya siguen.
 *
 * Los iconos entran porque son componentes sin estado y `panels/shape.ts` ya los
 * importa por lo mismo. Nada de aquí toca la base de datos ni el barril de
 * `@cortex/agent-tools`: el catálogo de módulos (0186) entra por su ruta
 * directa porque es sólo datos, igual que `ledger/forecast-shared`.
 *
 * ===========================================================================
 * LO QUE NO ESTÁ EN EL RAIL, Y CÓMO SE LLEGA
 * ===========================================================================
 * Tres destinos se alcanzan sólo desde la paleta (⌘K, o la fila «Buscar» que
 * está arriba del rail para que la paleta no sea un secreto) y desde una puerta
 * en la pantalla en la que ya estás:
 *
 *   /tools       → desde Inicio («Atajos») y desde la paleta.
 *   /agents      → desde /tools, que es donde vas cuando una herramienta está
 *                  frenada y la respuesta es qué agente puede llamarla.
 *   /evaluation  → desde /learning, en una acción de la cabecera. Son causa y
 *                  medida: una dice qué cambió Cortex de sí mismo, la otra si
 *                  las respuestas mejoraron.
 *   /orchestrator, /dev-work, /mcp-tokens, /learning
 *                → sólo paleta. Son el vocabulario de quien construye Cortex,
 *                  no el del martes. Un gerente colombiano no tiene un
 *                  orquestador; tiene WhatsApp y cartera.
 *
 * /conversations colgaba de la lista de hilos que vivía en este rail. Los hilos
 * se mudaron a la cabecera del propio chat (ver `ThreadHistory`) y el archivo se
 * fue con ellos — es el archivo del chat, no su hermano.
 *
 * ===========================================================================
 * CADA ETIQUETA ES LA PALABRA QUE USA SU PROPIA PANTALLA
 * ===========================================================================
 * Sin traducir a propósito: Chat y WhatsApp se leen igual en español, Brain
 * Knowledge es el nombre del producto para eso, y Conectar Claude nombra un
 * producto ajeno. Los ENCABEZADOS DE SECCIÓN son la excepción y hablan en
 * primera persona: esto se vende como un gerente para tu empresa, no como una
 * caja de herramientas, y el rail es el primer sitio donde esa promesa se hace o
 * se deja caer en silencio. «Automático», «Seguimiento», «Conexiones» son
 * categorías de software; «Lo que hago solo», «Cómo vamos», «De dónde saco todo»
 * son cosas que diría un gerente de su propia semana.
 */

/** Lo poco que un icono necesita ser para que el rail lo dibuje. */
type NavIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

export interface NavItem {
  href: string;
  label: string;
  icon: NavIcon;
  /**
   * Dibuja un contador vivo a la derecha. Son exactamente las cuatro colas de
   * `waiting-shape.ts` — las únicas cuatro pantallas del producto que guardan
   * trabajo parado esperando a una persona.
   */
  signal?: WaitingQueue;
  /**
   * Escondida para todo el mundo menos un admin de la organización.
   *
   * Vivía en la sección, y «La empresa» la llevaba por sus seis filas. Fue
   * verdad hasta que apareció una fila que todo el mundo debería poder ABRIR y
   * sólo un admin CAMBIAR — los datos de la empresa, que son la razón por la que
   * Cortex contesta como contesta. Bajar la bandera un nivel dice lo mismo de
   * las seis viejas y deja que la séptima diga otra cosa.
   */
  adminOnly?: boolean;
}

export interface NavSection {
  id: string;
  label: string;
  items: NavItem[];
}

// ===========================================================================
// EL BLOQUE FIJO: LO QUE SE APRENDE CON LAS MANOS
// ===========================================================================
// Chat, Te espera y Brain Knowledge, en ese orden, siempre. El chat es el
// producto; Brain Knowledge es el archivo de la empresa, la única otra
// superficie de primera. Inicio vive en «Todo»: sigue existiendo, ya no es la
// puerta. Mover un destino al que alguien ya está apuntando con el dedo es el
// peor cambio que se le puede hacer a un menú, y por eso estas filas están
// fuera de cualquier negociación de uso.

/** Sigue existiendo. Ya no es la puerta: `/` autentica hacia `/chat`. */
export const HOME: NavItem = { href: '/dashboard', label: 'Inicio', icon: LayoutDashboard };
export const CHAT: NavItem = { href: '/chat', label: 'Chat', icon: MessageSquare };
/**
 * Llamadas: la sala de las reuniones en las que Cortex está metido AHORA. Va
 * fija debajo del chat porque una llamada en vivo no se busca: se abre y se
 * deja a la vista mientras pasa.
 */
export const CALLS: NavItem = { href: '/calls', label: 'Llamadas', icon: PhoneCall };
export const BRAIN: NavItem = { href: '/kb', label: 'Cerebro', icon: BookOpen };
export const FEED: NavItem = { href: '/feed', label: 'Bandeja de archivos', icon: Inbox };
export const MANAGEMENT: NavItem = { href: '/management', label: 'Gerencia', icon: Briefcase };
export const SETUP: NavItem = { href: '/onboarding', label: 'Puesta en marcha', icon: Settings };
/** Tableros, portales y formularios armados hablando (migración 0156). Fija
 * junto a Chat y Gerencia: enterrada en «Herramientas» nadie la encontraba. */
export const VIEWS: NavItem = { href: '/views', label: 'Vistas', icon: LayoutPanelTop };
export const PINNED: NavItem[] = [SETUP, MANAGEMENT, CHAT, VIEWS, FEED, CALLS, BRAIN];
/** Procesos listos para activar: la puerta del autoservicio. */
export const PROCESSES: NavItem = { href: '/procesos', label: 'Procesos', icon: Sparkles };

const QUEUE_ICON: Record<WaitingQueue, NavIcon> = {
  approvals: Inbox,
  commitments: CalendarClock,
  actions: Send,
  errands: Briefcase,
};

/**
 * LAS CUATRO COLAS, DERIVADAS DE `waiting-shape.ts` Y NO COPIADAS.
 *
 * El orden es el de `WAITING_QUEUES`, que no es alfabético sino DE RELOJ: una
 * aprobación expira en minutos y un encargo atascado lleva días parado. Las
 * etiquetas y los hrefs salen de allí por la misma razón por la que el aviso del
 * chat y el contador del rail salen del mismo conteo — para que no puedan
 * discrepar mientras alguien renombra una pantalla.
 */
export const WAITING_ITEMS: NavItem[] = WAITING_QUEUES.map((queue) => ({
  href: QUEUE_HREF[queue],
  label: QUEUE_LABEL[queue],
  icon: QUEUE_ICON[queue],
  signal: queue,
}));

export const WAITING_LABEL = 'Te espera';
export const WAITING_ICON: NavIcon = Hourglass;

/**
 * A DÓNDE LLEVA LA FILA «TE ESPERA», Y POR QUÉ NO ES UNA PANTALLA NUEVA.
 *
 * A la PRIMERA COLA NO VACÍA en el orden de reloj. Inventar una pantalla que
 * junte las cuatro sería construir un quinto sitio para no elegir entre cuatro;
 * elegir por ese orden no es adivinar, es la misma decisión que
 * `waiting-panel.ts` ya defiende por escrito para el aviso del chat.
 *
 * Con todo vacío lleva a Aprobaciones, que es la primera del orden y cuyo vacío
 * («Nada esperando permiso») es exactamente la respuesta que buscaba quien pulsó
 * una fila sin insignia.
 */
export function waitingHref(counts: WaitingCounts): string {
  return noticeFromCounts(counts).queues[0]?.href ?? QUEUE_HREF[WAITING_QUEUES[0]];
}

// ===========================================================================
// LO QUE VA DENTRO DE «TODO»
// ===========================================================================
// El resto del producto, agrupado. Nada se esconde para siempre: lo que no
// está arriba sigue estando aquí, a un clic. Las plazas ganadas por uso se
// fueron — competían con el chat por la mirada, y el chat es el producto.
export const SECTIONS: NavSection[] = [
  {
    // Clientes es el eje del que cuelga el resto del producto (migración 0075):
    // una pregunta sobre un cliente empieza aquí y se sigue hasta el correo, la
    // reunión o el vencimiento. La cartera vive en su sección financiera.
    id: 'work',
    label: 'Con quién trabajo',
    items: [
      { href: '/clients', label: 'Clientes', icon: Building2 },
      // Cotizaciones → pedidos → facturas electrónicas (0182): lo que se le vende
      // a cada cliente, al lado del cliente.
      { href: '/ventas', label: 'Ventas', icon: Receipt },
      // El embudo comercial (0193): los negocios que vienen, el seguimiento, los
      // clientes que se están yendo y las encuestas.
      { href: '/comercial', label: 'Embudo comercial', icon: Handshake },
      { href: '/trackers', label: 'Tablas', icon: Table2 },
    ],
  },
  {
    // Órdenes de servicio y proyectos (0196): el trabajo que se le hace a cada
    // cliente, con sus horas, costos y margen; y la flota que lo lleva. Sección
    // propia: las dos son de módulos que muchas empresas tienen apagados, y
    // apagadas no dejan el encabezado colgando.
    id: 'operations',
    label: 'Operación',
    items: [
      { href: '/proyectos', label: 'Proyectos', icon: FolderKanban },
      { href: '/flota', label: 'Flota', icon: Truck },
    ],
  },
  {
    id: 'finance',
    label: 'Finanzas',
    items: [
      { href: '/finance', label: 'Resumen financiero', icon: Wallet },
      { href: '/payments', label: 'Cartera y pagos', icon: Wallet },
      // Cuentas por pagar (0181): facturas de proveedor, aprobación y programa de pagos.
      { href: '/pagar', label: 'Por pagar', icon: HandCoins },
      { href: '/inventario', label: 'Inventario y compras', icon: Package },
      // El calendario tributario (0180): las fechas con la DIAN, el ICA y la PILA.
      { href: '/impuestos', label: 'Impuestos', icon: Landmark },
      // Estados financieros, presupuesto e informe para socios (0191).
      { href: '/estados', label: 'Estados financieros', icon: FileBarChart },
      { href: '/presupuesto', label: 'Presupuesto', icon: Target },
      { href: '/informe-socios', label: 'Informe para socios', icon: ScrollText },
    ],
  },
  {
    // Cuatro familias de tablas sin relación entre sí, no cuatro vistas de una.
    // Encargos ya no está aquí: es una de las cuatro colas de «Te espera», que
    // es donde se pregunta por él.
    id: 'automation',
    label: 'Lo que hago solo',
    items: [
      // La etiqueta viene de `browser-shape` para que la pantalla, la paleta y
      // el catálogo de herramientas no puedan separarse mientras el nombre se
      // asienta.
      // Los procesos listos para activar (autoservicio). Es la puerta de la
      // navegación principal; aquí sólo garantiza que «Más» y la paleta la
      // alcancen también.
      PROCESSES,
      { href: '/browser', label: MODULE.label, icon: Globe },
      { href: '/schedules', label: 'Rutinas', icon: AlarmClock },
      { href: '/activations', label: 'Activaciones', icon: BadgeCheck },
      { href: '/pipelines', label: 'Flujos', icon: Workflow },
      // Documentos que vencen (0184): Cortex les lee la fecha a los SOAT,
      // pólizas, licencias y contratos, y avisa solo a quien los renueva.
      { href: '/documentos-vencen', label: 'Documentos que vencen', icon: CalendarClock },
    ],
  },
  {
    // Contratos y cumplimiento (0195): los papeles con obligaciones y la lista
    // societaria y legal, con las PQRS y los procesos judiciales.
    id: 'legal',
    label: 'Legal',
    items: [
      { href: '/contratos', label: 'Contratos', icon: FileSignature },
      { href: '/cumplimiento', label: 'Cumplimiento', icon: Scale },
    ],
  },
  {
    // Leer, no actuar. Todo lo de aquí responde una pregunta sobre un periodo.
    id: 'review',
    label: 'Cómo vamos',
    items: [
      // Inicio bajó de las filas fijas: el chat es la puerta, esto es el
      // recuento de lo que se movió. Sigue existiendo para quien lo busque.
      HOME,
      { href: '/goals', label: 'Metas', icon: Target },
      // El trabajo del equipo (registro de trabajo, 0174). `/team` es la puerta
      // de quien reparte el trabajo; quien no ve al equipo cae en «Mi semana».
      { href: '/team', label: 'Equipo', icon: UsersRound },
      { href: '/team/yo', label: 'Mi semana', icon: CalendarCheck },
      // Nómina con vacaciones y permisos, y SG-SST (0194): la gente de la empresa.
      { href: '/nomina', label: 'Nómina', icon: Wallet },
      { href: '/sst', label: 'SG-SST', icon: ShieldCheck },
      { href: '/reports', label: 'Informes', icon: FileBarChart },
      { href: '/prospects', label: 'Prospectos', icon: Radar },
    ],
  },
  {
    // Brain Knowledge subió al bloque fijo. Aquí quedan las fuentes que se
    // conectan, no el archivo en sí.
    id: 'sources',
    label: 'De dónde saco todo',
    items: [
      { href: '/integrations', label: 'Datos y conexiones', icon: Plug },
      { href: '/integrations/whatsapp', label: 'WhatsApp', icon: MessageCircle },
    ],
  },
];

/**
 * ADMINISTRACIÓN, APARTE Y PLEGADA.
 *
 * Seis de sus siete filas son sólo de admin, así que para la mayoría de la gente
 * esta sección era la más larga del rail y estaba entera vacía. Fuera de «Todo»
 * y no dentro porque no es «el resto del producto»: es otra conversación, la de
 * cómo está montada la empresa, y quien la abre no está buscando una pantalla
 * cualquiera.
 *
 * El grupo se dibuja igual para todo el mundo aunque a un no-admin le quede una
 * sola fila dentro. El rail tiene la misma forma para toda la empresa, que es lo
 * que permite que alguien le diga a otro «está en La empresa» y acierte.
 */
export const COMPANY: NavSection = {
  id: 'company',
  label: 'La empresa',
  items: [
    // LA ÚNICA FILA DE ESTA SECCIÓN QUE VE TODO EL MUNDO, Y ESTÁ ARGUMENTADO.
    //
    // Lo que hay detrás no es una pantalla de administración: es lo que Cortex
    // cree sobre la empresa, y va entero en cada respuesta que le da a
    // cualquiera. Esconderlo de quien no es admin esconde la EXPLICACIÓN de las
    // respuestas que esa persona recibe todo el día — y deja como única salida
    // preguntárselo al propio Cortex, que es justo el testigo cuya versión se
    // querría contrastar.
    //
    // Escribir sí es de admin, y eso se hace cumplir en el servidor (la página y
    // sus acciones comprueban el rol), no escondiendo el enlace.
    { href: '/company', label: 'Datos de la empresa', icon: IdCard },
    { href: '/admin/users', label: 'Personas', icon: Users, adminOnly: true },
    { href: '/admin/teams', label: 'Equipos', icon: UsersRound, adminOnly: true },
    { href: '/admin/usage', label: 'Uso', icon: BarChart3, adminOnly: true },
    { href: '/admin/audit', label: 'Auditoría', icon: ScrollText, adminOnly: true },
    { href: '/admin/security', label: 'Seguridad', icon: ShieldCheck, adminOnly: true },
    // Lo que Cortex puede hacer sin preguntar. Vive junto a Seguridad porque es
    // la misma conversación vista desde el otro lado: una dice qué se le impidió,
    // la otra qué se le permitió de antemano.
    { href: '/admin/mandates', label: 'Sin preguntar', icon: BadgeCheck, adminOnly: true },
  ],
};

export const COMPANY_ICON: NavIcon = Landmark;
export const ALL_LABEL = 'Todo';
export const ALL_ICON: NavIcon = MoreHorizontal;

/**
 * El pie del rail, FUERA de la zona que scrollea.
 *
 * Plan y consumo va al lado de Ajustes y no dentro de La empresa: lo que un
 * espacio de trabajo lleva gastado y lo que está a punto de agotarse no es el
 * informe de un administrador, es lo que necesita encontrar cualquiera que se
 * pregunte «¿por qué se paró Cortex?».
 */
export const FOOTER: NavItem[] = [
  { href: '/plan', label: 'Plan y consumo', icon: Receipt },
  { href: '/settings', label: 'Ajustes', icon: Settings },
  // El centro de ayuda (y «Escribir a soporte»). Al pie, junto a Ajustes: es
  // a donde se va cuando algo no se entiende, en cualquier pantalla. La ayuda
  // de la pantalla abierta está además en el «?» de la barra de arriba.
  { href: '/ayuda', label: 'Ayuda', icon: LifeBuoy },
];

/** Destinos que podrían haber subido al bloque fijo. El rail ya no los sube. */
export const QUICK_CANDIDATES: NavItem[] = SECTIONS.flatMap((section) => section.items);

/**
 * Vacío a propósito. El bloque ganado por uso competía con el chat por la
 * mirada, y el chat es el producto. `buildRail` sigue aceptando una lista para
 * no romper las pruebas de que un destino no se pierde si alguien la pasa; el
 * rail dibuja siempre `[]`.
 */
export const DEFAULT_QUICK: string[] = [];

// ===========================================================================
// MÓDULOS APAGADOS (0186)
// ===========================================================================
// Una empresa que apagó un módulo no ve sus pantallas en ningún menú. La lista
// llega del servidor (una lectura en el shell) como arreglo de claves, que es
// lo que se puede pasar a un componente cliente. Vacía = nada se esconde, que
// es lo que dibuja `everyDestination` para la prueba de cobertura.

/** ¿Este destino se ve con estos módulos apagados? Lo que no es de ningún módulo, siempre. */
export function routeVisible(href: string, modulesOff: readonly ModuleKey[] = []): boolean {
  if (modulesOff.length === 0) return true;
  const m = moduleForRoute(href.split('?')[0] ?? href);
  return !m || !modulesOff.includes(m.key);
}

function visibleItems<T extends { href: string }>(
  items: readonly T[],
  modulesOff: readonly ModuleKey[],
): T[] {
  return items.filter((item) => routeVisible(item.href, modulesOff));
}

/** El rail entero, ya resuelto: lo que el componente sólo tiene que dibujar. */
export interface Rail {
  /** Chat y Brain Knowledge. La fila «Te espera» va detrás y la arma el componente. */
  pinned: NavItem[];
  /** Las cuatro colas, dentro del desplegable de «Te espera». */
  waiting: NavItem[];
  /** Las plazas ganadas, en el orden diseñado y no en el del ranking. */
  quick: NavItem[];
  /** Lo que queda, dentro de «Todo». Sin las secciones que se quedaron vacías. */
  rest: NavSection[];
  /** Cuántos destinos hay dentro de «Todo». Es lo que dibuja su cifra. */
  restCount: number;
  /** «La empresa», ya filtrada por rol. */
  company: NavSection;
  footer: NavItem[];
}

/**
 * El rail para esta persona.
 *
 * PURA. `quick` viene de fuera (lo decide `nav-usage.ts` con lo que hay en el
 * navegador) porque esta función no puede leer `localStorage`: la dibuja también
 * el servidor, y el primer pintado tiene que ser el orden diseñado.
 *
 * El bloque ganado se devuelve EN EL ORDEN DISEÑADO, no en el del ranking. Que
 * un destino esté arriba lo decide el uso; en qué posición aparece, no. Si el
 * orden siguiera al ranking, las cinco filas cambiarían de sitio entre sí cada
 * pocos clics y el bloque dejaría de poder aprenderse — que es justo lo que este
 * rail intenta comprar.
 */
export function buildRail(
  quick: string[],
  admin: boolean,
  /** Módulos que la empresa apagó (0186): sus pantallas no salen. */
  modulesOff: readonly ModuleKey[] = [],
): Rail {
  const chosen = new Set(quick);
  const rest = SECTIONS.map((section) => ({
    ...section,
    items: visibleItems(section.items, modulesOff).filter((item) => !chosen.has(item.href)),
  })).filter((section) => section.items.length > 0);

  return {
    pinned: visibleItems(PINNED, modulesOff),
    waiting: WAITING_ITEMS,
    quick: visibleItems(QUICK_CANDIDATES, modulesOff).filter((item) => chosen.has(item.href)),
    rest,
    restCount: rest.reduce((n, section) => n + section.items.length, 0),
    company: {
      ...COMPANY,
      items: visibleItems(COMPANY.items, modulesOff).filter((i) => !i.adminOnly || admin),
    },
    footer: visibleItems(FOOTER, modulesOff),
  };
}

/** Cada destino que el rail alcanza, para quien pueda verlos todos. */
export function everyDestination(): string[] {
  const rail = buildRail([], true);
  return [
    ...rail.pinned,
    ...rail.waiting,
    ...rail.rest.flatMap((s) => s.items),
    ...rail.company.items,
    ...rail.footer,
  ].map((item) => item.href);
}

// ===========================================================================
// LA NAVEGACIÓN PRINCIPAL DEL AUTOSERVICIO
// ===========================================================================
// El diseño de autoservicio ordena el producto por lo que alguien hace, no por
// cómo está construido: Inicio, Chat, Procesos, Vistas, Datos y Equipo. Seis
// puertas grandes arriba del rail (y cuatro en la barra del teléfono). Todo lo
// demás — las colas de «Te espera», finanzas, fuentes, herramientas, la
// administración — sigue entero en «Más» y en la paleta: esta lista NO
// sustituye a `buildRail`, se pinta encima.
//
// `match` dice qué direcciones encienden la puerta. «Datos» no es una pantalla
// sino un grupo — tablas, feed, Brain Knowledge e integraciones — y aterriza en
// Integraciones, que es donde se conecta lo que luego aparece en las otras tres.

export interface PrimaryItem extends NavItem {
  /** Prefijos (en frontera de segmento) que marcan esta puerta como activa. */
  match: string[];
}

export const DATA: NavItem = { href: '/integrations', label: 'Datos', icon: Database };

export function primaryNav({
  admin,
  founder,
  modulesOff = [],
}: {
  /** Admin de la organización: Equipo abre cómo va el trabajo de todo el equipo. */
  admin: boolean;
  /** Fundador de una empresa: también ve a todo el equipo. */
  founder: boolean;
  /** Módulos que la empresa apagó (0186): sus puertas no salen. */
  modulesOff?: readonly ModuleKey[];
}): PrimaryItem[] {
  // Todos tienen Equipo: quien reparte el trabajo ve al equipo entero (/team,
  // con «Personas y accesos» en su cabecera); los demás, «Mi semana».
  // Con el módulo Equipo apagado, quien administra sigue teniendo la puerta a
  // las personas y sus accesos; a los demás se les va.
  const team = modulesOff.includes('team')
    ? admin
      ? '/admin/users'
      : '/team/yo'
    : admin || founder
      ? '/team'
      : '/team/yo';
  return visibleItems<PrimaryItem>(
    [
      { ...HOME, icon: Home, match: ['/dashboard'] },
      { ...CHAT, match: ['/chat'] },
      { ...PROCESSES, match: ['/procesos'] },
      { ...VIEWS, match: ['/views'] },
      { ...DATA, match: ['/integrations', '/trackers', '/feed', '/kb'] },
      { href: team, label: 'Equipo', icon: Users, match: ['/admin', '/team'] },
    ],
    modulesOff,
  );
}

/** ¿Esta dirección enciende esta puerta? `/chat/global` es la consola multiempresa, no el chat. */
export function primaryActive(path: string, item: PrimaryItem): boolean {
  if (item.href === '/chat' && path.startsWith('/chat/global')) return false;
  return item.match.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

// ===========================================================================
// «MÁS», CORTO
// ===========================================================================
// «Más» llegó a tener unas treinta filas en siete grupos: todo el producto
// colgado de un desplegable, que para alguien que empieza es lo mismo que no
// tener menú. Ahora lleva sólo lo que se usa en la semana, en tres grupos
// cortos, y una salida a la paleta (⌘K), que sigue alcanzando TODAS las
// pantallas (`everyDestination` y el test de cobertura no cambian: la paleta
// se arma con `SECTIONS`, no con esto).
//
// Fuera de «Más» (paleta, y la puerta en su propia pantalla): resumen
// financiero, navegador, rutinas (viven en Procesos), activaciones, flujos,
// informes, prospectos, chat multiempresa, notificaciones (campana arriba).

export interface MoreGroup {
  id: string;
  label: string;
  items: NavItem[];
}

const ALL_ITEMS: NavItem[] = [
  ...PINNED,
  ...SECTIONS.flatMap((s) => s.items),
  ...COMPANY.items,
  ...FOOTER,
];

function pick(hrefs: string[]): NavItem[] {
  return hrefs.flatMap((href) => ALL_ITEMS.find((item) => item.href === href) ?? []);
}

export function moreGroups({
  admin,
  founder,
  modulesOff = [],
}: {
  admin: boolean;
  /** Dueño de al menos una empresa: ve el centro de mando de todas. */
  founder: boolean;
  /** Módulos que la empresa apagó (0186): sus pantallas no salen. */
  modulesOff?: readonly ModuleKey[];
}): MoreGroup[] {
  const groups: MoreGroup[] = [
    {
      id: 'work',
      label: 'Mi trabajo',
      items: [
        // El lanzador de módulos (/areas): nómina, contratos, estados, proyectos…
        // se encuentran ahí sin alargar este menú.
        { href: '/areas', label: 'Todas las áreas', icon: LayoutGrid },
        ...pick(['/management', '/clients', '/payments', '/goals', '/calls']),
      ],
    },
    {
      id: 'data',
      label: 'Mis datos',
      items: pick(['/trackers', '/kb', '/feed', '/integrations/whatsapp']),
    },
    {
      id: 'company',
      label: 'La empresa',
      items: [
        ...pick(['/onboarding', '/company']),
        ...(founder ? [{ href: '/overview', label: 'Todas mis empresas', icon: Landmark }] : []),
        ...pick(['/plan']),
      ],
    },
  ];
  if (admin) {
    groups.push({
      id: 'admin',
      label: 'Administración',
      items: pick([
        '/admin/security',
        '/admin/mandates',
        '/admin/usage',
        '/admin/audit',
        '/admin/teams',
      ]),
    });
  }
  return groups
    .map((g) => ({ ...g, items: visibleItems(g.items, modulesOff) }))
    .filter((g) => g.items.length > 0);
}
