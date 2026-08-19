export const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  qualify_lead: { label: 'Calificar prospecto', icon: 'UserCheck' },
  hubspot_search_companies: { label: 'Buscar empresas en HubSpot', icon: 'Building2' },
  hubspot_get_company: { label: 'Ver detalle de la empresa', icon: 'Building2' },
  hubspot_search_deals: { label: 'Buscar negocios', icon: 'Briefcase' },
  hubspot_get_deal: { label: 'Ver detalle del negocio', icon: 'Briefcase' },
  hubspot_search_contacts: { label: 'Buscar contactos', icon: 'Users' },
  hubspot_get_contact: { label: 'Ver detalle del contacto', icon: 'User' },
  hubspot_create_deal: { label: 'Crear negocio', icon: 'PlusCircle' },
  hubspot_update_deal: { label: 'Actualizar negocio', icon: 'Edit' },
  hubspot_create_contact: { label: 'Crear contacto', icon: 'UserPlus' },
  hubspot_log_activity: { label: 'Registrar actividad', icon: 'ClipboardList' },
  hubspot_get_pipeline_summary: { label: 'Resumen del embudo', icon: 'BarChart2' },
  hubspot_list_recent_activities: { label: 'Actividad reciente', icon: 'Activity' },
  gmail_search: { label: 'Buscar en Gmail', icon: 'Mail' },
  gmail_read_thread: { label: 'Leer conversación de correo', icon: 'MailOpen' },
  gmail_draft: { label: 'Redactar correo', icon: 'Pencil' },
  gmail_send_draft: { label: 'Enviar el correo redactado', icon: 'Send' },
  gmail_send_message: { label: 'Enviar este correo tal cual', icon: 'Send' },
  actions_propose: { label: 'Dejar la acción lista para aprobar', icon: 'Send' },
  actions_list: { label: 'Ver lo que espera tu aprobación', icon: 'ListChecks' },
  // La OTRA cola, y las dos frases tienen que poder distinguirse leídas a
  // solas: `actions_list` son borradores que Cortex escribió, esto son llamadas
  // que se pararon a medio ejecutar y siguen paradas.
  approvals_list: { label: 'Ver lo que espera tu permiso para ejecutarse', icon: 'ShieldAlert' },
  gmail_list_threads: { label: 'Listar conversaciones de correo', icon: 'Inbox' },
  gcal_list_events: { label: 'Ver eventos del calendario', icon: 'Calendar' },
  gcal_create_event: { label: 'Crear evento en el calendario', icon: 'CalendarPlus' },
  gsheets_read_range: { label: 'Leer hoja de cálculo', icon: 'Table' },
  gsheets_append_row: { label: 'Agregar fila a la hoja', icon: 'TableProperties' },
  kb_search: { label: 'Buscar en Brain Knowledge', icon: 'BookOpen' },
  // Only ever offered on a turn that carried a frame of a shared tab, so this
  // label can name the person's own screen without qualifying it. It shows up
  // in the busy line while the box is being worked out; the result is a picture
  // rather than a step row, so it never becomes a task row. See ScreenMarks.tsx.
  screen_point_at: { label: 'Señalar en tu pantalla', icon: 'Crosshair' },
  // Se dibuja como tarjeta, no como renglón — `MessageBubble` la saca de los
  // pasos a propósito, porque un renglón que dice «Preguntarte» justo encima de
  // la pregunta es la única duplicación literal que TaskRows puede producir.
  // Este nombre existe para el medio segundo de la línea de actividad, y para
  // que la fila de auditoría de un turno no diga `ask_choice`.
  ask_choice: { label: 'Preguntarte', icon: 'HelpCircle' },
  sales_draft_proposal: { label: 'Redactar propuesta', icon: 'FileText' },
  web_search: { label: 'Buscar en internet', icon: 'Globe' },
  web_scrape: { label: 'Abrir página web', icon: 'Link' },
  browser_list_flows: { label: 'Ver los trámites aprendidos', icon: 'Globe' },
  browser_run_flow: { label: 'Hacer el trámite en el portal', icon: 'Globe' },
  browser_submit_flow: { label: 'Radicar el trámite en el portal', icon: 'Send' },
  gdrive_search_files: { label: 'Buscar archivos en Drive', icon: 'FolderSearch' },
  gdrive_read_doc: { label: 'Leer documento de Drive', icon: 'FileSearch' },
  schedule_create: { label: 'Programar rutina', icon: 'AlarmClockPlus' },
  schedule_list: { label: 'Ver rutinas programadas', icon: 'AlarmClock' },
  schedule_update: { label: 'Actualizar rutina', icon: 'AlarmClockCheck' },
  // Vehicles. The two lookups name the registry they hit rather than the tool,
  // because that is what the person waiting recognises — and a RUNT check runs
  // for the better part of half a minute, so it is on screen a while.
  vehicles_register: { label: 'Registrar vehículo', icon: 'Car' },
  vehicles_list: { label: 'Ver vehículos', icon: 'Car' },
  vehicles_get: { label: 'Ver detalle del vehículo', icon: 'Car' },
  vehicles_check_runt: { label: 'Consultar el RUNT (SOAT y tecnomecánica)', icon: 'ShieldCheck' },
  vehicles_check_simit: { label: 'Consultar el SIMIT (comparendos)', icon: 'ReceiptText' },
  vehicles_recently_changed: { label: 'Revisar cambios en la flota', icon: 'RefreshCw' },
  // La única de metas que se para a pedir permiso, y por eso la única que
  // necesita nombre: fijar una meta es una declaración de la empresa.
  goals_set: { label: 'Fijar una meta de la empresa', icon: 'Target' },

  // ===========================================================================
  // EL RESTO DEL REGISTRO, QUE HASTA AQUÍ SE DIBUJABA SOLO.
  //
  // Las cincuenta de arriba se escribieron a mano, una por una, según fueron
  // haciendo falta; las ciento once de abajo llevaban meses cayendo en
  // `humanizeToolId` y saliendo en pantalla como «Kb · Context» o «Payments ·
  // Receivables». Eso no se lee como un paso de trabajo: se lee como el
  // identificador de una función, que es exactamente lo que es. Y no fallaba
  // nada — por eso duró tanto. `tool-labels.test.ts` recorre ahora el registro
  // real y falla si alguna vuelve a quedarse sin frase.
  //
  // La voz es la misma de arriba y no la del `id`: verbo en infinitivo, lo que
  // la persona VE pasar, y el sistema por su nombre cuando es lo que reconoce
  // —RUNT, SIMIT, HubSpot, Drive, Outlook, Linear— en vez del nombre del
  // módulo. Ese es el criterio entero: «Consultar el SIMIT (comparendos)» y
  // `vehicles_check_simit` describen la misma llamada, y sólo una de las dos
  // le dice algo a quien está esperando.
  // ===========================================================================

  // Outlook / Microsoft 365: el mismo buzón que Gmail para las empresas que
  // corren Microsoft. Las frases nombran Outlook a propósito — quien lo usa no
  // reconoce «Ms Graph», reconoce el programa que tiene abierto.
  outlook_search: { label: 'Buscar en Outlook', icon: 'Mail' },
  outlook_read_thread: { label: 'Leer conversación de Outlook', icon: 'MailOpen' },
  outlook_list_threads: { label: 'Listar conversaciones de Outlook', icon: 'Inbox' },
  outlook_draft: { label: 'Redactar correo en Outlook', icon: 'Pencil' },
  outlook_send_draft: { label: 'Enviar el correo redactado en Outlook', icon: 'Send' },
  outlook_archive_thread: { label: 'Guardar el correo en Brain Knowledge', icon: 'Archive' },
  mscal_list_events: { label: 'Ver el calendario de Outlook', icon: 'Calendar' },
  mscal_create_event: { label: 'Crear evento en el calendario de Outlook', icon: 'CalendarPlus' },

  // Calendario de Google. Las otras dos ya están arriba con el resto de Google.
  gcal_upcoming_meetings: { label: 'Ver las próximas reuniones', icon: 'CalendarClock' },

  // Trámites web. Las otras tres están arriba. Ésta se dibuja justo después de
  // que alguien dictó el código que le llegó al celular, así que dice que se
  // RETOMA lo que estaba parado y no que se «reanuda un flujo».
  browser_resume_flow: { label: 'Retomar el trámite con lo que dijiste', icon: 'Play' },

  // HubSpot: la única que faltaba del CRM.
  hubspot_get_contact_timeline: { label: 'Ver el historial del contacto', icon: 'History' },

  // GitHub. «Incidencia» y no «issue» por la misma razón por la que el resto
  // del mapa está en español: quien lee estos renglones puede no ser quien
  // escribe el código.
  github_list_repositories: { label: 'Ver repositorios de GitHub', icon: 'FolderGit2' },
  github_get_repository: { label: 'Ver detalle del repositorio', icon: 'FolderGit2' },
  github_get_repo_contents: { label: 'Leer archivos del repositorio', icon: 'FileCode' },
  github_get_issue: { label: 'Ver la incidencia de GitHub', icon: 'CircleDot' },
  github_list_issue_comments: {
    label: 'Leer los comentarios de la incidencia',
    icon: 'MessageSquare',
  },
  github_list_pull_requests: { label: 'Ver los pull requests', icon: 'GitPullRequest' },
  github_repo_activity: { label: 'Resumir la actividad del repositorio', icon: 'Activity' },
  github_pr_metrics: { label: 'Medir la salud de los pull requests', icon: 'GitMerge' },
  github_create_issue: { label: 'Crear una incidencia en GitHub', icon: 'CirclePlus' },
  github_create_issue_comment: { label: 'Comentar en GitHub', icon: 'MessageSquarePlus' },

  // Linear.
  linear_list_teams: { label: 'Ver los equipos de Linear', icon: 'Users' },
  linear_list_projects: { label: 'Ver los proyectos de Linear', icon: 'FolderKanban' },
  linear_get_project: { label: 'Ver detalle del proyecto', icon: 'FolderKanban' },
  linear_list_issues: { label: 'Ver tareas en Linear', icon: 'ListTodo' },
  linear_get_issue: { label: 'Ver detalle de la tarea', icon: 'Ticket' },
  linear_list_comments: { label: 'Leer los comentarios de la tarea', icon: 'MessageSquare' },
  linear_cycle_stats: { label: 'Medir el avance del ciclo', icon: 'Gauge' },
  linear_workload_stats: { label: 'Ver la carga de cada persona', icon: 'Scale' },
  linear_create_issue: { label: 'Crear tarea en Linear', icon: 'CirclePlus' },
  linear_create_comment: { label: 'Comentar en la tarea', icon: 'MessageSquarePlus' },

  // Brain Knowledge. `kb_search` ya está arriba; éstas tres son las que
  // producían «Kb · Context», el renglón que empezó todo esto.
  kb_list_spaces: { label: 'Ver los espacios de Brain Knowledge', icon: 'Library' },
  kb_create_document: { label: 'Guardar en Brain Knowledge', icon: 'BookPlus' },
  kb_context: { label: 'Reunir contexto de Brain Knowledge', icon: 'BookMarked' },
  // El adjunto de un turno mudándose al cerebro. Dice «el adjunto» y no «el
  // archivo» porque quien lo pide acaba de subirlo en esta misma conversación.
  attachments_promote: { label: 'Guardar el adjunto en Brain Knowledge', icon: 'BookPlus' },

  // Nómina y equipo. Es la familia que más cuidado necesita: cada una de estas
  // frases se dibuja al lado de cifras de plata de personas con nombre, así que
  // dice EXACTAMENTE qué se miró y nunca más de lo que se miró.
  payroll_team_overview: { label: 'Ver el tamaño del equipo', icon: 'Users' },
  payroll_team_assignments: { label: 'Ver quién está con cada cliente', icon: 'ClipboardList' },
  payroll_employee_profile: { label: 'Ver la ficha de alguien del equipo', icon: 'UserRound' },
  payroll_expenses_report: { label: 'Ver gastos y reembolsos del equipo', icon: 'Receipt' },
  payroll_payroll_stats: { label: 'Ver cuánto cuesta la nómina', icon: 'Wallet' },
  payroll_client_report: { label: 'Ver el costo de la cuenta del cliente', icon: 'Calculator' },
  payroll_cost_projection: { label: 'Proyectar el costo del equipo', icon: 'TrendingUp' },

  // Internet. Las otras dos están arriba.
  web_news: { label: 'Buscar noticias', icon: 'Newspaper' },

  // Presentaciones de candidatos.
  presentations_pick_candidate: { label: 'Elegir de quién es la presentación', icon: 'UserSearch' },
  presentations_create_pdf: { label: 'Armar la presentación en PDF', icon: 'Presentation' },
  presentations_list_recent: { label: 'Ver presentaciones ya armadas', icon: 'Files' },

  // Mensajería de equipo.
  slack_post_message: { label: 'Publicar en un canal de Slack', icon: 'Hash' },
  chat_send_message: { label: 'Publicar en Google Chat', icon: 'MessageSquare' },
  chat_send_dm: { label: 'Mandar un privado por Google Chat', icon: 'MessageCircle' },

  // Directorio de personas.
  people_search: { label: 'Buscar el correo de una persona', icon: 'Contact' },
  directory_line: { label: 'Ver quién le responde a quién', icon: 'Network' },

  // Oportunidades: vacantes públicas que delatan que una empresa está creciendo.
  growth_find_signals: { label: 'Rastrear vacantes que son oportunidad', icon: 'Radar' },
  growth_list_signals: { label: 'Ver las oportunidades detectadas', icon: 'Telescope' },
  growth_update_signal: { label: 'Actualizar la oportunidad', icon: 'PencilLine' },
  growth_identify_contact: { label: 'Averiguar con quién hablar', icon: 'UserSearch' },

  // Vencimientos. «Compromiso» es la palabra del producto, pero lo que la
  // persona espera leer es qué se vence — por eso la primera lo dice así.
  commitments_due_soon: { label: 'Ver lo que se vence', icon: 'CalendarClock' },
  commitments_record: { label: 'Anotar un vencimiento para vigilarlo', icon: 'CalendarPlus' },
  commitments_mark_met: { label: 'Marcar el compromiso como cumplido', icon: 'CalendarCheck' },
  commitments_pending_review: {
    label: 'Ver los vencimientos por confirmar',
    icon: 'ClipboardCheck',
  },
  commitments_extract_from_document: {
    label: 'Leer los vencimientos de un documento',
    icon: 'ScanText',
  },
  commitments_confirm_extracted: {
    label: 'Confirmar el vencimiento leído del documento',
    icon: 'CheckCheck',
  },
  commitments_reject_extracted: { label: 'Descartar el vencimiento leído', icon: 'CircleX' },

  // Clientes.
  clients_search: { label: 'Buscar un cliente', icon: 'Search' },
  clients_directory: { label: 'Ver el directorio de clientes', icon: 'Building2' },
  clients_overview: { label: 'Ver la ficha del cliente', icon: 'Building2' },
  clients_register: { label: 'Registrar o actualizar el cliente', icon: 'Building' },
  clients_link: { label: 'Enganchar esto a la ficha del cliente', icon: 'Link2' },

  // Documentos: facturas, guías, declaraciones. Lo que se lee de ellos no
  // cuenta hasta que una persona lo confirma, y las frases mantienen esa
  // diferencia — «leer» no es «confirmar».
  documents_extract: { label: 'Leer los datos del documento', icon: 'ScanText' },
  documents_pending_review: { label: 'Ver los documentos por confirmar', icon: 'FileClock' },
  documents_confirm: { label: 'Confirmar lo que se leyó del documento', icon: 'FileCheck' },
  documents_reject: { label: 'Descartar la lectura del documento', icon: 'FileX' },
  documents_correction_stats: {
    label: 'Ver qué campos siempre hay que corregir',
    icon: 'FileWarning',
  },
  documents_records: { label: 'Ver los documentos confirmados', icon: 'Files' },
  documents_totals: { label: 'Sumar lo facturado', icon: 'Sigma' },

  // Plata que entró y plata que falta.
  payments_record: { label: 'Registrar un pago que entró', icon: 'HandCoins' },
  payments_list: { label: 'Ver los pagos registrados', icon: 'Coins' },
  payments_receivables: { label: 'Ver la cartera', icon: 'CircleDollarSign' },
  payments_disputes: { label: 'Ver los pagos que no cuadran', icon: 'TriangleAlert' },
  payments_resolve_dispute: { label: 'Resolver el pago que no cuadra', icon: 'Gavel' },

  // Metas. `goals_set` está arriba porque se para a pedir permiso.
  goals_offer_metrics: { label: 'Ver qué se puede medir aquí', icon: 'Ruler' },
  goals_list: { label: 'Ver las metas y cómo van', icon: 'Flag' },
  goals_measure: { label: 'Medir cómo vamos este período', icon: 'Gauge' },

  // La ficha de la empresa.
  company_facts: { label: 'Leer la ficha de la empresa', icon: 'Landmark' },

  // Informes.
  reports_generate: { label: 'Armar el informe', icon: 'FileBarChart' },
  reports_list: { label: 'Ver los informes guardados', icon: 'Files' },
  reports_open: { label: 'Abrir un informe guardado', icon: 'FileSearch' },
  reports_share: { label: 'Compartir el informe por enlace', icon: 'Share2' },
  reports_chart: { label: 'Dibujar un gráfico', icon: 'ChartColumn' },
  reports_compose: { label: 'Armar un informe a la medida', icon: 'LayoutTemplate' },
  reports_run: { label: 'Volver a correr el informe', icon: 'RefreshCw' },
  reports_recipes: { label: 'Ver los informes a la medida guardados', icon: 'Layers' },

  // Encargos: trabajo que Cortex se lleva y hace solo durante minutos u horas.
  errands_start: { label: 'Encargarle el trabajo a Cortex', icon: 'Rocket' },
  errands_status: { label: 'Ver en qué va el encargo', icon: 'Hourglass' },
  errands_answer: { label: 'Contestarle al encargo', icon: 'Reply' },

  // Procedimientos guardados: una secuencia de pasos con nombre, que se repite.
  pipeline_create: { label: 'Guardar un procedimiento', icon: 'Workflow' },
  pipeline_list: { label: 'Ver los procedimientos guardados', icon: 'ListOrdered' },
  pipeline_get: { label: 'Ver el procedimiento', icon: 'Workflow' },
  pipeline_update: { label: 'Actualizar el procedimiento', icon: 'PencilRuler' },
  pipeline_run: { label: 'Ejecutar el procedimiento', icon: 'Play' },
  pipeline_finish_run: { label: 'Cerrar la ejecución del procedimiento', icon: 'CircleCheck' },

  // Reuniones.
  meetings_list_transcripts: { label: 'Ver qué reuniones dejaron transcripción', icon: 'Video' },
  meetings_get_transcript: { label: 'Leer la transcripción de la reunión', icon: 'ScrollText' },
  meetings_import_transcript: { label: 'Guardar la reunión en Brain Knowledge', icon: 'Mic' },
  meetings_prepare_briefing: { label: 'Preparar la reunión', icon: 'NotebookPen' },
  meetings_schedule_briefings: {
    label: 'Programar el aviso antes de cada reunión',
    icon: 'BellRing',
  },

  // Lo que Cortex recuerda de ti, y su propio motor de texto.
  cortex_remember: { label: 'Recordar esto tuyo', icon: 'Brain' },
  cortex_forget: { label: 'Olvidar eso que recordaba', icon: 'Eraser' },
  cortex_process: { label: 'Procesar el texto aparte', icon: 'Cpu' },

  // Seguridad. `approvals_list` está arriba: es la cola, no el registro.
  security_review_action: { label: 'Consultar si esto pasa el filtro', icon: 'Shield' },
  security_recent_events: { label: 'Ver lo que marcó la seguridad', icon: 'Siren' },

  // La bandeja: las cuatro colas donde el trabajo de alguien se para.
  inbox_overview: { label: 'Ver qué está esperando por ti', icon: 'LayoutDashboard' },
  inbox_priorities: { label: 'Priorizar lo que llegó a tu correo', icon: 'Inbox' },
  inbox_deliver_digest: { label: 'Mandar el resumen del día', icon: 'Send' },
  inbox_due_digests: { label: 'Ver a quién le toca el resumen del día', icon: 'AlarmClock' },
};

