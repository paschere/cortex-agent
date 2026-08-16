/**
 * Human-readable taxonomy for the tool registry: family names, what each family
 * is for, and the id → label humanisation shared by the catalogue UI.
 *
 * PURE DATA ONLY — no `@cortex/agent-tools` import. This module is imported by
 * a CLIENT component, and pulling the registry in would drag `node:crypto`,
 * `node:dns` and pdf-parse's `fs` access into the browser bundle and break the
 * production build (same trap documented in
 * apps/web/app/api/settings/preferences/schema.ts). Anything that needs the
 * live registry must be resolved in a server component and passed down as
 * plain serialisable props.
 */

// Safe by that rule: browser-shape.ts is hand-written constants with no imports
// of its own, and it is where the trámites module's name lives so the screen,
// the sidebar and this catalogue cannot drift apart.
import { MODULE } from './browser-shape';

export type FamilyTone = 'primary' | 'emerald' | 'amber' | 'sky' | 'rose';

export interface FamilyMeta {
  /** Human name shown as the section title. */
  name: string;
  /** One line explaining what this family is for, in plain language. */
  blurb: string;
  tone: FamilyTone;
  /** Lucide icon name; the client maps it to a component. */
  icon: string;
}

/**
 * Keyed by the tool-id prefix (the part before the first dot). Families missing
 * here still render — `familyMeta` falls back to a title-cased key — but they
 * lose the blurb, so add new families as they are registered.
 */
