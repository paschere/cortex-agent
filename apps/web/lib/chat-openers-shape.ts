/**
 * LA PRIMERA PANTALLA DEL CHAT, SEMBRADA CON LO QUE ESTA EMPRESA REALMENTE TIENE.
 *
 * ===========================================================================
 * QUÉ PROBLEMA RESUELVE
 * ===========================================================================
 * La pantalla vacía tenía seis tarjetas escritas a mano que no miraban nada:
 * le proponían consultar el RUNT a un espacio sin ese servicio configurado y
 * preguntar por la última llamada a uno que nunca grabó una. La primera
 * pregunta que alguien hace decide si el producto se entiende o no, y una
 * sugerencia genérica la desperdicia.
 *
 * Así que las sugerencias se SIEMBRAN, en este orden de preferencia:
 *
 *   1. Preguntas cuya respuesta YA EXISTE. El documento más reciente por su
 *      nombre real, el cliente por su nombre, el vencimiento que está más
 *      cerca. Una sugerencia que cita algo que la persona reconoce es de otra
 *      categoría frente a «pregúntame sobre tus contratos».
 *   2. Lo que el espacio PUEDE hacer y todavía no ha tocado, filtrado por
 *      integraciones conectadas y permisos reales.
 *   3. Nunca algo que va a fallar. Es peor que no sugerir nada: promete y falla
 *      después de que la persona ya invirtió su primera pregunta.
 *
 * ===========================================================================
 * CERO LLAMADAS AL MODELO
 * ===========================================================================
 * Esta pantalla se abre constantemente y tiene que ser instantánea y gratis.
 * Todo lo de aquí son REGLAS sobre filas reales: unas cuantas lecturas
 * acotadas a Supabase en paralelo y este archivo, que es una función pura. No
 * hay generación, no hay embeddings, no hay tokens. Un LLM redactando seis
 * tarjetas costaría dinero y medio segundo cada vez que alguien abre un chat
 * nuevo, para producir frases peores que estas: el modelo no sabe cómo se
 * llama el contrato que subieron ayer, y estas reglas sí.
 *
 * ===========================================================================
 * POR QUÉ VIVE EN `lib/` Y NO DENTRO DE LA RUTA
 * ===========================================================================
 * Dos razones y las dos importan. La primera es que `EmptyState.tsx` es
 * `'use client'` y necesita los TIPOS; importarlos desde un `route.ts` no se
 * puede, y importar `@cortex/agent-tools` desde el cliente arrastra
 * `node:dns/promises` y rompe el build de producción sin que `typecheck` ni
 * `test` digan nada (misma trampa documentada en `chat-palette-shape.ts`). La
 * segunda es que la SELECCIÓN es donde vive todo lo que puede salir mal sin que
 * se vea —una sugerencia ofrecida a quien no tiene la herramienta, seis
 * tarjetas del mismo tema, una pantalla vacía dibujada por un error de base de
 * datos— y eso se prueba en Node, no a ojo.
 */

// ---------------------------------------------------------------------------
// Lo que sale por el cable
// ---------------------------------------------------------------------------

export type OpenerTone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';

export interface Opener {
  /** Estable dentro de una respuesta; sólo sirve para el `key` de React. */
  id: string;
  /** La pregunta tal cual aterriza en el compositor. Siempre completa. */
  text: string;
  /** De dónde salió, en una línea: «Brain Knowledge · hace 2 días». */
  hint: string | null;
  /** Nombre de un icono de lucide; el cliente lo resuelve a un componente. */
  icon: string;
  tone: OpenerTone;
  /**
   * `grounded` cita una fila que existe en este espacio de trabajo;
   * `capability` ofrece algo que el espacio puede hacer. La distinción se
   * dibuja: una tarjeta que nombra un documento de la empresa merece decir que
   * lo está nombrando.
   */
  kind: 'grounded' | 'capability';
}

/** Un primer paso concreto para un espacio que todavía no tiene nada. */
export interface FirstStep {
  id: string;
  label: string;
  blurb: string;
  href: string;
  icon: string;
}

export interface OpenersResponse {
  openers: Opener[];
  /**
   * El espacio no tiene contenido NI fuentes conectadas. No es lo mismo que
   * `openers.length === 0`: una lectura que falla también deja la lista corta,
   * y ahí `blank` es falso y `notice` lo dice.
   */
  blank: boolean;
  /** Sólo cuando `blank`. Qué hacer primero, con el enlace donde se hace. */
  firstSteps: FirstStep[];
  /** Qué no se pudo leer. Null cuando todo se leyó bien. */
  notice: string | null;
}

