/**
 * LA FRASE QUE DESCRIBE UNA LLAMADA PARADA, SIN ENSEÑAR SU PAYLOAD.
 *
 * ===========================================================================
 * POR QUÉ ESTO EXISTE DOS VECES EN EL REPOSITORIO
 * ===========================================================================
 * La copia gemela está en `apps/web/lib/tool-labels.ts` y NO se puede borrar
 * ninguna de las dos:
 *
 *   · La del navegador la usan `ConfirmationPrompt` y la tarjeta de
 *     aprobaciones, que son `'use client'`. Importar `@cortex/agent-tools`
 *     desde un componente de cliente arrastra `node:dns` al bundle y rompe el
 *     build de producción mientras el typecheck y las pruebas siguen en verde
 *     — está contado en `apps/web/lib/reports-shape.ts`, que ya lo vivió.
 *   · Esta la necesita `approvals.list`, que corre dentro del paquete y no
 *     puede importar nada de `apps/web` (la dependencia va al revés).
 *
 * Es el mismo trato que ya tienen `lib/actions-shape.ts` y
 * `lib/commitments-shape.ts`, y la duplicación se mantiene honesta igual: una
 * prueba en Node importa las dos y falla en cuanto discrepan
 * (`apps/web/lib/approvals-summary-parity.test.ts`). Un texto que se va de un
 * lado y no del otro deja de ser cosmético en cuanto la frase que aprueba una
 * persona deja de ser la frase que le contó el modelo.
 *
 * ===========================================================================
 * QUÉ PUEDE Y QUÉ NO PUEDE LLEVAR ESTA FRASE
 * ===========================================================================
 * Es lo ÚNICO derivado del payload que `approvals.list` deja entrar en el
 * contexto del modelo, y por eso cada rama nombra campos concretos —el destino,
 * la etapa, la placa, la fecha— en vez de volcar el objeto. La cola puede
 * contener una exportación de nómina; `Ejecutar: Enviar el correo redactado` es
 * una descripción, `{"rows": [...]}` es una fuga. Al añadir una rama aquí, la
 * pregunta no es «¿qué sé de esta llamada?» sino «¿qué necesita saber quien va
 * a decir que sí?».
 */

/**
 * El nombre en español de cada herramienta. Sólo el texto: los iconos son cosa
 * de la interfaz y viven con ella, en `apps/web/lib/tool-labels.ts`.
 */