export const FAMILY_META: Record<string, FamilyMeta> = {
  presentations: {
    name: 'Presentaciones',
    blurb:
      'Perfiles de candidato armados en PDF para cliente, y el historial de lo que ya se envió.',
    tone: 'primary',
    icon: 'FileText',
  },
  people: {
    name: 'Directorio de personas',
    blurb:
      'De un nombre a un correo, usando el directorio de Google Workspace y los contactos personales.',
    tone: 'primary',
    icon: 'Users',
  },
  clients: {
    name: 'Clientes',
    blurb:
      'Las empresas cliente, con su NIT y sus contactos, y todo lo que Cortex ya guardó colgado de cada una: correos, reuniones, documentos, grupos y vencimientos.',
    tone: 'amber',
    icon: 'Building2',
  },
  hubspot: {
    name: 'HubSpot',
    blurb: 'El CRM: empresas, contactos, negocios, salud del embudo y registro de actividad.',
    tone: 'amber',
    icon: 'Building2',
  },
  growth: {
    name: 'Señales de mercado',
    blurb: 'Señales de compra que aparecen afuera y las personas que deciden detrás de ellas.',
    tone: 'amber',
    icon: 'TrendingUp',
  },
  sales: {
    name: 'Propuestas',
    blurb: 'Redacción de propuestas para cliente, apoyada en el CRM y en Brain Knowledge.',
    tone: 'amber',
    icon: 'Handshake',
  },
  payments: {
    name: 'Pagos y cartera',
    blurb:
      'Lo que de verdad entró, dicho por el banco, por el sistema contable, por un comprobante o a mano. La cartera se calcula restándoselo a las facturas que alguien confirmó, cada moneda por su lado; cuando dos fuentes no coinciden, el pago queda en disputa y sale de todas las cifras hasta que una persona decida.',
    tone: 'emerald',
    icon: 'Coins',
  },
  documents: {
    name: 'Documentos leídos',
    blurb:
      'Facturas, guías, declaraciones de aduana, certificados de origen, contratos, pólizas y comprobantes de pago leídos a campos que se pueden sumar, sin perder las palabras de donde salió cada dato. Nada entra en una cifra hasta que una persona lo confirma.',
    tone: 'amber',
    icon: 'Receipt',
  },
  errands: {
    name: 'Encargos',
    blurb:
      'Investigaciones que le dejas encargadas y siguen solas mientras haces otra cosa: tienen tope de gasto, te preguntan cuando se atascan y nada de lo que sale de la empresa se manda sin que alguien lo apruebe.',
    tone: 'primary',
    icon: 'Telescope',
  },
  directory: {
    name: 'Línea de mando',
    blurb:
      'Quién le responde a quién entre los que tienen cuenta en Cortex, y a quién hay que subirle un asunto cuando el de siempre no contesta. No es el organigrama de la empresa: eso vive en «Quién es quién», dentro de los datos de la empresa.',
    tone: 'primary',
    icon: 'Network',
  },
  payroll: {
    name: 'Nómina',
    blurb:
      'El servicio aparte de nómina: lo que se pagó de verdad, gastos, costo por cliente y proyecciones.',
    tone: 'rose',
    icon: 'Wallet',
  },
  kb: {
    name: 'Brain Knowledge',
    blurb: 'La memoria de la empresa: busca en los documentos internos y escribe nuevos.',
    tone: 'sky',
    icon: 'BookOpen',
  },
  meetings: {
    name: 'Reuniones',
    blurb: 'Transcripciones grabadas y los briefings que Cortex prepara antes de una llamada.',
    tone: 'sky',
    icon: 'Mic',
  },
  inbox: {
    name: 'Bandeja del día',
    blurb:
      'Qué te espera en las cuatro colas donde el trabajo se para —permisos, vencimientos, correos redactados y encargos atascados—, más la lista de prioridades y los resúmenes que Cortex arma con todo lo que alcanza a ver.',
    tone: 'sky',
    icon: 'Inbox',
  },
  goals: {
    name: 'Metas',
    blurb:
      'La cifra que la empresa fijó y lo que de verdad pasó, período a período. Sólo se pueden fijar metas que este espacio de trabajo sepa calcular: las demás salen con lo que les falta, porque una casilla vacía resta más confianza de la que suma.',
    tone: 'primary',
    icon: 'Target',
  },
  company: {
    name: 'Datos de la empresa',
    blurb:
      'La ficha que la empresa escribe sobre sí misma —identidad, cómo cobra, quién decide, y lo que Cortex no debe hacer por su cuenta— y los huecos que quedan por llenar. Cortex la lee y la enseña; escribirla es de la pantalla, porque su última sección es el límite que lo gobierna.',
    tone: 'primary',
    icon: 'Building2',
  },
  actions: {
    name: 'Acciones propuestas',
    blurb:
      'Mensajes que Cortex deja redactados y listos: un cobro, un recordatorio de vencimiento, una respuesta a un cliente. No envía nada hasta que alguien los aprueba.',
    tone: 'primary',
    icon: 'Send',
  },
  gmail: {
    name: 'Gmail',
    blurb: 'Leer el buzón, buscar hilos, preparar borradores y enviar los que se aprueben.',
    tone: 'rose',
    icon: 'Mail',
  },
  gcal: {
    name: 'Google Calendar',
    blurb: 'Lo que viene en la agenda, disponibilidad, y crear eventos con invitación.',
    tone: 'sky',
    icon: 'CalendarDays',
  },
  outlook: {
    name: 'Outlook',
    blurb:
      'El correo de Microsoft 365: buscar, leer un hilo completo, dejar borradores, enviarlos y archivar en Brain Knowledge lo que se habla con clientes.',
    tone: 'rose',
    icon: 'Mail',
  },
  mscal: {
    name: 'Calendario de Outlook',
    blurb: 'La agenda de Microsoft 365: qué hay en una ventana de tiempo y crear eventos.',
    tone: 'sky',
    icon: 'CalendarDays',
  },
  gdrive: {
    name: 'Google Drive',
    blurb: 'Encontrar y leer documentos guardados en el Drive compartido.',
    tone: 'emerald',
    icon: 'FolderOpen',
  },
  gsheets: {
    name: 'Google Sheets',
    blurb: 'Leer rangos de hojas compartidas y agregarles filas.',
    tone: 'emerald',
    icon: 'Table2',
  },
  github: {
    name: 'GitHub',
    blurb: 'Repositorios, issues, pull requests y métricas de entrega del equipo técnico.',
    tone: 'sky',
    icon: 'GitBranch',
  },
  linear: {
    name: 'Linear',
    blurb: 'Issues, proyectos, ciclos y carga del equipo en la hoja de ruta.',
    tone: 'sky',
    icon: 'SquareKanban',
  },
  slack: {
    name: 'Slack',
    blurb: 'Publicar mensajes en canales, incluidos los que se comparten con clientes.',
    tone: 'amber',
    icon: 'MessageSquare',
  },
  chat: {
    name: 'Google Chat',
    blurb: 'Mensajes directos y publicaciones en espacios que Cortex le manda a tus colegas.',
    tone: 'emerald',
    icon: 'MessagesSquare',
  },
  pipeline: {
    name: 'Procedimientos',
    blurb: 'Instructivos reutilizables que cualquiera del equipo puede ejecutar desde donde esté.',
    tone: 'primary',
    icon: 'Workflow',
  },
  schedule: {
    name: 'Rutinas',
    blurb:
      'Trabajos desatendidos que siguen corriendo según su horario hasta que alguien los pause.',
    tone: 'primary',
    icon: 'AlarmClock',
  },
  commitments: {
    name: 'Vencimientos',
    blurb:
      'Compromisos con fecha que Cortex vigila solo: SOAT y tecnomecánica de la flota, contratos, pólizas, plazos de aduana y pagos. Cada fecha carga de dónde salió.',
    tone: 'amber',
    // CalendarDays rather than CalendarClock: the catalogue resolves these
    // names against its own icon map, and an unmapped name silently falls back.
    icon: 'CalendarDays',
  },
  reports: {
    name: 'Informes',
    blurb:
      'Informes con texto y gráficos que se leen en pantalla, quedan guardados tal como se calcularon y se pueden compartir. Cada cifra dice de dónde salió.',
    tone: 'primary',
    icon: 'BarChart3',
  },
  vehicles: {
    name: 'Vehículos',
    blurb:
      'Placas que vale la pena vigilar: vigencia de SOAT y RTM desde el RUNT, comparendos desde el SIMIT, y qué cambió desde la última consulta.',
    tone: 'emerald',
    icon: 'Car',
  },
  web: {
    name: 'Internet',
    blurb: 'Búsqueda pública y lectura de páginas — lo único que no toca nada interno.',
    tone: 'emerald',
    icon: 'Globe',
  },
  browser: {
    name: MODULE.label,
    blurb:
      'Vueltas aprendidas en portales ajenos: entra, llena el formulario y trae el resultado. Los que radican algo piden aprobación.',
    tone: 'amber',
    icon: 'Globe',
  },
  approvals: {
    name: 'Lo que espera tu permiso',
    blurb:
      'Consulta de solo lectura de las llamadas que Cortex paró a medio ejecutar y siguen esperando un sí — vengan de tu conversación en Claude, de Google Chat o de WhatsApp. No hay ninguna herramienta con la que aprobarlas: eso se hace con el botón de la tarjeta, y sólo lo puede pulsar una persona.',
    tone: 'amber',
    icon: 'ShieldAlert',
  },
  security: {
    name: 'Seguridad',
    blurb: 'Consulta de solo lectura sobre las decisiones de la barrera y sus eventos recientes.',
    tone: 'rose',
    icon: 'ShieldCheck',
  },
  cortex: {
    name: 'Cortex',
    blurb: 'Herramientas con las que el agente se ubica dentro del espacio de trabajo.',
    tone: 'primary',
    icon: 'Sparkles',
  },
  custom: {
    name: 'Herramientas propias',
    blurb: 'Llamadas a la API de esta empresa, definidas desde la app y no por nosotros.',
    tone: 'primary',
    icon: 'Boxes',
  },
  format: {
    name: 'Formato',
    blurb: 'Ayudas de presentación que le dan forma legible a los datos.',
    tone: 'emerald',
    icon: 'Type',
  },
};

