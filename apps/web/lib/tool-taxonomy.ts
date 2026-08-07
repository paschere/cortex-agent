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
    blurb: 'La lista de prioridades y los resúmenes que Cortex arma con todo lo que alcanza a ver.',
    tone: 'sky',
    icon: 'Inbox',
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
    id: 'vehicles',
    name: 'Vehículos y trámites',
    blurb:
      'SOAT y RTM desde el RUNT, comparendos desde el SIMIT, y todo lo que se vence con fecha: contratos, pólizas, plazos de aduana y pagos.',
    tone: 'emerald',
    icon: 'Car',
  },
  {
    id: 'auto',
    name: 'Automatización',
    blurb: 'Procedimientos que cualquiera puede ejecutar y rutinas que corren solas.',
    tone: 'primary',
    icon: 'Workflow',
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
  vehicles: 'vehicles',
  // Sits with the fleet rather than with automation: a SOAT that lapses is a
  // truck off the road, and the person who cares about one cares about the
  // other. The watcher being automatic is an implementation detail to them.
  commitments: 'vehicles',
  pipeline: 'auto',
  schedule: 'auto',
  cortex: 'auto',
  web: 'external',
  security: 'control',
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