export const TOOL_LABEL_TEXT: Record<string, string> = {
  qualify_lead: 'Calificar prospecto',
  hubspot_search_companies: 'Buscar empresas en HubSpot',
  hubspot_get_company: 'Ver detalle de la empresa',
  hubspot_search_deals: 'Buscar negocios',
  hubspot_get_deal: 'Ver detalle del negocio',
  hubspot_search_contacts: 'Buscar contactos',
  hubspot_get_contact: 'Ver detalle del contacto',
  hubspot_create_deal: 'Crear negocio',
  hubspot_update_deal: 'Actualizar negocio',
  hubspot_create_contact: 'Crear contacto',
  hubspot_log_activity: 'Registrar actividad',
  hubspot_get_pipeline_summary: 'Resumen del embudo',
  hubspot_list_recent_activities: 'Actividad reciente',
  gmail_search: 'Buscar en Gmail',
  gmail_read_thread: 'Leer conversación de correo',
  gmail_draft: 'Redactar correo',
  gmail_send_draft: 'Enviar el correo redactado',
  gmail_send_message: 'Enviar este correo tal cual',
  actions_propose: 'Dejar la acción lista para aprobar',
  actions_list: 'Ver lo que espera tu aprobación',
  approvals_list: 'Ver lo que espera tu permiso para ejecutarse',
  gmail_list_threads: 'Listar conversaciones de correo',
  gmail_archive_thread: 'Guardar el hilo en el cerebro',
  gmail_train_brain: 'Aprender de tu buzón',
  gmail_training_status: 'Ver cómo va el aprendizaje del buzón',
  gcal_list_events: 'Ver eventos del calendario',
  gcal_create_event: 'Crear evento en el calendario',
  gsheets_read_range: 'Leer hoja de cálculo',
  gsheets_append_row: 'Agregar fila a la hoja',
  kb_search: 'Buscar en Brain Knowledge',
  screen_point_at: 'Señalar en tu pantalla',
  // Como `screen_point_at`: no está en el registro —se declara en `/api/chat` y
  // no ejecuta nada— pero su nombre sí tiene que estar aquí, porque este
  // catálogo y el de `apps/web/lib/tool-labels.ts` son la misma tabla partida en
  // dos y `approvals-parity.test.ts` exige que no se separen.
  ask_choice: 'Preguntarte',
  sales_draft_proposal: 'Redactar propuesta',
  web_search: 'Buscar en internet',
  web_scrape: 'Abrir página web',
  browser_list_flows: 'Ver los trámites aprendidos',
  browser_run_flow: 'Hacer el trámite en el portal',
  browser_submit_flow: 'Radicar el trámite en el portal',
  browser_open_page: 'Abrir el sitio en una pestaña viva',
  browser_act: 'Dar un paso en la página',
  browser_read_page: 'Leer la página como está',
  browser_ask_person: 'Pedirte el volante de la pestaña',
  browser_request_secret: 'Pedirte una clave directo a la página',
  browser_close_page: 'Cerrar la pestaña',
  gdrive_search_files: 'Buscar archivos en Drive',
  gdrive_read_doc: 'Leer documento de Drive',
  schedule_create: 'Programar rutina',
  schedule_list: 'Ver rutinas programadas',
  schedule_update: 'Actualizar rutina',
  vehicles_register: 'Registrar vehículo',
  vehicles_list: 'Ver vehículos',
  vehicles_get: 'Ver detalle del vehículo',
  vehicles_check_runt: 'Consultar el RUNT (SOAT y tecnomecánica)',
  vehicles_check_simit: 'Consultar el SIMIT (comparendos)',
  vehicles_recently_changed: 'Revisar cambios en la flota',
  goals_set: 'Fijar una meta de la empresa',

  // El resto del registro. Iba cayendo a `toTitleCase`, o sea que una llamada
  // parada de `payments.receivables` se anunciaba como «Payments Receivables»
  // en el correo de aprobación y en la tarjeta de Google Chat. Las frases —y el
  // porqué de cada una— están comentadas en el gemelo de
  // `apps/web/lib/tool-labels.ts`; aquí sólo va el texto, y tiene que ser el
  // MISMO texto: `approvals-parity.test.ts` compara los dos mapas enteros.
  outlook_search: 'Buscar en Outlook',
  outlook_read_thread: 'Leer conversación de Outlook',
  outlook_list_threads: 'Listar conversaciones de Outlook',
  outlook_draft: 'Redactar correo en Outlook',
  outlook_send_draft: 'Enviar el correo redactado en Outlook',
  outlook_archive_thread: 'Guardar el correo en Brain Knowledge',
  mscal_list_events: 'Ver el calendario de Outlook',
  mscal_create_event: 'Crear evento en el calendario de Outlook',
  gcal_upcoming_meetings: 'Ver las próximas reuniones',
  browser_resume_flow: 'Retomar el trámite con lo que dijiste',
  hubspot_get_contact_timeline: 'Ver el historial del contacto',
  github_list_repositories: 'Ver repositorios de GitHub',
  github_get_repository: 'Ver detalle del repositorio',
  github_get_repo_contents: 'Leer archivos del repositorio',
  github_get_issue: 'Ver la incidencia de GitHub',
  github_list_issue_comments: 'Leer los comentarios de la incidencia',
  github_list_pull_requests: 'Ver los pull requests',
  github_repo_activity: 'Resumir la actividad del repositorio',
  github_pr_metrics: 'Medir la salud de los pull requests',
  github_create_issue: 'Crear una incidencia en GitHub',
  github_create_issue_comment: 'Comentar en GitHub',
  linear_list_teams: 'Ver los equipos de Linear',
  linear_list_projects: 'Ver los proyectos de Linear',
  linear_get_project: 'Ver detalle del proyecto',
  linear_list_issues: 'Ver tareas en Linear',
  linear_get_issue: 'Ver detalle de la tarea',
  linear_list_comments: 'Leer los comentarios de la tarea',
  linear_cycle_stats: 'Medir el avance del ciclo',
  linear_workload_stats: 'Ver la carga de cada persona',
  linear_create_issue: 'Crear tarea en Linear',
  linear_create_comment: 'Comentar en la tarea',
  kb_list_spaces: 'Ver los espacios de Brain Knowledge',
  kb_create_document: 'Guardar en Brain Knowledge',
  kb_share_space: 'Cambiar quién ve un espacio',
  kb_context: 'Reunir contexto de Brain Knowledge',
  attachments_promote: 'Guardar el adjunto en Brain Knowledge',
  payroll_team_overview: 'Ver el tamaño del equipo',
  payroll_team_assignments: 'Ver quién está con cada cliente',
  payroll_employee_profile: 'Ver la ficha de alguien del equipo',
  payroll_expenses_report: 'Ver gastos y reembolsos del equipo',
  payroll_payroll_stats: 'Ver cuánto cuesta la nómina',
  payroll_client_report: 'Ver el costo de la cuenta del cliente',
  payroll_cost_projection: 'Proyectar el costo del equipo',
  web_news: 'Buscar noticias',
  presentations_pick_candidate: 'Elegir de quién es la presentación',
  presentations_create_pdf: 'Armar la presentación en PDF',
  presentations_list_recent: 'Ver presentaciones ya armadas',
  slack_post_message: 'Publicar en un canal de Slack',
  chat_send_message: 'Publicar en Google Chat',
  chat_send_dm: 'Mandar un privado por Google Chat',
  people_search: 'Buscar el correo de una persona',
  directory_line: 'Ver quién le responde a quién',
  growth_find_signals: 'Rastrear vacantes que son oportunidad',
  growth_list_signals: 'Ver las oportunidades detectadas',
  growth_update_signal: 'Actualizar la oportunidad',
  growth_identify_contact: 'Averiguar con quién hablar',
  commitments_due_soon: 'Ver lo que se vence',
  commitments_record: 'Anotar un vencimiento para vigilarlo',
  commitments_mark_met: 'Marcar el compromiso como cumplido',
  commitments_pending_review: 'Ver los vencimientos por confirmar',
  commitments_extract_from_document: 'Leer los vencimientos de un documento',
  commitments_confirm_extracted: 'Confirmar el vencimiento leído del documento',
  commitments_reject_extracted: 'Descartar el vencimiento leído',
  clients_search: 'Buscar un cliente',
  clients_directory: 'Ver el directorio de clientes',
  clients_overview: 'Ver la ficha del cliente',
  clients_register: 'Registrar o actualizar el cliente',
  clients_link: 'Enganchar esto a la ficha del cliente',
  documents_extract: 'Leer los datos del documento',
  documents_pending_review: 'Ver los documentos por confirmar',
  documents_confirm: 'Confirmar lo que se leyó del documento',
  documents_reject: 'Descartar la lectura del documento',
  documents_correction_stats: 'Ver qué campos siempre hay que corregir',
  documents_records: 'Ver los documentos confirmados',
  documents_totals: 'Sumar lo facturado',
  payments_record: 'Registrar un pago que entró',
  payments_list: 'Ver los pagos registrados',
  payments_receivables: 'Ver la cartera',
  payments_disputes: 'Ver los pagos que no cuadran',
  payments_resolve_dispute: 'Resolver el pago que no cuadra',
  goals_offer_metrics: 'Ver qué se puede medir aquí',
  goals_list: 'Ver las metas y cómo van',
  goals_measure: 'Medir cómo vamos este período',
  company_facts: 'Leer la ficha de la empresa',
  trackers_define: 'Crear o cambiar una tabla',
  trackers_list: 'Ver las tablas inventadas',
  trackers_query: 'Consultar la tabla',
  trackers_upsert: 'Anotar en la tabla',
  trackers_remove: 'Borrar de la tabla',
  reports_generate: 'Armar el informe',
  reports_list: 'Ver los informes guardados',
  reports_open: 'Abrir un informe guardado',
  reports_share: 'Compartir el informe por enlace',
  reports_chart: 'Dibujar un gráfico',
  reports_compose: 'Armar un informe a la medida',
  reports_run: 'Volver a correr el informe',
  reports_recipes: 'Ver los informes a la medida guardados',
  errands_start: 'Encargarle el trabajo a Cortex',
  errands_status: 'Ver en qué va el encargo',
  errands_answer: 'Contestarle al encargo',
  pipeline_create: 'Guardar un procedimiento',
  pipeline_list: 'Ver los procedimientos guardados',
  pipeline_get: 'Ver el procedimiento',
  pipeline_update: 'Actualizar el procedimiento',
  pipeline_run: 'Ejecutar el procedimiento',
  pipeline_finish_run: 'Cerrar la ejecución del procedimiento',
  meetings_list_transcripts: 'Ver qué reuniones dejaron transcripción',
  meetings_get_transcript: 'Leer la transcripción de la reunión',
  meetings_import_transcript: 'Guardar la reunión en Brain Knowledge',
  meetings_join_live: 'Entrar a la reunión en vivo',
  meetings_live_status: 'Ver cómo va la reunión',
  meetings_speak: 'Hablar en la reunión en vivo',
  meetings_prepare_briefing: 'Preparar la reunión',
  meetings_schedule_briefings: 'Programar el aviso antes de cada reunión',
  cortex_remember: 'Recordar esto tuyo',
  cortex_forget: 'Olvidar eso que recordaba',
  cortex_process: 'Procesar el texto aparte',
  security_review_action: 'Consultar si esto pasa el filtro',
  security_recent_events: 'Ver lo que marcó la seguridad',
  inbox_overview: 'Ver qué está esperando por ti',
  inbox_priorities: 'Priorizar lo que llegó a tu correo',
  inbox_deliver_digest: 'Mandar el resumen del día',
  inbox_due_digests: 'Ver a quién le toca el resumen del día',
};

