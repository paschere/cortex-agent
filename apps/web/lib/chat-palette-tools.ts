/**
 * LAS HERRAMIENTAS DEL CATÁLOGO, DICHAS COMO LAS DIRÍA UNA PERSONA.
 *
 * El registro tiene ~135 herramientas y todas traen una descripción en INGLÉS
 * escrita para el modelo: «Search the user's Gmail with a Gmail query string
 * (e.g. "from:foo subject:bar newer_than:30d")». Eso no es una fila de menú, es
 * documentación de una API. Y `toolActionLabel` — que es lo que usa la pantalla
 * de Herramientas — devuelve «Search Contacts», que tampoco lo es.
 *
 * Así que aquí está la frase en español de cada herramienta, y es la frase que
 * se ESCRIBE en el compositor al elegirla. No una etiqueta que luego hay que
 * traducir a una petición: la fila dice «Busca en Gmail » y lo que queda en el
 * compositor es «Busca en Gmail », con el cursor listo para el resto. Esa es la
 * misma regla que ya cumplían los nueve comandos fijos, y la razón por la que
 * el menú no puede ampliar lo que el modelo ve.
 *
 * ===========================================================================
 * SÓLO SALE LO QUE ESTÁ CURADO
 * ===========================================================================
 * Una herramienta del registro que no aparezca en este mapa NO se ofrece. Es
 * deliberado y es la única regla que mantiene el menú en español: la
 * alternativa —caer a `Family · Action`— llenaría el menú de «HubSpot · Search
 * Contacts», que es exactamente lo que este archivo existe para evitar. El
 * costo es que una herramienta nueva no aparece hasta que alguien le escriba su
 * frase, y ese costo es una línea.
 *
 * Las herramientas propias del espacio de trabajo son la excepción y no una
 * grieta: su nombre lo escribió un administrador de la empresa, en sus propias
 * palabras, así que ya está curado por quien corresponde.
 */

import 'server-only';
import { MODULE } from './browser-shape';
import {
  type PaletteGroup,
  type PaletteItem,
  STATIC_COMMAND_GROUP,
  fold,
} from './chat-palette-shape';
import { CAPABILITY_GROUPS, familyLabel, familyOf, groupOfFamily } from './tool-taxonomy';

/**
 * Tool id → la frase con la que alguien pediría esa herramienta.
 *
 * Un espacio al final significa «falta el complemento»: la placa, el nombre del
 * cliente, el texto a buscar. Sin espacio, la frase ya es una pregunta entera.
 */