// ---------------------------------------------------------------------------
// Capability groups: what a PERSON would say Cortex knows how to do
// ---------------------------------------------------------------------------

/**
 * Families are the technical seam (`hubspot`, `gsheets`, `gcal`) — useful for
 * permission patterns and for the audit log, useless as a first impression.
 * Nobody arrives at this screen wondering what lives under the `gcal` prefix;
 * they arrive wondering whether Cortex can move a meeting.
 *
 * These groups are that second question. They are a PRESENTATION layer only:
 * grants, deny-lists and the registry keep speaking families, and a family that
 * is not mapped here still renders — it falls into `other` rather than
 * disappearing, which is the failure mode that let a whole shipped family stay
 * invisible for a day (see migration 0065).
 */
export interface CapabilityGroup {
  id: string;
  /** Section title — how a person would name this capability. */
  name: string;
  /** One line: what Cortex can actually do for you here. */
  blurb: string;
  tone: FamilyTone;
  /** Lucide icon name; the client maps it to a component. */
  icon: string;
}

export const CAPABILITY_GROUPS: CapabilityGroup[] = [
  {
    id: 'clients',
    name: 'Clientes y negocios',
    blurb:
      'Buscar empresas y contactos, mirar el embudo, dejar registro de lo que pasó y preparar una propuesta.',
    tone: 'amber',
    icon: 'Handshake',
  },
  {
    // Justo detrás de «Clientes y negocios» y no al final: lo que un cliente
    // debe es la segunda cosa que se pregunta de un cliente, y hasta ahora las
    // diecisiete herramientas de esta columna —cartera incluida— caían en
    // «Otras herramientas», que es donde se guarda lo que no se ha pensado.
    // «¿Cuánto nos deben?» es la pregunta más de empresa que contesta el
    // producto y estaba en el cajón de sastre.
    id: 'billing',
    // Cartera Y papeles, no sólo facturación: aquí no viven únicamente las
    // facturas. Viven las guías, las declaraciones de aduana, los certificados
    // de origen, los contratos y las pólizas, porque el motor que los lee es el
    // mismo y porque la cartera se calcula justo sobre ellos. «Papeles» es como
    // se llaman en una oficina de aquí.
    name: 'Cartera y papeles',
    blurb:
      'Cuánto nos deben y a cuántos días, qué entró y de quién, y los papeles de donde sale cada cifra: facturas, guías, declaraciones de aduana, contratos y pólizas. Ninguna cifra cuenta hasta que una persona confirmó el documento, y la respuesta siempre dice cuántos quedaron por revisar.',
    tone: 'emerald',
    icon: 'Coins',
  },
  {
    id: 'comms',
    name: 'Escribir y responder',
    blurb:
      'Leer el correo, redactar borradores, mandar un mensaje por Slack o Google Chat y averiguar la dirección de alguien.',
    tone: 'rose',
    icon: 'Mail',
  },
  {
    id: 'agenda',
    name: 'Agenda y reuniones',
    blurb:
      'Ver qué viene, agendar con invitación, y recuperar lo que se dijo en una llamada grabada.',
    tone: 'sky',
    icon: 'CalendarDays',
  },
  {
    id: 'docs',
    name: 'Documentos y memoria',
    blurb:
      'Buscar en Brain Knowledge, abrir archivos del Drive y leer o escribir hojas de cálculo.',
    tone: 'primary',
    icon: 'BookOpen',
  },
  {
    id: 'eng',
    name: 'Ingeniería',
    blurb: 'Issues, repositorios, ciclos y entregas del equipo técnico.',
    tone: 'sky',
    icon: 'GitBranch',
  },
  {
    id: 'money',
    name: 'Nómina y costos',
    blurb: 'Lo que se pagó de verdad, los gastos y el costo por cliente.',
    tone: 'rose',
    icon: 'Wallet',
  },
  {
    id: 'goals',
    // Aparte de «Nómina y costos» y aparte de «Documentos y memoria», que es
    // donde viven los informes: un informe cuenta lo que pasó, una meta es el
    // número que alguien DECIDIÓ y contra el que se compara lo que pasó. Quien
    // pregunta por una no está pidiendo lo otro.
    name: 'Metas y cifras',
    blurb:
      'Qué se puede medir de esta empresa, la meta que se fijó y cómo va el período — con la cuenta que produjo cada número.',
    tone: 'primary',
    icon: 'Target',
  },
  {
    id: 'vehicles',
    name: 'Vehículos y trámites',
    // El nombre prometía trámites y no había ni uno: los `browser.*` —los
    // trámites de verdad, los que entran a un portal y radican— estaban en
    // «Información pública», que es donde va lo que NO toca nada. Radicar en el
    // RUNT o en la DIAN con la clave de la empresa no es información pública.
    blurb:
      'SOAT y RTM desde el RUNT, comparendos desde el SIMIT, todo lo que se vence con fecha —contratos, pólizas, plazos de aduana y pagos— y las vueltas aprendidas en portales ajenos: entra, llena el formulario y radica.',
    tone: 'emerald',
    icon: 'Car',
  },
  {
    id: 'auto',
    name: 'Automatización',
    blurb:
      'Encargos que investigan solos mientras haces otra cosa, procedimientos que cualquiera del equipo puede ejecutar y rutinas que corren según su horario.',
    tone: 'primary',
    icon: 'Workflow',
  },
  {
    // La empresa mirándose a sí misma. Las dos herramientas que estrenó esta
    // semana —la ficha y la línea de mando— caían en «Otras herramientas», que
    // para un producto que se vende como «un gerente para tu empresa» es el
    // peor sitio posible. Y con ellas va la memoria (`cortex.remember` y
    // `cortex.forget`), que estaba fichada en «Automatización» sin ser ni un
    // procedimiento ni una rutina: enseñarle algo a Cortex sobre esta empresa
    // es exactamente lo mismo que hacen las otras dos.
    id: 'company',
    name: 'Tu empresa',
    blurb:
      'Quién es esta empresa —identidad, NIT, cómo cobra, quién decide y lo que Cortex no debe hacer por su cuenta—, quién le responde a quién cuando hay que subirle un asunto a alguien, y la memoria que le vas dejando para no repetirle lo mismo cada semana.',
    tone: 'primary',
    icon: 'Building2',
  },
  {
    id: 'external',
    name: 'Información pública',
    blurb: 'Buscar en internet y leer páginas — lo único que no toca nada interno.',
    tone: 'emerald',
    icon: 'Globe',
  },
  {
    id: 'control',
    name: 'Control y seguridad',
    blurb: 'Lo que Cortex usa para ubicarse y para revisar sus propias decisiones.',
    tone: 'rose',
    icon: 'ShieldCheck',
  },
  {
    id: 'mcp',
    name: 'Tus servidores MCP',
    blurb:
      'Herramientas que llegan de un servidor MCP que tú conectaste. Aparecen y desaparecen con el servidor.',
    tone: 'sky',
    icon: 'Server',
  },
  {
    id: 'custom',
    name: 'Herramientas propias',
    blurb: 'Llamadas a la API de tu empresa que un administrador definió acá mismo.',
    tone: 'primary',
    icon: 'Boxes',
  },
  {
    id: 'other',
    name: 'Otras herramientas',
    blurb: 'Familias registradas que todavía no tienen un grupo asignado en esta pantalla.',
    tone: 'primary',
    icon: 'Wrench',
  },
];