function toTitleCase(s: string): string {
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Maps a raw tool id to a human label and Lucide icon name.
 * Tool ids may arrive in dotted (`hubspot.search_deals`) or underscored
 * (`hubspot_search_deals`) form; both normalize to the same lookup key.
 */
export function toolLabel(toolId: string): { label: string; icon: string } {
  const key = toolId.replace(/\./g, '_');
  return TOOL_LABELS[key] ?? { label: toTitleCase(toolId), icon: 'Wrench' };
}

/**
 * `Family · Action` rendering of a tool id, for surfaces that have no curated
 * label to fall back on (approval emails, Chat DMs, archived transcripts).
 *
 * Ids reach us in two shapes: dotted as declared (`hubspot.update_deal`) and
 * underscored as the AI SDK / MCP persist them (`hubspot_update_deal`). Both
 * normalize to the same output.
 */
export function humanizeToolId(toolId: string): string {
  const [family = '', ...rest] = toolId.replace(/\./g, '_').split('_');
  const cap = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  const action = rest.map(cap).join(' ');
  return action ? `${cap(family)} · ${action}` : cap(family);
}

/**
 * The name a human should see for a tool. Curated label when we have one,
 * otherwise the `Family · Action` form — never the raw id.
 */
export function toolDisplayName(toolId: string): string {
  const key = toolId.replace(/\./g, '_');
  return TOOL_LABELS[key]?.label ?? humanizeToolId(toolId);
}

/**
 * A plain-Spanish sentence describing what a confirmation-gated action will do,
 * so someone can approve it without reading raw JSON. The interface is Spanish;
 * these strings are read by the person deciding, not by the model.
 */
export function confirmationSummary(toolId: string, input: Record<string, unknown>): string {
  const key = toolId.replace(/\./g, '_');
  switch (key) {
    case 'hubspot_update_deal':
      return `Actualizar el negocio${input.dealstage ? ` a la etapa "${input.dealstage}"` : ''}${input.amount ? ` · monto $${input.amount}` : ''}`;
    case 'hubspot_create_deal':
      return `Crear el negocio "${input.dealname}" en la etapa "${input.dealstage}"`;
    case 'hubspot_create_contact':
      return `Crear el contacto ${[input.firstName, input.lastName].filter(Boolean).join(' ')} <${input.email}>`;
    case 'hubspot_log_activity':
      return `Registrar ${input.type} "${input.subject}" en ${input.associatedObjectType} ${input.associatedObjectId}`;
    case 'browser_submit_flow':
      return `Ejecutar el trámite "${input.flow}" en el portal, que radica o envía algo con la identidad de la empresa`;
    case 'gmail_send_draft':
      return `Enviar el correo redactado ${input.draftId}`;
    case 'gcal_create_event':
      return `Crear el evento "${input.summary}" el ${input.start}`;
    case 'gsheets_append_row':
      return `Agregar una fila a la hoja "${input.spreadsheetId}"`;
    case 'schedule_create': {
      const when =
        input.scheduleKind === 'once'
          ? `una vez, el ${input.runAt}`
          : `con la programación "${input.cron}" (${input.timezone ?? 'UTC'})`;
      // Spelled out because it is the one setting that lets the routine write
      // to other systems with nobody watching.
      const writes = input.allowUnattendedWrites ? ' · PUEDE ESCRIBIR sin supervisión' : '';
      return `Programar "${input.name}" — se ejecuta ${when}${writes}`;
    }
    case 'vehicles_register':
      return `Registrar el vehículo de placa ${input.plate}`;
    case 'goals_set':
      // Sin la dirección («no pasar de» / «al menos»), que no viene en la
      // entrada: la pone el catálogo al guardar, y adivinarla aquí sería
      // enseñarle a quien aprueba un objetivo que puede no ser el que se fija.
      return `Fijar la meta «${input.label || input.metricKey}» — objetivo ${input.targetValue}, ${
        input.cadence === 'week' ? 'semanal' : 'mensual'
      }`;
    default:
      return `Ejecutar: ${toolLabel(toolId).label}`;
  }
}