export const TOOL_PHRASE: Record<string, string> = {
  'actions.list': 'Muéstrame las acciones que esperan mi aprobación',
  'actions.propose': 'Déjame redactado un mensaje para ',

  // La otra cola, y las dos frases tienen que distinguirse leídas seguidas en
  // el mismo menú: arriba son borradores que Cortex escribió y nadie ha
  // mandado; esto son llamadas que se pararon a medio ejecutar en otra
  // conversación —Claude, Google Chat, WhatsApp— y siguen paradas.
  'approvals.list': '¿Qué espera mi aprobación?',

  'browser.list_flows': `Muéstrame los ${MODULE.many} que ya aprendiste`,
  'browser.run_flow': `Corre el ${MODULE.one} `,
  'browser.submit_flow': `Radica el ${MODULE.one} `,

  'chat.send_dm': 'Escríbele por Google Chat a ',
  'chat.send_message': 'Publica en el espacio de Google Chat ',

  'clients.link': 'Cuelga esto del cliente ',
  'clients.overview': 'Dame el panorama completo del cliente ',
  'clients.register': 'Registra al cliente ',
  'clients.search': 'Busca al cliente ',

  'commitments.confirm_extracted': 'Confirma los vencimientos que sacaste del documento ',
  'commitments.due_soon': '¿Qué se nos vence pronto?',
  'commitments.extract_from_document': 'Sácale los vencimientos al documento ',
  'commitments.mark_met': 'Marca como cumplido el vencimiento ',
  'commitments.pending_review': 'Muéstrame los vencimientos que faltan por revisar',
  'commitments.record': 'Anota este vencimiento: ',
  'commitments.reject_extracted': 'Descarta el vencimiento propuesto ',

  'cortex.forget': 'Olvida lo que sabes sobre ',
  'cortex.process': 'Resume y sácale los datos a este texto: ',
  'cortex.remember': 'Recuerda de aquí en adelante que ',

  'documents.confirm': 'Confirma lo que leíste del documento ',
  'documents.correction_stats': '¿Qué campos de los documentos toca corregir siempre?',
  'documents.extract': 'Léelo y sácale los datos al documento ',
  'documents.pending_review': 'Muéstrame los documentos leídos que faltan por confirmar',
  'documents.records': 'Búscame los documentos confirmados de ',
  'documents.reject': 'Descarta la lectura del documento ',
  'documents.totals': 'Súmame los documentos de ',

  'errands.answer': 'Respóndele al encargo: ',
  'errands.start': 'Investígame ',
  'errands.status': '¿En qué va lo que te encargué?',

  'gcal.create_event': 'Agéndame una reunión ',
  'gcal.list_events': 'Muéstrame la agenda de ',
  'gcal.upcoming_meetings': '¿Qué reuniones tengo próximamente?',

  'gdrive.read_doc': 'Léeme el documento de Drive ',
  'gdrive.search_files': 'Busca en Drive ',

  'github.create_issue': 'Crea un issue en GitHub: ',
  'github.create_issue_comment': 'Comenta en el issue de GitHub ',
  'github.get_issue': 'Muéstrame el issue de GitHub ',
  'github.get_repo_contents': 'Léeme el archivo del repositorio ',
  'github.get_repository': 'Muéstrame el repositorio ',
  'github.list_issue_comments': 'Muéstrame los comentarios del issue ',
  'github.list_pull_requests': 'Muéstrame los pull requests de ',
  'github.list_repositories': 'Muéstrame los repositorios de GitHub',
  'github.pr_metrics': '¿Cómo vamos de tiempos de revisión y de merge?',
  'github.repo_activity': 'Resume la actividad del repositorio ',

  'gmail.draft': 'Redáctame un correo para ',
  'gmail.list_threads': 'Muéstrame los correos con ',
  'gmail.read_thread': 'Léeme el hilo de correo ',
  'gmail.search': 'Busca en Gmail ',
  'gmail.send_draft': 'Envía el borrador de Gmail ',
  'gmail.send_message': 'Manda este correo tal cual: ',

  'growth.find_signals': 'Búscame señales de mercado nuevas',
  'growth.identify_contact': 'Averigua quién decide en ',
  'growth.list_signals': 'Muéstrame las señales de mercado guardadas',
  'growth.update_signal': 'Califica la señal de mercado ',

  // Metas. La de fijar deja el número por escribir a propósito: el objetivo lo
  // dice la empresa, y una frase que ya lo trajera puesto sería Cortex fijando
  // una meta que nadie declaró.
  // La frase es la pregunta de auditoría, no «muéstrame la ficha»: quien la
  // escribe está comprobando de dónde salen las respuestas que recibe, y la
  // herramienta contesta con lo que sabe Y con lo que le falta.
  'company.facts': '¿Qué sabes de nuestra empresa?',
  'goals.list': '¿Cómo vamos con las metas?',
  'goals.measure': '¿Cómo va la meta en lo que va del período?',
  'goals.offer_metrics': '¿Qué puedes medir de esta empresa?',
  'goals.set': 'Fija la meta de ',

  'gsheets.append_row': 'Agrégale una fila a la hoja ',
  'gsheets.read_range': 'Léeme el rango de la hoja ',

  'hubspot.get_company': 'Muéstrame la empresa de HubSpot ',
  'hubspot.get_contact': 'Muéstrame el contacto de HubSpot ',
  'hubspot.get_contact_timeline': 'Muéstrame el historial del contacto ',
  'hubspot.get_deal': 'Muéstrame el negocio de HubSpot ',
  'hubspot.get_pipeline_summary': '¿Cómo está el embudo de ventas?',
  // Las de ESCRIBIR en HubSpot (crear contacto, crear negocio, mover etapa,
  // registrar actividad) están escritas en el paquete pero no exportadas desde
  // `hubspot/index.ts`, así que el registro no las tiene y no hay nada que
  // ofrecer. La prueba de arriba lo comprueba contra `listTools()` en vez de
  // fiarse de esta nota: el día que se exporten, falla y pide su frase.
  'hubspot.list_recent_activities': 'Muéstrame la actividad reciente con ',
  'hubspot.search_companies': 'Busca empresas en HubSpot: ',
  'hubspot.search_contacts': 'Busca contactos en HubSpot: ',
  'hubspot.search_deals': 'Busca negocios en HubSpot: ',

  'inbox.deliver_digest': 'Mándame ya mi resumen de bandeja',
  'inbox.due_digests': '¿A quién le toca resumen de bandeja ahora?',
  // La pregunta de apertura. Se distingue de la de arriba leída en el mismo
  // menú: aquélla es el correo del día, ésta es el trabajo parado en las cuatro
  // colas de Cortex.
  'inbox.overview': '¿Qué me espera?',
  'inbox.priorities': '¿Qué tengo pendiente en el correo hoy?',

  'kb.context': 'Ármame el contexto de Brain Knowledge sobre ',
  'kb.create_document': 'Guarda esto en Brain Knowledge: ',
  'kb.list_spaces': 'Muéstrame los espacios de Brain Knowledge',
  'kb.search': 'Busca en Brain Knowledge ',

  'linear.create_comment': 'Comenta en el issue de Linear ',
  'linear.create_issue': 'Crea un issue en Linear: ',
  'linear.cycle_stats': '¿Cómo va el ciclo del equipo en Linear?',
  'linear.get_issue': 'Muéstrame el issue de Linear ',
  'linear.get_project': 'Muéstrame el proyecto de Linear ',
  'linear.list_comments': 'Muéstrame los comentarios del issue de Linear ',
  'linear.list_issues': 'Muéstrame los issues de Linear de ',
  'linear.list_projects': 'Muéstrame los proyectos de Linear',
  'linear.list_teams': 'Muéstrame los equipos de Linear',
  'linear.workload_stats': '¿Cómo está repartida la carga del equipo?',

  'meetings.get_transcript': 'Léeme la transcripción de la reunión ',
  'meetings.import_transcript': 'Guarda en Brain Knowledge la reunión ',
  'meetings.list_transcripts': 'Muéstrame las reuniones que dejaron transcripción',
  'meetings.prepare_briefing': 'Prepárame para la reunión ',
  'meetings.schedule_briefings': 'Prepárame un briefing antes de cada reunión de mañana',

  'mscal.create_event': 'Agéndame en Outlook una reunión ',
  'mscal.list_events': 'Muéstrame la agenda de Outlook de ',

  'outlook.archive_thread': 'Archiva en Brain Knowledge el hilo de Outlook ',
  'outlook.draft': 'Redáctame en Outlook un correo para ',
  'outlook.list_threads': 'Muéstrame los correos de Outlook con ',
  'outlook.read_thread': 'Léeme el hilo de Outlook ',
  'outlook.search': 'Busca en Outlook ',
  'outlook.send_draft': 'Envía el borrador de Outlook ',

  'payments.disputes': '¿Qué pagos están en disputa entre dos fuentes?',
  'payments.list': 'Muéstrame los pagos de ',
  'payments.receivables': '¿Cuánto nos deben?',
  'payments.record': 'Anota un pago de ',
  'payments.resolve_dispute': 'Resuelve la disputa del pago ',

  'payroll.client_report': 'Dame el costo del equipo puesto en el cliente ',
  'payroll.cost_projection': 'Proyéctame lo que va a costar el equipo en ',
  'payroll.employee_profile': 'Dame el perfil de ',
  'payroll.expenses_report': 'Dame el informe de gastos de ',
  'payroll.payroll_stats': '¿Cuánto nos ha costado la nómina?',
  'payroll.team_assignments': '¿Quién está asignado a cada cliente?',
  'payroll.team_overview': 'Dame el panorama del equipo, sin nombres ni sueldos',

  'people.search': 'Búscame el correo de ',

  'pipeline.create': 'Guarda esto como un flujo reutilizable: ',
  'pipeline.finish_run': 'Cierra la ejecución del flujo con este resultado: ',
  'pipeline.get': 'Muéstrame los pasos del flujo ',
  'pipeline.list': 'Muéstrame los flujos guardados',
  'pipeline.run': 'Ejecuta el flujo ',
  'pipeline.update': 'Modifícame el flujo ',

  'presentations.create_pdf': 'Ármame el PDF de presentación de ',
  'presentations.list_recent': 'Muéstrame las presentaciones que ya se enviaron',
  'presentations.pick_candidate': 'Muéstrame quiénes están en la requisición de ',

  'reports.chart': 'Gráfica ',
  'reports.generate': 'Hazme el informe de ',
  'reports.list': 'Muéstrame los informes guardados',
  'reports.open': 'Ábreme el informe de ',
  'reports.share': 'Comparte por enlace el informe de ',

  'sales.draft_proposal': 'Redáctame una propuesta para ',

  'schedule.create': 'Todos los lunes a las 8 de la mañana, ',
  'schedule.list': 'Muéstrame mis rutinas programadas',
  'schedule.update': 'Pausa la rutina ',

  'security.recent_events': 'Muéstrame lo que la seguridad frenó últimamente',
  'security.review_action': 'Dime qué diría la seguridad si intento ',

  'slack.post_message': 'Publica en Slack, en el canal ',

  'vehicles.check_runt': 'Consulta en el RUNT la placa ',
  'vehicles.check_simit': 'Consulta en el SIMIT la placa ',
  'vehicles.get': 'Muéstrame todo lo de la placa ',
  'vehicles.list': 'Muéstrame los vehículos que estoy vigilando',
  'vehicles.recently_changed': '¿Qué cambió en la flota desde la última vez?',
  'vehicles.register': 'Registra el vehículo de placa ',

  'web.scrape': 'Ábreme y resúmeme esta página: ',
  'web.search': 'Busca en internet ',
};