const GROUP_BY_ID = new Map(CAPABILITY_GROUPS.map((g) => [g.id, g]));

/** Family prefix → capability group id. Anything unlisted falls into `other`. */
const FAMILY_GROUP: Record<string, string> = {
  clients: 'clients',
  hubspot: 'clients',
  growth: 'clients',
  sales: 'clients',
  presentations: 'clients',
  payments: 'billing',
  // Con los pagos y no con «Documentos y memoria»: lo que lee este módulo no es
  // documentación, son cifras con un papel detrás. La cartera se calcula
  // restándole los pagos a las facturas que salieron de aquí, así que separar
  // las dos mitades obligaría a buscar en dos sitios la misma conversación.
  documents: 'billing',
  gmail: 'comms',
  actions: 'comms',
  outlook: 'comms',
  slack: 'comms',
  chat: 'comms',
  people: 'comms',
  gcal: 'agenda',
  mscal: 'agenda',
  meetings: 'agenda',
  inbox: 'agenda',
  kb: 'docs',
  gdrive: 'docs',
  gsheets: 'docs',
  format: 'docs',
  // A report is a document Cortex writes, so it sits with the rest of what it
  // reads and writes rather than with the fleet — the person who asks for one
  // is asking for a document, whatever the numbers inside it are about.
  reports: 'docs',
  github: 'eng',
  linear: 'eng',
  payroll: 'money',
  goals: 'goals',
  vehicles: 'vehicles',
  // Sits with the fleet rather than with automation: a SOAT that lapses is a
  // truck off the road, and the person who cares about one cares about the
  // other. The watcher being automatic is an implementation detail to them.
  commitments: 'vehicles',
  // Los trámites aprendidos van donde el nombre del grupo ya los prometía. En
  // «Información pública» eran una mentira de dos filas: `browser.submit_flow`
  // radica algo en un portal con la clave de la empresa, que es lo contrario de
  // «lo único que no toca nada interno».
  browser: 'vehicles',
  pipeline: 'auto',
  schedule: 'auto',
  errands: 'auto',
  company: 'company',
  directory: 'company',
  cortex: 'company',
  web: 'external',
  security: 'control',
  // Con seguridad y no con «Escribir y responder», donde está `actions`: lo que
  // hay aquí no es algo que Cortex redactó, es algo que la barrera detuvo. Se
  // lee en el mismo sitio donde se revisa por qué se detiene lo que se detiene.
  approvals: 'control',
};