// ---------------------------------------------------------------------------
// Lo que entra: las filas de este espacio de trabajo, ya normalizadas
// ---------------------------------------------------------------------------

export interface DocumentSeed {
  id: string;
  title: string;
  /** ISO. Se dibuja en relativo. */
  createdAt: string;
  /** `text`, `audio` o `meeting`. Una reunión no se pregunta como un contrato. */
  mediaKind: string;
}

export interface ClientSeed {
  id: string;
  name: string;
  city: string | null;
}

export interface CommitmentSeed {
  id: string;
  title: string;
  /** `YYYY-MM-DD`. */
  dueOn: string;
  kind: string;
  counterparty: string | null;
}

export interface VehicleSeed {
  id: string;
  plate: string;
  label: string | null;
}

export interface ReportSeed {
  id: string;
  title: string;
}

export interface FlowSeed {
  slug: string;
  name: string;
}

export interface OpenerSeeds {
  /** El día de hoy en Bogotá, `YYYY-MM-DD`. Ver `bogotaToday()`. */
  today: string;
  /** El nombre de la empresa. Null cuando el espacio no tiene título propio. */
  orgName: string | null;
  documents: DocumentSeed[];
  clients: ClientSeed[];
  commitments: CommitmentSeed[];
  vehicles: VehicleSeed[];
  reports: ReportSeed[];
  flows: FlowSeed[];
  /** Cuántas rutinas ya existen. Sólo se usa para no proponer crear la primera. */
  routineCount: number;
  /** Lo que esta persona, con este agente, puede ejecutar de verdad. */
  usableToolIds: string[];
  /** Proveedores OAuth conectados. Sólo decide si el espacio está en blanco. */
  connectedProviders: string[];
  /** Familias de herramienta ya usadas últimamente; se posponen en el nivel 2. */
  usedFamilies: string[];
  /** Secciones que no se pudieron leer, nombradas en español. */
  failed: string[];
}

/** Cuántas tarjetas caben antes de que la pantalla deje de ser una invitación. */
export const OPENER_LIMIT = 6;

// ---------------------------------------------------------------------------
// Fechas dichas como las diría una persona
// ---------------------------------------------------------------------------

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const DAY_MS = 86_400_000;

/**
 * Días entre dos días de calendario `YYYY-MM-DD`. Negativo si el segundo ya
 * pasó. Se compara a medianoche UTC A PROPÓSITO: ambas fechas son días de
 * calendario, no instantes, así que la zona ya se aplicó al calcular `today`
 * (ver `bogotaToday()`) y volver a aplicarla aquí sería aplicarla dos veces.
 */