// ---------------------------------------------------------------------------
// Dos frases que las filas necesitan y que una ruta no puede exportar
// ---------------------------------------------------------------------------
// Next prohíbe exportar cualquier cosa que no sea un handler desde un
// `route.ts`, así que estas dos viven aquí. Sale ganando la prueba: son puras
// y tienen casos de borde de verdad.

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/**
 * Un cron dicho en palabras, sólo para las formas que la gente usa de verdad.
 * NO es un intérprete de cron: cuando no reconoce la forma devuelve la
 * expresión tal cual. Es feo y es honesto — inventarle una frase a un cron que
 * no se entendió es cómo alguien acaba creyendo que su rutina corre los lunes.
 */
export function cronPhrase(cron: string | null, timezone: string): string {
  if (!cron) return 'una sola vez';
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const minute = parts[0] ?? '';
  const hour = parts[1] ?? '';
  const dom = parts[2] ?? '';
  const month = parts[3] ?? '';
  const dow = parts[4] ?? '';
  if (!/^\d+$/.test(minute) || !/^\d+$/.test(hour)) return cron;
  const at = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  // La zona sólo se nombra cuando NO es la de la persona. Un «08:00 UTC» en la
  // fila de una rutina que corre a las 3am hora local es la clase de detalle
  // que sólo se lee cuando ya pasó algo raro.
  const zone = timezone && timezone !== 'UTC' ? '' : ' UTC';
  if (month !== '*') return cron;
  if (dom === '*' && dow === '*') return `todos los días a las ${at}${zone}`;
  if (dom === '*') {
    if (dow === '1-5') return `de lunes a viernes a las ${at}${zone}`;
    const day = /^\d$/.test(dow) ? DAY_NAMES[Number(dow) % 7] : undefined;
    if (day) return `todos los ${day} a las ${at}${zone}`;
    return cron;
  }
  if (dow === '*' && /^\d+$/.test(dom)) return `el día ${dom} de cada mes a las ${at}${zone}`;
  return cron;
}