export function groupOfFamily(family: string): string {
  // Every tool proxied from a connected MCP server carries an `mcp:<uuid>`
  // family, so the prefix — not the whole string — is what decides the group.
  if (family.startsWith('mcp:')) return 'mcp';
  if (family === 'custom') return 'custom';
  return FAMILY_GROUP[family] ?? 'other';
}

export function groupMeta(id: string): CapabilityGroup {
  return GROUP_BY_ID.get(id) ?? (GROUP_BY_ID.get('other') as CapabilityGroup);
}

/** Display order, so a group never moves between renders. */
export const GROUP_ORDER: string[] = CAPABILITY_GROUPS.map((g) => g.id);

// ---------------------------------------------------------------------------
// Server-side credentials a family needs before it can work at all
// ---------------------------------------------------------------------------

/**
 * The difference between "you have not connected Google" and "nobody put the
 * RUNT scraper's key on the server" is the whole difference between a problem
 * you can fix in thirty seconds and one you have to ask somebody for. The
 * catalogue used to show neither, so a tool that could not possibly run looked
 * exactly like one that was working.
 *
 * PURE DATA: the env vars are named here and READ in the server component —
 * this module is imported by a client bundle and must never touch process.env.
 */
export interface CredentialRequirement {
  /** Env vars that must ALL be present. Names only; never values. */
  vars: string[];
  /** What the credential is for, in the words of the person reading. */
  label: string;
  /**
   * False when the tool still does something useful without it. Brain
   * Knowledge without a Voyage key falls back to keyword search: degraded, not
   * dead, and saying "blocked" would be a lie.
   */
  blocking: boolean;
  /** What is lost while it is missing. */
  effect: string;
}