function toTitleCase(s: string): string {
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** El nombre que una persona debería leer. Nunca el id en bruto. */
export function pendingToolLabel(toolId: string): string {
  return TOOL_LABEL_TEXT[toolId.replace(/\./g, '_')] ?? toTitleCase(toolId);
}

/**
 * Una frase en español que dice qué va a hacer la llamada que está esperando.
 *
 * Gemela exacta de `confirmationSummary` en `apps/web/lib/tool-labels.ts` — ver
 * la cabecera de este archivo para por qué son dos y qué las mantiene iguales.
 */
export function pendingSummary(toolId: string, input: Record<string, unknown>): string {
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
      const writes = input.allowUnattendedWrites ? ' · PUEDE ESCRIBIR sin supervisión' : '';
      return `Programar "${input.name}" — se ejecuta ${when}${writes}`;
    }
    case 'vehicles_register':
      return `Registrar el vehículo de placa ${input.plate}`;
    case 'goals_set':
      return `Fijar la meta «${input.label || input.metricKey}» — objetivo ${input.targetValue}, ${
        input.cadence === 'week' ? 'semanal' : 'mensual'
      }`;
    default:
      return `Ejecutar: ${pendingToolLabel(toolId)}`;
  }
}

/** Lo mismo, tolerante con un `input` que no sea un objeto plano. */
export function describePendingCall(toolId: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return pendingSummary(toolId, record);
  } catch {
    return pendingToolLabel(toolId);
  }
}