/** `https://www.runt.gov.co` → `runt.gov.co`. Nadie lee un esquema. */
export function siteName(host: string | null): string | null {
  if (!host) return null;
  return host.replace(/^https?:\/\//, '').replace(/^www\./, '') || null;
}

// ---------------------------------------------------------------------------
// Qué herramientas puede realmente ejecutar QUIEN ESTÁ ESCRIBIENDO
// ---------------------------------------------------------------------------

/**
 * Un menú que ofrece algo que la persona no puede ejecutar es peor que un menú
 * corto: promete y falla, y falla después de que ya escribió la frase. Así que
 * la lista se recorta contra las cuatro murallas reales, en el mismo orden en
 * que las encuentra el runtime:
 *
 *   1. el agente que está contestando no la tiene concedida    → no existe
 *   2. algún equipo de esta persona la bloqueó                 → no existe
 *   3. la integración que necesita no está conectada           → no existe
 *   4. al despliegue le falta una credencial BLOQUEANTE        → no existe
 *
 * La cuarta distingue bloqueante de degradada a propósito: Brain Knowledge sin
 * llave de embeddings sigue buscando por palabras, así que sigue en el menú.
 */
export interface ToolAvailability {
  id: string;
  /** Proveedores OAuth que la herramienta exige. */
  providers: string[];
  /** Variables de entorno que este despliegue NO tiene. */
  missingCredentials: string[];
  /** Si esa credencial la mata o sólo la degrada. */
  blockingCredential: boolean;
}

export interface AccessFilter {
  /** Patrones que los equipos de esta persona le restan. */
  denied: string[];
  /** `allowed_tool_ids` del agente que va a contestar. `['*']` es todo. */
  granted: string[];
  connectedProviders: Set<string>;
}

/**
 * Mismas reglas que `matchPattern` dentro del registro, INCLUIDO el `*` pelado
 * que `matchesPattern` de la taxonomía no conoce. Un agente con `*` tiene todo,
 * y tratarlo como «sin concesiones» dejaba el menú sin una sola herramienta.
 */
function matchesGrant(toolId: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return toolId.startsWith(pattern.slice(0, -1));
  return pattern === toolId;
}

export function usableToolIds(tools: ToolAvailability[], access: AccessFilter): string[] {
  return tools
    .filter((tool) => {
      if (!access.granted.some((pattern) => matchesGrant(tool.id, pattern))) return false;
      if (access.denied.some((pattern) => matchesGrant(tool.id, pattern))) return false;
      if (tool.providers.some((provider) => !access.connectedProviders.has(provider))) return false;
      if (tool.blockingCredential && tool.missingCredentials.length > 0) return false;
      return true;
    })
    .map((tool) => tool.id);
}

// ---------------------------------------------------------------------------
// De ids a secciones del menú
// ---------------------------------------------------------------------------

/** Una herramienta propia del espacio de trabajo, con el nombre de su dueño. */
export interface WorkspaceTool {
  id: string;
  name: string;
  description: string;
}

/**
 * Agrupa por CAPACIDAD, no por familia. La familia (`gcal`, `gsheets`,
 * `mscal`) es la costura técnica y no le dice nada a nadie; nadie llega al chat
 * preguntándose qué vive bajo el prefijo `gcal`, llega preguntándose si Cortex
 * puede mover una reunión. `CAPABILITY_GROUPS` ya contesta esa segunda pregunta
 * en español y con su orden fijo, así que se reutiliza tal cual.
 *
 * La familia no se pierde: viaja como pista bajo cada fila («Google Calendar»),
 * que es lo que desempata dos herramientas que suenan igual en dos sistemas.
 */
export function toolPaletteGroups(
  toolIds: string[],
  workspaceTools: WorkspaceTool[] = [],
): PaletteGroup[] {
  const byGroup = new Map<string, PaletteItem[]>();

  const push = (groupId: string, item: PaletteItem) => {
    const list = byGroup.get(groupId);
    if (list) list.push(item);
    else byGroup.set(groupId, [item]);
  };

  for (const id of toolIds) {
    const phrase = TOOL_PHRASE[id];
    // Sin frase curada no hay fila. Ver la cabecera: la alternativa es un menú
    // en inglés, y un menú en inglés no es un menú para esta gente.
    if (!phrase) continue;
    const family = familyOf(id);
    push(groupOfFamily(family), {
      id,
      label: phrase.trimEnd(),
      hint: familyLabel(family),
      expands: phrase,
      // El id crudo se busca pero no se muestra: quien ya sabe que existe
      // `gmail.search` lo teclea, y quien no, no tiene por qué leerlo.
      keywords: id,
    });
  }

  for (const tool of workspaceTools) {
    push('custom', {
      id: tool.id,
      label: tool.name,
      hint: tool.description ? tool.description.slice(0, 90) : 'Herramienta propia',
      expands: `Usa «${tool.name}» para `,
      keywords: tool.id,
    });
  }

  const groups: PaletteGroup[] = [];
  for (const meta of CAPABILITY_GROUPS) {
    const items = byGroup.get(meta.id);
    if (!items || items.length === 0) continue;
    items.sort((a, b) => a.label.localeCompare(b.label, 'es'));
    groups.push({ id: `tools:${meta.id}`, heading: meta.name, icon: meta.icon, items });
  }
  return groups;
}

/**
 * Los comandos fijos ya no pueden repetir lo que ahora sale del catálogo. Sin
 * esto, teclear `/informe` devolvía dos filas idénticas en dos secciones
 * distintas, que es la forma más rápida de que alguien deje de confiar en un
 * menú. Gana el comando fijo: es más corto de teclear y lleva más tiempo en la
 * cabeza de la gente.
 */
export function dropDuplicateCommands(groups: PaletteGroup[]): PaletteGroup[] {
  const taken = new Set(STATIC_COMMAND_GROUP.items.map((item) => fold(item.expands.trim())));
  const out: PaletteGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((item) => !taken.has(fold(item.expands.trim())));
    if (items.length > 0 || group.error) out.push({ ...group, items });
  }
  return out;
}