/** Keyed by family prefix. A per-tool entry in TOOL_CREDENTIALS wins over this. */
export const FAMILY_CREDENTIALS: Record<string, CredentialRequirement> = {
  vehicles: {
    vars: ['VEHICLES_SCRAPER_URL', 'VEHICLES_SCRAPER_API_KEY'],
    label: 'el servicio que consulta el RUNT y el SIMIT',
    blocking: true,
    effect: 'Sin él no se puede consultar ninguna placa.',
  },
  payroll: {
    vars: ['PAYROLL_API_URL', 'PAYROLL_API_TOKEN'],
    label: 'el servicio de nómina',
    blocking: true,
    effect: 'Sin él no hay pagos, gastos ni costos por cliente.',
  },
  browser: {
    vars: ['BROWSER_SERVICE_URL', 'BROWSER_SERVICE_TOKEN'],
    label: 'el servicio de navegador en Railway',
    blocking: true,
    effect: 'Sin él no se puede ejecutar ningún trámite aprendido.',
  },
  slack: {
    vars: ['SLACK_BOT_TOKEN'],
    label: 'el bot de Slack del espacio de trabajo',
    blocking: true,
    effect: 'Sin él no se puede publicar nada en Slack.',
  },
  chat: {
    vars: ['GOOGLE_CHAT_SERVICE_ACCOUNT_JSON'],
    label: 'la cuenta de servicio de Google Chat',
    blocking: true,
    effect: 'Sin ella Cortex no puede escribirle a nadie por Google Chat.',
  },
  growth: {
    vars: ['TAVILY_API_KEY'],
    label: 'el buscador web',
    blocking: true,
    effect: 'Sin él no hay señales de mercado, porque salen de una búsqueda pública.',
  },
  // Two different walls, and the catalogue shows the outer one first. Even a
  // person who wants to connect their own Outlook cannot until somebody has
  // registered the application in Azure — so a missing registration is a
  // credential problem, not "you have not connected it".
  outlook: {
    vars: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_REDIRECT_URI'],
    label: 'la aplicación de Cortex registrada en Azure',
    blocking: true,
    effect: 'Sin ella nadie puede conectar su buzón de Outlook, ni siquiera para leerlo.',
  },
  mscal: {
    vars: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET', 'MICROSOFT_REDIRECT_URI'],
    label: 'la aplicación de Cortex registrada en Azure',
    blocking: true,
    effect: 'Sin ella no se puede conectar el calendario de Microsoft 365.',
  },
  kb: {
    vars: ['VOYAGE_API_KEY'],
    label: 'el motor de embeddings de Brain Knowledge',
    blocking: false,
    effect: 'Sin él la búsqueda solo empareja palabras, no significado.',
  },
};