export function daysUntil(dueOn: string, today: string): number {
  const a = Date.parse(`${today}T00:00:00Z`);
  const b = Date.parse(`${dueOn}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.NaN;
  return Math.round((b - a) / DAY_MS);
}

/** `2026-09-03` → `3 de septiembre`. Sin `toLocaleDateString`: es determinista. */
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d || m < 1 || m > 12) return iso;
  return `${d} de ${MONTHS[m - 1]}`;
}

/**
 * «se vence mañana», «se venció hace 3 días», «se vence el 14 de octubre».
 *
 * Una fecha suelta («vence el 2026-10-14») obliga a restar mentalmente, y una
 * tarjeta que hay que descifrar no invita a nada.
 */
export function dueLabel(dueOn: string, today: string): string {
  const left = daysUntil(dueOn, today);
  if (Number.isNaN(left)) return `vence el ${dueOn}`;
  if (left === 0) return 'se vence hoy';
  if (left === 1) return 'se vence mañana';
  if (left === -1) return 'se venció ayer';
  if (left < 0) return `se venció hace ${Math.abs(left)} días`;
  if (left <= 30) return `se vence en ${left} días`;
  return `se vence el ${longDate(dueOn)}`;
}

/**
 * «hoy», «ayer», «hace 5 días», o la fecha. Deliberadamente más grueso que
 * `relativeTime`: en una tarjeta que ya lleva el nombre del documento, la hora
 * exacta es ruido.
 */
export function ageLabel(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const days = Math.floor((now - then) / DAY_MS);
  if (days <= 0) return 'de hoy';
  if (days === 1) return 'de ayer';
  if (days < 30) return `de hace ${days} días`;
  return `del ${longDate(new Date(then).toISOString().slice(0, 10))}`;
}

// ---------------------------------------------------------------------------
// Nivel 1: preguntas cuya respuesta ya existe
// ---------------------------------------------------------------------------

/**
 * Un candidato antes de saber si sobrevive el filtro de permisos.
 *
 * `requires` es la parte que hace cumplir la regla 3. Una tarjeta que nombra el
 * contrato de Coltrans es inútil si `kb.search` está bloqueada para esta
 * persona: la pregunta se manda, el agente no tiene con qué contestarla, y la
 * primera impresión del producto es un «no puedo». Así que cada candidato
 * declara qué necesita y no se dibuja si falta.
 */
interface Candidate extends Opener {
  requires: string[];
  /** Familia visual: como mucho dos tarjetas del mismo tema. */
  slot: string;
}

/**
 * Qué herramienta contesta cada familia de sugerencia sembrada.
 *
 * Está aquí, en una tabla y no repartido por los constructores, porque es lo
 * único de este archivo que puede quedar desactualizado en silencio: si mañana
 * `clients.overview` se renombra, la tarjeta del cliente seguiría dibujándose y
 * seguiría sin poder ejecutarse. `chat-openers.test.ts` compara esta tabla
 * contra `listTools()` y falla el día que un id deje de existir.
 */
export const GROUNDED_REQUIRES = {
  documentos: ['kb.search'],
  clientes: ['clients.overview'],
  vencimientos: ['commitments.due_soon'],
  vehiculos: ['vehicles.get'],
  informes: ['reports.open'],
  tramites: ['browser.run_flow'],
} as const;

/** El SOAT y la tecnomecánica se nombran; el resto se dice por su título. */
const COMMITMENT_KIND_LABEL: Record<string, string> = {
  soat: 'SOAT',
  rtm: 'Tecnomecánica',
  contract: 'Contrato',
  policy: 'Póliza',
  warranty: 'Garantía',
  customs: 'Plazo de aduana',
  payment: 'Pago',
  other: 'Compromiso',
};

/**
 * Un título de archivo, dicho como lo diría una persona.
 *
 * ===========================================================================
 * EL PROBLEMA, TAL CUAL SE VEÍA
 * ===========================================================================
 * La primera tarjeta de la primera pantalla del producto decía, textualmente:
 *
 *     «¿En qué quedamos en "Grabación — Aug 12, 2026, 8:57 PM.webm"? Dime
 *      quién quedó con qué y para cuándo.»
 *
 * Tres renglones, y dos de ellos ocupados por el nombre que le puso el
 * grabador: mes en inglés, hora en formato de doce y la extensión del
 * contenedor de vídeo. Nadie llama así a una reunión. Y lo peor es que la
 * frase humana YA ESTABA en la misma tarjeta, en la línea de procedencia, que
 * decía «de ayer».
 *
 * ===========================================================================
 * QUÉ HACE, Y QUÉ NO SE PERMITE HACER
 * ===========================================================================
 * La extensión se cae siempre: en una pregunta escrita en español no hay
 * ningún caso en que `.webm` o `.pdf` aporte algo.
 *
 * Y cuando lo que queda es un nombre AUTOMÁTICO —el que ponen Meet, Zoom,
 * Teams o el grabador del teléfono, reconocible porque empieza por su palabra
 * y lleva una fecha dentro— la pregunta pasa a nombrar la reunión por su edad
 * («la reunión de ayer»), que es como la nombraría cualquiera de los que
 * estuvieron en ella.
 *
 * NO INVENTA NUNCA UN TÍTULO. Si alguien subió «Acta comité de compras», eso
 * es lo que dice la tarjeta: un nombre puesto a mano es información, y
 * sustituirlo por «la reunión de ayer» sería tirar la única palabra que
 * distingue una de otra. Y el nombre real no se pierde en ningún caso — pasa
 * a la línea de procedencia, que es donde el sistema de diseño manda poner de
 * dónde salió un dato.
 */
const AUTO_RECORDING =
  /^(grabaci[óo]n|recording|zoom|gmt\d|meet|teams|audio|video|whatsapp|voice)\b/i;

export function humanDocTitle(title: string): string {
  return title.replace(/\.(webm|mp[34]|m4a|wav|ogg|mov|pdf|docx?|pptx?|txt|md)$/i, '').trim();
}

/** Si el nombre lo puso una máquina y encima lleva una fecha dentro. */
function looksAutoNamed(title: string): boolean {
  const clean = humanDocTitle(title);
  return AUTO_RECORDING.test(clean) && /\d{1,4}[-/. ]|\d{1,2}:\d{2}/.test(clean);
}

/** Los dos primeros de cada cosa, cada uno con la frase de su tipo. */
function groundedByFamily(seeds: OpenerSeeds): Candidate[][] {
  const documents: Candidate[] = [];
  for (const doc of seeds.documents.slice(0, 2)) {
    const meeting = doc.mediaKind === 'meeting' || doc.mediaKind === 'audio';
    const clean = humanDocTitle(doc.title);
    const age = ageLabel(doc.createdAt);
    // Sólo se sustituye cuando hay las dos cosas: un nombre puesto por una
    // máquina Y una edad que decir. Sin edad no hay con qué nombrarla, y
    // entonces vale más el nombre feo que ninguno.
    const named = meeting && looksAutoNamed(doc.title) && age ? `la reunión ${age}` : `«${clean}»`;
    documents.push({
      id: `doc:${doc.id}`,
      // Una reunión no se pregunta como un contrato: de una se quiere el
      // acuerdo y de la otra las obligaciones, y preguntar al revés devuelve
      // una respuesta correcta que no le sirve a nadie.
      text: meeting
        ? `¿En qué quedamos en ${named}? Dime quién quedó con qué y para cuándo.`
        : `Resúmeme «${clean}» y dime qué fechas y obligaciones quedan de ahí, citando de dónde sale cada una.`,
      // El nombre real vive aquí cuando la pregunta dejó de decirlo: la
      // procedencia es exactamente el sitio donde va lo que el producto no se
      // inventó, y así nadie pierde de vista QUÉ archivo se va a leer.
      hint:
        meeting && named.startsWith('la reunión')
          ? `${clean} · Brain Knowledge`
          : `${meeting ? 'Reunión' : 'Documento'} en Brain Knowledge · ${age}`,
      icon: meeting ? 'Mic' : 'FileText',
      tone: meeting ? 'sky' : 'primary',
      kind: 'grounded',
      requires: [...GROUNDED_REQUIRES.documentos],
      slot: 'documentos',
    });
  }

  const clients: Candidate[] = seeds.clients.slice(0, 2).map((client) => ({
    id: `client:${client.id}`,
    text: `Dame el panorama completo de ${client.name}: qué le hemos hecho, qué se le vence y qué quedó pendiente.`,
    hint: ['Cliente', client.city].filter(Boolean).join(' · '),
    icon: 'Building2',
    tone: 'amber' as const,
    kind: 'grounded' as const,
    requires: [...GROUNDED_REQUIRES.clientes],
    slot: 'clientes',
  }));

  const commitments: Candidate[] = seeds.commitments.slice(0, 2).map((c) => {
    const label = COMMITMENT_KIND_LABEL[c.kind] ?? COMMITMENT_KIND_LABEL.other;
    const late = daysUntil(c.dueOn, seeds.today) < 0;
    return {
      id: `commitment:${c.id}`,
      // Un vencimiento que ya pasó no se pregunta en futuro. «Qué tengo que
      // hacer antes» sobre algo que venció el martes es una frase que delata
      // que nadie leyó la fecha, justo en la tarjeta cuyo valor es la fecha.
      text: late
        ? `«${c.title}» ${dueLabel(c.dueOn, seeds.today)}. ¿De dónde salió esa fecha y qué hago ahora?`
        : `«${c.title}» ${dueLabel(c.dueOn, seeds.today)}. ¿De dónde salió esa fecha y qué tengo que hacer antes?`,
      hint: [label, c.counterparty].filter(Boolean).join(' · '),
      icon: 'CalendarClock',
      tone: late ? ('rose' as const) : ('amber' as const),
      kind: 'grounded' as const,
      requires: [...GROUNDED_REQUIRES.vencimientos],
      slot: 'vencimientos',
    };
  });

  const vehicles: Candidate[] = seeds.vehicles.slice(0, 1).map((v) => ({
    id: `vehicle:${v.id}`,
    text: `¿Cómo está la placa ${v.plate}? SOAT, tecnomecánica y comparendos.`,
    hint: ['Vehículo vigilado', v.label].filter(Boolean).join(' · '),
    icon: 'Car',
    tone: 'emerald' as const,
    kind: 'grounded' as const,
    requires: [...GROUNDED_REQUIRES.vehiculos],
    slot: 'vehiculos',
  }));

  const reports: Candidate[] = seeds.reports.slice(0, 1).map((r) => ({
    id: `report:${r.id}`,
    text: `Ábreme el informe «${r.title}» y dime qué cambió desde que se calculó.`,
    hint: 'Informe guardado',
    icon: 'BarChart3',
    tone: 'primary' as const,
    kind: 'grounded' as const,
    requires: [...GROUNDED_REQUIRES.informes],
    slot: 'informes',
  }));

  const flows: Candidate[] = seeds.flows.slice(0, 1).map((f) => ({
    id: `flow:${f.slug}`,
    text: `Corre el trámite «${f.name}» y cuéntame qué trajo.`,
    hint: 'Trámite ya aprendido',
    icon: 'Globe',
    tone: 'amber' as const,
    kind: 'grounded' as const,
    requires: [...GROUNDED_REQUIRES.tramites],
    slot: 'tramites',
  }));

  // El orden de las familias es el orden en que se ven las primeras tarjetas.
  // Documentos primero porque es lo que más gente reconoce de un vistazo.
  return [documents, clients, commitments, vehicles, reports, flows];
}

/**
 * Una de cada familia antes de la segunda de ninguna.
 *
 * Sin esto, un espacio con veinte documentos y tres clientes abría con dos
 * tarjetas de documentos seguidas y el cliente nunca salía — y la variedad es
 * media pantalla: seis tarjetas del mismo tema no enseñan lo que el producto
 * hace, enseñan lo que hace con una tabla.
 */
function roundRobin(families: Candidate[][]): Candidate[] {
  const out: Candidate[] = [];
  const depth = Math.max(0, ...families.map((f) => f.length));
  for (let i = 0; i < depth; i++) {
    for (const family of families) {
      const item = family[i];
      if (item) out.push(item);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Nivel 2: lo que el espacio puede hacer y todavía no ha tocado
// ---------------------------------------------------------------------------

/**
 * Cuándo una sugerencia de capacidad tiene DERECHO a existir.
 *
 * `requires` ya garantiza que la herramienta se puede ejecutar; esto garantiza
 * que va a encontrar algo. «Hazme el informe de vencimientos» sobre un espacio
 * sin un solo vencimiento es exactamente la regla 3: una herramienta que corre
 * bien y devuelve nada, que es la peor de las respuestas porque parece un
 * error del producto.
 */
export type OpenerGate = 'always' | 'hasCommitments' | 'noRoutines' | 'hasOrgName';

interface CapabilityOpener {
  id: string;
  /** `{empresa}` se reemplaza por el nombre del espacio de trabajo. */
  text: string;
  hint: string;
  icon: string;
  tone: OpenerTone;
  requires: string[];
  gate: OpenerGate;
  /** Como mucho una tarjeta por tema, aunque haya tres herramientas del tema. */
  slot: string;
}

/**
 * Escrito como lo diría alguien de la empresa, no como el nombre de la
 * herramienta. «Muéstrame los eventos del calendario» es documentación de una
 * API; «¿qué reuniones tengo esta semana?» es una pregunta.
 *
 * El orden es el orden en que se rellenan los huecos que el nivel 1 dejó.
 */
export const CAPABILITY_OPENERS: CapabilityOpener[] = [
  {
    id: 'cap:inbox',
    text: '¿Qué tengo pendiente en el correo hoy y qué me conviene responder primero?',
    hint: 'Con tu buzón conectado',
    icon: 'Inbox',
    tone: 'rose',
    requires: ['inbox.priorities'],
    gate: 'always',
    slot: 'correo',
  },
  {
    id: 'cap:agenda',
    text: '¿Qué reuniones tengo esta semana y para cuál me tengo que preparar?',
    hint: 'Desde tu calendario',
    icon: 'CalendarDays',
    tone: 'sky',
    requires: ['gcal.upcoming_meetings'],
    gate: 'always',
    slot: 'agenda',
  },
  {
    id: 'cap:agenda-ms',
    text: '¿Qué tengo en la agenda de Outlook esta semana?',
    hint: 'Desde tu calendario de Microsoft 365',
    icon: 'CalendarDays',
    tone: 'sky',
    requires: ['mscal.list_events'],
    gate: 'always',
    slot: 'agenda',
  },
  {
    id: 'cap:pipeline',
    text: '¿Cómo está el embudo de ventas y qué negocio se está enfriando?',
    hint: 'Desde HubSpot',
    icon: 'Handshake',
    tone: 'amber',
    requires: ['hubspot.get_pipeline_summary'],
    gate: 'always',
    slot: 'ventas',
  },
  {
    id: 'cap:report',
    text: 'Hazme el informe de vencimientos de este mes, con gráfica.',
    hint: 'Queda guardado y se puede compartir',
    icon: 'BarChart3',
    tone: 'primary',
    requires: ['reports.generate'],
    gate: 'hasCommitments',
    slot: 'informes',
  },
  {
    id: 'cap:routine',
    text: 'Todos los lunes a las 8 de la mañana, mándame lo que se vence esa semana.',
    hint: 'Corre sola, sin que nadie la dispare',
    icon: 'AlarmClock',
    tone: 'primary',
    requires: ['schedule.create'],
    gate: 'noRoutines',
    slot: 'rutinas',
  },
  {
    id: 'cap:actions',
    text: '¿Hay algo redactado esperando mi aprobación?',
    hint: 'Nada sale sin que alguien lo apruebe',
    icon: 'Send',
    tone: 'primary',
    requires: ['actions.list'],
    gate: 'always',
    slot: 'acciones',
  },
  {
    id: 'cap:market',
    text: 'Busca en internet qué se está diciendo de {empresa} y resúmemelo con las fuentes.',
    hint: 'Lo único que no toca nada interno',
    icon: 'Globe',
    tone: 'emerald',
    requires: ['web.search'],
    gate: 'hasOrgName',
    slot: 'internet',
  },
  {
    id: 'cap:team',
    text: 'Dame el panorama del equipo, sin nombres ni sueldos.',
    hint: 'Desde el servicio de nómina',
    icon: 'Wallet',
    tone: 'rose',
    requires: ['payroll.team_overview'],
    gate: 'always',
    slot: 'nomina',
  },
  {
    id: 'cap:eng',
    text: '¿Cómo va el equipo técnico: carga repartida, revisiones y entregas?',
    hint: 'Desde Linear y GitHub',
    icon: 'GitBranch',
    tone: 'sky',
    requires: ['linear.workload_stats'],
    gate: 'always',
    slot: 'ingenieria',
  },
  {
    id: 'cap:errand',
    text: 'Investígame a fondo quién más está ofreciendo lo que vendemos y avísame cuando lo tengas.',
    hint: 'Trabaja por su cuenta y vuelve con la respuesta',
    icon: 'Telescope',
    tone: 'emerald',
    requires: ['errands.start'],
    gate: 'always',
    slot: 'encargos',
  },
];

function passesGate(gate: OpenerGate, seeds: OpenerSeeds): boolean {
  switch (gate) {
    case 'hasCommitments':
      return seeds.commitments.length > 0;
    case 'noRoutines':
      return seeds.routineCount === 0;
    case 'hasOrgName':
      return Boolean(seeds.orgName?.trim());
    default:
      return true;
  }
}

/** `gmail.search` → `gmail`. Copia local de `familyOf` para no importar nada. */
function familyOf(toolId: string): string {
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

// ---------------------------------------------------------------------------
// El espacio recién creado
// ---------------------------------------------------------------------------

/**
 * Tres pasos, con el enlace donde se dan de verdad.
 *
 * Una pantalla vacía honesta que dice qué hacer vale más que seis tarjetas que
 * no llevan a ningún sitio. Estos no son sugerencias de chat —no se mandan al
 * agente— porque ninguna de las tres cosas se hace hablando: conectar Google es
 * un OAuth, subir un contrato es un archivo, y registrar un cliente es un
 * formulario con un NIT que se verifica.
 */
export const FIRST_STEPS: FirstStep[] = [
  {
    id: 'connect',
    label: 'Conecta una fuente',
    blurb: 'Tu correo, tu calendario o tu Drive. Es de donde sale casi todo lo demás.',
    href: '/integrations',
    icon: 'Plug',
  },
  {
    id: 'upload',
    label: 'Sube un documento',
    blurb: 'Un contrato o una póliza. Cortex lo lee, lo cita y le saca las fechas.',
    href: '/kb',
    icon: 'Upload',
  },
  {
    id: 'client',
    label: 'Registra un cliente',
    blurb: 'De ahí cuelgan sus correos, sus documentos y lo que se le vence.',
    href: '/clients',
    icon: 'Building2',
  },
];

// ---------------------------------------------------------------------------
// La selección
// ---------------------------------------------------------------------------

/** «documentos y clientes» — para una frase, no para una lista con viñetas. */
function joinEs(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] as string;
  return `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
}

/**
 * De las filas de un espacio de trabajo a las tarjetas que se dibujan.
 *
 * Pura a propósito: entra un objeto, sale un objeto, y las pruebas cubren los
 * tres espacios que importan — uno lleno, uno vacío y uno con la integración
 * desconectada.
 */
export function buildOpeners(seeds: OpenerSeeds, limit = OPENER_LIMIT): OpenersResponse {
  const usable = new Set(seeds.usableToolIds);
  const canRun = (requires: string[]) => requires.every((id) => usable.has(id));

  const picked: Opener[] = [];
  const usedSlots = new Map<string, number>();

  const take = (candidate: Candidate, maxPerSlot: number): boolean => {
    if (picked.length >= limit) return false;
    if (!canRun(candidate.requires)) return false;
    const used = usedSlots.get(candidate.slot) ?? 0;
    if (used >= maxPerSlot) return false;
    usedSlots.set(candidate.slot, used + 1);
    const { requires: _requires, slot: _slot, ...opener } = candidate;
    picked.push(opener);
    return true;
  };

  // --- Nivel 1 -------------------------------------------------------------
  for (const candidate of roundRobin(groundedByFamily(seeds))) take(candidate, 2);

  // --- Nivel 2 -------------------------------------------------------------
  // Lo que ya se usó últimamente va al final, no fuera: si el nivel 1 dejó
  // cuatro huecos y sólo hay tres capacidades sin estrenar, la cuarta tarjeta
  // es mejor repetida que ausente. «Todavía no ha usado» es una PREFERENCIA,
  // que es lo que dice el criterio; tratarla como un filtro dejaría a un
  // espacio maduro con menos sugerencias que uno nuevo, al revés de lo justo.
  const usedFamilies = new Set(seeds.usedFamilies);
  const fresh: CapabilityOpener[] = [];
  const stale: CapabilityOpener[] = [];
  for (const cap of CAPABILITY_OPENERS) {
    if (!passesGate(cap.gate, seeds)) continue;
    const touched = cap.requires.some((id) => usedFamilies.has(familyOf(id)));
    (touched ? stale : fresh).push(cap);
  }

  for (const cap of [...fresh, ...stale]) {
    take(
      {
        id: cap.id,
        text: cap.text.replace('{empresa}', seeds.orgName?.trim() ?? ''),
        hint: cap.hint,
        icon: cap.icon,
        tone: cap.tone,
        kind: 'capability',
        requires: cap.requires,
        slot: cap.slot,
      },
      1,
    );
  }

  // --- Honestidad ----------------------------------------------------------
  const hasContent =
    seeds.documents.length > 0 ||
    seeds.clients.length > 0 ||
    seeds.commitments.length > 0 ||
    seeds.vehicles.length > 0 ||
    seeds.reports.length > 0 ||
    seeds.flows.length > 0;

  // Una lectura que falló NUNCA se dibuja como un espacio vacío. «No tienes
  // documentos» y «no pude leer tus documentos» son dos frases distintas, y
  // sólo una de las dos manda a alguien a subir por segunda vez algo que ya
  // está subido.
  const notice =
    seeds.failed.length > 0
      ? `No pude leer ${joinEs(seeds.failed)}, así que puede que falten sugerencias.`
      : null;

  // `picked` NO entra en esta cuenta a propósito. Un espacio recién creado casi
  // siempre puede ejecutar dos o tres herramientas que no dependen de nada —
  // `actions.list`, `errands.start` — y dibujar esas tres tarjetas sería
  // aparentar un producto en marcha en vez de decir la verdad: aquí todavía no
  // hay nada, y esto es lo primero que hay que hacer.
  const blank = !hasContent && seeds.connectedProviders.length === 0 && !notice;

  return {
    openers: blank ? [] : picked,
    blank,
    firstSteps: blank ? FIRST_STEPS : [],
    notice,
  };
}