/** Overrides for single tools whose family requirement does not apply to them. */
export const TOOL_CREDENTIALS: Record<string, CredentialRequirement> = {
  // web.scrape falls back to Jina when Firecrawl is absent, so only the search
  // half of the family actually depends on a key.
  'web.search': {
    vars: ['TAVILY_API_KEY'],
    label: 'el buscador web',
    blocking: true,
    effect: 'Sin él no se puede buscar en internet.',
  },
};

export function credentialRequirement(toolId: string): CredentialRequirement | null {
  return TOOL_CREDENTIALS[toolId] ?? FAMILY_CREDENTIALS[familyOf(toolId)] ?? null;
}

// ---------------------------------------------------------------------------
// Why a tool did not run
// ---------------------------------------------------------------------------

/**
 * The four things that stop a tool, in the order the runtime hits them:
 * the agent never offered it, a team subtracted it, the integration is not
 * connected, or the deployment has no credential for it.
 */
export type BlockReason =
  | 'disabled'
  | 'not_granted'
  | 'team_blocked'
  | 'integration'
  | 'credential';

export const BLOCK_ORDER: BlockReason[] = [
  'disabled',
  'not_granted',
  'team_blocked',
  'integration',
  'credential',
];

export const BLOCK_LABEL: Record<BlockReason, string> = {
  disabled: 'Está apagada',
  not_granted: 'Ningún agente la tiene habilitada',
  team_blocked: 'Tu equipo la tiene bloqueada',
  integration: 'Falta conectar la integración',
  credential: 'Falta una credencial en el servidor',
};

/** Short subtitle for the diagnosis panel — what this cause means, in one line. */
export const BLOCK_BLURB: Record<BlockReason, string> = {
  disabled:
    'Alguien la apagó desde esta misma pantalla. Sigue definida, pero no se le ofrece al modelo.',
  not_granted:
    'Está en el registro, pero ningún agente activo la lista entre sus herramientas, así que Cortex nunca la ve.',
  team_blocked:
    'Un equipo al que perteneces la bloqueó. Los equipos solo restan: estar en otro equipo no te la devuelve.',
  integration:
    'Cortex necesita entrar al sistema con tu cuenta y esa cuenta todavía no está conectada.',
  credential:
    'La herramienta depende de un servicio cuya llave se configura en el servidor, no en tu cuenta.',
};

/** Words that must not be title-cased naively. */
const ACRONYMS = new Set(['pr', 'prs', 'pdf', 'kb', 'crm', 'ats', 'id', 'ids', 'url', 'dm', 'ai']);

export function familyOf(toolId: string): string {
  const dot = toolId.indexOf('.');
  return dot === -1 ? toolId : toolId.slice(0, dot);
}

export function familyMeta(family: string): FamilyMeta {
  return (
    FAMILY_META[family] ?? {
      name: family.charAt(0).toUpperCase() + family.slice(1),
      blurb: 'Tools registered under this family.',
      tone: 'primary',
      icon: 'Wrench',
    }
  );
}

export function familyLabel(family: string): string {
  return familyMeta(family).name;
}

function titleWord(word: string): string {
  if (!word) return word;
  if (ACRONYMS.has(word.toLowerCase())) return word.toUpperCase();
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The action half of a tool id, humanised: 'hubspot.search_contacts' →
 * 'Search Contacts'. Used inside a family section, where the family is already
 * the heading.
 */
export function toolActionLabel(toolId: string): string {
  const dot = toolId.indexOf('.');
  const action = dot === -1 ? toolId : toolId.slice(dot + 1);
  return action.split(/[._]/).filter(Boolean).map(titleWord).join(' ');
}

/**
 * Fully-qualified human label: 'gcal.create_event' →
 * 'Google Calendar · Create Event'.
 *
 * Deliberately separate from `humanizeToolId` in lib/tool-labels.ts: that one
 * serves surfaces holding nothing but a raw id (approval emails, Chat DMs,
 * archived transcripts) and title-cases the family key as it stands
 * ('Gcal · Create Event'). The catalogue's whole job is to replace those keys
 * with the curated names in FAMILY_META, so it resolves the family here.
 */
export function qualifiedToolLabel(toolId: string): string {
  const family = familyOf(toolId);
  const action = toolActionLabel(toolId);
  const label = familyLabel(family);
  return action ? `${label} · ${action}` : label;
}

/** Same rules as matchPattern in @cortex/agent-tools: 'family.*' or exact id. */
export function matchesPattern(toolId: string, pattern: string): boolean {
  return pattern.endsWith('.*') ? toolId.startsWith(pattern.slice(0, -1)) : pattern === toolId;
}

export function matchesAnyPattern(toolId: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(toolId, p));
}

// ---------------------------------------------------------------------------
// Risk vocabulary (mirrors packages/agent-tools/src/security/policy.ts)
// ---------------------------------------------------------------------------

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Sensitivity = 'public' | 'internal' | 'client' | 'pii' | 'financial';
export type BlastRadius = 'read' | 'internal_write' | 'external_send' | 'bulk';

export const RISK_ORDER: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

export const RISK_LABEL: Record<RiskLevel, string> = {
  low: 'Riesgo bajo',
  medium: 'Riesgo medio',
  high: 'Riesgo alto',
  critical: 'Crítica',
};

export const SENSITIVITY_LABEL: Record<Sensitivity, string> = {
  public: 'Datos públicos',
  internal: 'Datos internos',
  client: 'Datos del cliente',
  pii: 'Datos personales',
  financial: 'Datos de sueldos',
};

export const BLAST_LABEL: Record<BlastRadius, string> = {
  read: 'Solo lectura',
  internal_write: 'Escribe adentro',
  external_send: 'Sale de la empresa',
  bulk: 'Operación masiva',
};

/** Human name for an integration provider a tool depends on. */
export const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google',
  hubspot: 'HubSpot',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABEL[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}
