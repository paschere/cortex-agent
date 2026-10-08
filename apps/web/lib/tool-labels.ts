export const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  gmail_propose_learning: { label: 'Proponer un aprendizaje del correo', icon: 'Mail' },
  management_operation: { label: 'Consultar el ciclo gerencial', icon: 'Briefcase' },
  management_propose_decision: {
    label: 'Preparar una decisión para revisión',
    icon: 'ClipboardList',
  },
  team_founder_promote: { label: 'Nombrar a un cofundador', icon: 'Shield' },
  team_founder_transfer: { label: 'Pasar la propiedad de la empresa', icon: 'Shield' },
  team_founder_step_down: { label: 'Dejar de ser fundador', icon: 'Shield' },
  team_leave_company: { label: 'Salir de la empresa', icon: 'Shield' },
  security_report_refusal: { label: 'Registrar una acción rechazada', icon: 'Shield' },
  security_get_action_policy: { label: 'Consultar los permisos de acción', icon: 'Shield' },
  security_set_action_policy: { label: 'Configurar los permisos de acción', icon: 'Shield' },

  management_daily_brief: { label: 'Preparar el parte diario', icon: 'FileText' },
  management_collection_status: { label: 'Consultar el seguimiento del cobro', icon: 'Wallet' },
  management_start_collection: { label: 'Iniciar seguimiento y preparar un cobro', icon: 'Wallet' },
  management_advance_collection: {
    label: 'Actualizar o detener el seguimiento',
    icon: 'RefreshCw',
  },
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
  gmail_archive_thread: { label: 'Guardar el hilo en el cerebro', icon: 'BookOpen' },
  gmail_train_brain: { label: 'Aprender de tu buzón', icon: 'Brain' },
  gmail_training_status: { label: 'Ver cómo va el aprendizaje del buzón', icon: 'Gauge' },
  gcal_list_events: { label: 'Ver eventos del calendario', icon: 'Calendar' },
  gcal_create_event: { label: 'Crear evento en el calendario', icon: 'CalendarPlus' },
  gsheets_read_range: { label: 'Leer hoja de cálculo', icon: 'Table' },
  gsheets_append_row: { label: 'Agregar fila a la hoja', icon: 'TableProperties' },
  kb_search: { label: 'Buscar en el cerebro', icon: 'BookOpen' },
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
  // Ventas (0182).
  sales_quote_create: { label: 'Crear una cotización', icon: 'FilePlus2' },
  sales_quote_send: { label: 'Mandar la cotización al cliente', icon: 'Send' },
  sales_invoice_emit: { label: 'Emitir la factura electrónica', icon: 'Receipt' },
  sales_list: { label: 'Ver cotizaciones, pedidos y facturas', icon: 'ClipboardList' },
  // Embudo comercial (0193): oportunidades, seguimiento, riesgo y encuestas.
  crm_pipeline: { label: 'Ver el embudo comercial', icon: 'SquareKanban' },
  crm_create_opportunity: { label: 'Abrir una oportunidad de venta', icon: 'Handshake' },
  crm_update_opportunity: { label: 'Mover o actualizar una oportunidad', icon: 'ArrowRightLeft' },
  crm_log_activity: { label: 'Anotar una actividad comercial', icon: 'PhoneCall' },
  crm_at_risk: { label: 'Ver los clientes en riesgo de perderse', icon: 'TrendingDown' },
  crm_send_nps: { label: 'Mandar la encuesta de satisfacción', icon: 'MessageSquareHeart' },
  team_invite: { label: 'Invitar a alguien a la empresa', icon: 'UserPlus' },
  web_search: { label: 'Buscar en internet', icon: 'Globe' },
  web_scrape: { label: 'Abrir página web', icon: 'Link' },
  management_brief: { label: 'Revisar la gerencia de la empresa', icon: 'Briefcase' },
  management_inspect: { label: 'Consultar un asunto y su historial', icon: 'FileSearch' },
  management_record: { label: 'Organizar y seguir un asunto', icon: 'ClipboardList' },
  // Registro de trabajo (0174).
  work_record: { label: 'Anotar trabajo en el registro', icon: 'ClipboardCheck' },
  work_record_batch: { label: 'Anotar muchas filas de trabajo', icon: 'ClipboardCheck' },
  work_preview_batch: { label: 'Mirar qué trabajo entraría al registro', icon: 'FileSearch' },
  work_assign: { label: 'Pasar trabajo a otra persona', icon: 'UserCheck' },
  work_suggest_mapping: { label: 'Proponer cómo una tabla se vuelve trabajo', icon: 'Table2' },
  work_configure: { label: 'Configurar el registro de trabajo', icon: 'Settings' },
  work_update_person: { label: 'Anotar equipo, cargo o días fuera', icon: 'CalendarDays' },
  work_query: { label: 'Consultar el registro de trabajo', icon: 'ListTodo' },
  browser_list_flows: { label: 'Ver los trámites aprendidos', icon: 'Globe' },
  browser_run_flow: { label: 'Hacer el trámite en el portal', icon: 'Globe' },
  browser_submit_flow: { label: 'Radicar el trámite en el portal', icon: 'Send' },
  browser_open_page: { label: 'Abrir el sitio en una pestaña viva', icon: 'Globe' },
  browser_act: { label: 'Dar un paso en la página', icon: 'MousePointerClick' },
  browser_read_page: { label: 'Leer la página como está', icon: 'Eye' },
  browser_ask_person: { label: 'Pedirte el volante de la pestaña', icon: 'Hand' },
  browser_request_secret: { label: 'Pedirte una clave directo a la página', icon: 'KeyRound' },
  browser_close_page: { label: 'Cerrar la pestaña', icon: 'X' },
  gdrive_search_files: { label: 'Buscar archivos en Drive', icon: 'FolderSearch' },
  gdrive_read_doc: { label: 'Leer documento de Drive', icon: 'FileSearch' },
  gdrive_find_folder: { label: 'Buscar una carpeta de Drive', icon: 'FolderSearch' },
  gdrive_folder_tree: {
    label: 'Ver cómo está organizada una carpeta de Drive',
    icon: 'FolderSearch',
  },
  gdrive_upload_file: { label: 'Guardar un archivo en una carpeta de Drive', icon: 'FolderUp' },
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
  outlook_archive_thread: { label: 'Guardar el correo en el cerebro', icon: 'Archive' },
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
  kb_list_spaces: { label: 'Ver los espacios del cerebro', icon: 'Library' },
  kb_create_document: { label: 'Guardar en el cerebro', icon: 'BookPlus' },
  kb_share_space: { label: 'Cambiar quién ve un espacio', icon: 'Users' },
  kb_context: { label: 'Reunir contexto del cerebro', icon: 'BookMarked' },
  // El adjunto de un turno mudándose al cerebro. Dice «el adjunto» y no «el
  // archivo» porque quien lo pide acaba de subirlo en esta misma conversación.
  feed_table_query: { label: 'Consultar la hoja de cálculo de Feed', icon: 'Table2' },
  attachments_promote: { label: 'Guardar el adjunto en el cerebro', icon: 'BookPlus' },

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
  // La nómina que se liquida en Cortex (0194).
  payroll_period_summary: { label: 'Ver cómo va la nómina del periodo', icon: 'Wallet' },
  payroll_register_novelty: { label: 'Registrar una novedad de nómina', icon: 'FilePlus2' },
  payroll_approve_period: { label: 'Aprobar la nómina', icon: 'BadgeCheck' },
  payroll_payslip: { label: 'Ver el desprendible de pago', icon: 'Receipt' },
  payroll_leave_request: { label: 'Pedir vacaciones o un permiso', icon: 'CalendarPlus' },
  payroll_leave_status: { label: 'Ver el saldo de vacaciones', icon: 'CalendarCheck' },
  payroll_leave_decide: { label: 'Aprobar o rechazar una ausencia', icon: 'CalendarCheck' },
  // SG-SST (0194).
  sst_status: { label: 'Ver cómo va el SG-SST', icon: 'ShieldCheck' },
  sst_log_activity: { label: 'Registrar una actividad del SG-SST', icon: 'ClipboardList' },
  sst_report_incident: { label: 'Reportar un accidente de trabajo', icon: 'TriangleAlert' },

  // Internet. Las otras dos están arriba.
  web_news: { label: 'Buscar noticias', icon: 'Newspaper' },

  // Presentaciones de candidatos.
  presentations_pick_candidate: { label: 'Elegir de quién es la presentación', icon: 'UserSearch' },
  presentations_create_pdf: { label: 'Armar la presentación en PDF', icon: 'Presentation' },
  presentations_list_recent: { label: 'Ver presentaciones ya armadas', icon: 'Files' },

  // Mensajería de equipo.
  slack_post_message: { label: 'Publicar en un canal de Slack', icon: 'Hash' },
  // Atención a clientes por WhatsApp (0185).
  whatsapp_customer_conversations: {
    label: 'Ver las conversaciones de atención por WhatsApp',
    icon: 'MessagesSquare',
  },
  whatsapp_reply: { label: 'Responder a un cliente por WhatsApp', icon: 'MessageCircle' },
  whatsapp_group_send: { label: 'Escribir en un grupo de WhatsApp', icon: 'MessageCircle' },
  whatsapp_group_messages: { label: 'Leer un grupo de WhatsApp', icon: 'MessagesSquare' },
  chat_send_message: { label: 'Publicar en Google Chat', icon: 'MessageSquare' },
  chat_send_dm: { label: 'Mandar un privado por Google Chat', icon: 'MessageCircle' },

  // Directorio de personas.
  people_search: { label: 'Buscar el correo de una persona', icon: 'Contact' },
  directory_line: { label: 'Ver quién le responde a quién', icon: 'Network' },

  // Oportunidades: señales públicas de necesidades comerciales.
  growth_find_signals: { label: 'Buscar oportunidades comerciales', icon: 'Radar' },
  growth_list_signals: { label: 'Ver las oportunidades detectadas', icon: 'Telescope' },
  growth_update_signal: { label: 'Actualizar la oportunidad', icon: 'PencilLine' },
  growth_identify_contact: { label: 'Averiguar con quién hablar', icon: 'UserSearch' },
  growth_draft_outreach: { label: 'Preparar un mensaje comercial', icon: 'PencilLine' },

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
  clients_merge: { label: 'Unir dos clientes repetidos', icon: 'Merge' },

  // Documentos: facturas, guías, declaraciones. Lo que se lee de ellos no
  // cuenta hasta que una persona lo confirma, y las frases mantienen esa
  // diferencia — «leer» no es «confirmar».
  documents_extract: { label: 'Leer los datos del documento', icon: 'ScanText' },
  documents_pending_review: { label: 'Ver los documentos por confirmar', icon: 'FileClock' },
  documents_confirm: { label: 'Confirmar lo que se leyó del documento', icon: 'FileCheck' },
  documents_reject: { label: 'Descartar la lectura del documento', icon: 'FileX' },
  // Documentos que vencen (0184): leer no es vigilar, y confirmar sí.
  documents_expiring: { label: 'Ver los documentos que vencen', icon: 'CalendarClock' },
  // La ayuda de Cortex (/ayuda): cómo se usa el producto, no los datos.
  help_search: { label: 'Buscar en la ayuda de Cortex', icon: 'LifeBuoy' },
  documents_track_expiration: { label: 'Registrar un documento que vence', icon: 'CalendarPlus' },
  documents_confirm_expiration: {
    label: 'Confirmar el vencimiento leído del documento',
    icon: 'CalendarCheck',
  },
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
  payments_preview_bank_statement: {
    label: 'Mirar el extracto del banco',
    icon: 'FileSpreadsheet',
  },
  payments_import_bank_statement: { label: 'Importar el extracto del banco', icon: 'Landmark' },
  payments_bank_unmatched: { label: 'Ver lo que entró al banco sin factura', icon: 'SearchCheck' },
  payments_apply_to_invoice: { label: 'Atar el pago a su factura', icon: 'Link' },
  payments_recovered: { label: 'Ver la plata recuperada con Cortex', icon: 'TrendingUp' },
  // Lo que Cortex recomendó y qué pasó después (0177).
  recommendations_list: { label: 'Ver lo que te recomendé y qué pasó', icon: 'Lightbulb' },

  // El libro de plata (0172): toda la plata de la empresa en un solo libro.
  ledger_record: { label: 'Anotar un movimiento en el libro de plata', icon: 'NotebookPen' },
  ledger_record_batch: {
    label: 'Anotar varios movimientos en el libro de plata',
    icon: 'FileSpreadsheet',
  },
  ledger_preview_batch: { label: 'Mirar qué entraría al libro de plata', icon: 'FileSearch' },
  ledger_recategorize: { label: 'Corregir la categoría de los movimientos', icon: 'Tags' },
  ledger_query: { label: 'Consultar el libro de plata', icon: 'BookOpen' },
  ledger_set_balance: { label: 'Fijar el saldo de una cuenta', icon: 'Landmark' },
  ledger_forecast: { label: 'Proyectar la caja de las próximas semanas', icon: 'ChartLine' },
  ledger_explain_week: { label: 'Explicar la caja de una semana', icon: 'MessageCircleQuestion' },
  ledger_save_scenario: { label: 'Guardar un escenario de caja', icon: 'BookmarkPlus' },
  ledger_declare_recurring: { label: 'Anotar un ingreso o gasto que se repite', icon: 'Repeat' },
  ledger_decide_recurring: {
    label: 'Confirmar o ignorar un movimiento que se repite',
    icon: 'CalendarCheck',
  },
  ledger_set_minimum_cash: { label: 'Fijar la caja mínima de la empresa', icon: 'ShieldAlert' },
  ledger_categorize_pending: { label: 'Ponerle categoría a lo que no tiene', icon: 'Tags' },

  // Cuentas por pagar (0181): facturas de proveedor, aprobación y programa de pagos.
  payables_inbox: { label: 'Ver las facturas de proveedor por pagar', icon: 'Inbox' },
  payables_pay_plan: { label: 'Ver el programa de pagos a proveedores', icon: 'CalendarClock' },
  payables_record: { label: 'Anotar una factura de proveedor', icon: 'FilePlus2' },
  payables_approve: { label: 'Aprobar facturas de proveedor', icon: 'BadgeCheck' },
  payables_reject: { label: 'Rechazar facturas de proveedor', icon: 'FileX2' },
  payables_schedule: { label: 'Programar el pago a proveedores', icon: 'CalendarCheck' },

  // El piloto automático (0176): lo que Cortex hace solo cada mañana.
  autopilot_plan: { label: 'Ver lo que haría el piloto hoy', icon: 'Plane' },
  autopilot_status: { label: 'Ver lo que hizo el piloto', icon: 'History' },
  autopilot_configure: { label: 'Configurar el piloto automático', icon: 'Settings' },
  autopilot_remind: { label: 'Recordarle algo a un compañero', icon: 'BellRing' },

  // Módulos por empresa (0186): qué áreas de Cortex están prendidas.
  modules_list: { label: 'Ver los módulos prendidos', icon: 'LayoutGrid' },
  modules_set: { label: 'Prender o apagar un módulo', icon: 'ToggleRight' },

  // Inventario y compras (0183): existencias, reposición y órdenes de compra.
  inventory_stock: { label: 'Ver el inventario', icon: 'Package' },
  inventory_move: { label: 'Registrar un movimiento de inventario', icon: 'ArrowLeftRight' },
  inventory_reorder: { label: 'Ver qué hay que pedir', icon: 'ClipboardList' },
  purchasing_create_po: { label: 'Crear órdenes de compra', icon: 'ShoppingCart' },
  purchasing_send_po: { label: 'Aprobar y enviar una orden de compra', icon: 'Send' },
  purchasing_receive: {
    label: 'Recibir la mercancía de una orden de compra',
    icon: 'PackageCheck',
  },

  // Proyectos y órdenes de servicio · flota y rutas (0196).
  projects_create: { label: 'Abrir una orden de servicio o proyecto', icon: 'FolderPlus' },
  projects_status: { label: 'Ver cómo van los proyectos', icon: 'FolderKanban' },
  projects_log_time: { label: 'Registrar horas en un proyecto', icon: 'Timer' },
  projects_profitability: { label: 'Ver la rentabilidad de los proyectos', icon: 'TrendingUp' },
  projects_invoice: { label: 'Dejar en borrador la factura de un proyecto', icon: 'FileText' },
  fleet_status: { label: 'Ver la flota', icon: 'Truck' },
  fleet_log_fuel: { label: 'Registrar un tanqueo', icon: 'Fuel' },
  fleet_log_maintenance: { label: 'Registrar un mantenimiento', icon: 'Wrench' },
  fleet_log_trip: { label: 'Registrar un recorrido', icon: 'Route' },

  // El calendario tributario (0180).
  tax_calendar: { label: 'Ver el calendario de impuestos', icon: 'CalendarClock' },
  tax_configure: { label: 'Configurar el perfil tributario', icon: 'Landmark' },
  tax_mark: { label: 'Marcar un impuesto presentado o pagado', icon: 'BadgeCheck' },
  tax_draft: { label: 'Armar el borrador de una declaración', icon: 'FileText' },
  tax_certificates: { label: 'Mandar certificados de retención', icon: 'Send' },
  tax_exogena_export: { label: 'Preparar la exógena', icon: 'FileSpreadsheet' },

  // Estados financieros, presupuesto, pronóstico e informe para socios (0191).
  statements_get: { label: 'Ver los estados financieros', icon: 'FileBarChart' },
  budget_get: { label: 'Ver el presupuesto contra lo real', icon: 'Target' },
  budget_set_line: { label: 'Fijar una línea del presupuesto', icon: 'PencilLine' },
  forecast_pnl: { label: 'Pronosticar ventas y resultados', icon: 'TrendingUp' },
  board_generate: { label: 'Armar el informe para socios', icon: 'FileText' },
  board_send: { label: 'Mandar el informe para socios', icon: 'Send' },

  // Contratos y cumplimiento (0195).
  contracts_draft: { label: 'Redactar un borrador de contrato', icon: 'FilePenLine' },
  contracts_list: { label: 'Ver los contratos', icon: 'FileText' },
  contracts_obligations: { label: 'Ver las obligaciones de los contratos', icon: 'ListChecks' },
  contracts_extract_obligations: {
    label: 'Leer las obligaciones de un contrato',
    icon: 'ScanText',
  },
  compliance_status: { label: 'Ver cómo va el cumplimiento', icon: 'ShieldCheck' },
  compliance_mark: { label: 'Marcar una obligación de cumplimiento', icon: 'BadgeCheck' },
  compliance_pqrs_create: { label: 'Radicar una PQRS', icon: 'Inbox' },
  compliance_pqrs_respond: {
    label: 'Guardar la respuesta de una PQRS',
    icon: 'MessageSquareReply',
  },
  compliance_case_update: { label: 'Actualizar un proceso judicial', icon: 'Gavel' },
  // Cierre contable (0192).
  close_status: { label: 'Ver cómo va el cierre del mes', icon: 'ListChecks' },
  close_mark_task: { label: 'Marcar una tarea del cierre', icon: 'CheckSquare' },
  close_close_period: { label: 'Cerrar el mes', icon: 'Lock' },
  accounting_write_purchase: {
    label: 'Causar facturas de compra en el programa contable',
    icon: 'BookPlus',
  },
  accounting_write_receipt: {
    label: 'Registrar recibos de caja en el programa contable',
    icon: 'ReceiptText',
  },
  accounting_write_supplier_payment: {
    label: 'Registrar pagos a proveedores en el programa contable',
    icon: 'BookCheck',
  },

  // Metas. `goals_set` está arriba porque se para a pedir permiso.
  goals_offer_metrics: { label: 'Ver qué se puede medir aquí', icon: 'Ruler' },
  goals_list: { label: 'Ver las metas y cómo van', icon: 'Flag' },
  goals_measure: { label: 'Medir cómo vamos este período', icon: 'Gauge' },

  // La ficha de la empresa.
  company_facts: { label: 'Leer la ficha de la empresa', icon: 'Landmark' },

  // Tablas que esta empresa se inventa.
  kb_propose_memory: { label: 'Proponer un recuerdo para la empresa', icon: 'BookmarkPlus' },
  feed_connect_google_sheet: { label: 'Conectar una hoja de Google', icon: 'Sheet' },
  trackers_propose_from_source: { label: 'Proponer una tabla desde una hoja', icon: 'Sheet' },
  trackers_sync_from_source: { label: 'Llenar una tabla sola desde una fuente', icon: 'RefreshCw' },
  trackers_update_from_source: {
    label: 'Actualizar una tabla desde una fuente',
    icon: 'RefreshCw',
  },
  trackers_syncs: { label: 'Ver las tablas que se llenan solas', icon: 'RefreshCw' },
  trackers_row_lookup_create: { label: 'Consultar una API fila por fila', icon: 'ScanSearch' },
  trackers_row_lookup_status: {
    label: 'Ver cómo van las consultas automáticas',
    icon: 'ScanSearch',
  },
  trackers_row_lookup_update: {
    label: 'Cambiar o pausar una consulta automática',
    icon: 'ScanSearch',
  },
  trackers_propose_from_drive_folder: {
    label: 'Proponer una tabla desde una carpeta de Drive',
    icon: 'FolderInput',
  },
  trackers_sync_from_drive_folder: {
    label: 'Llenar una tabla desde una carpeta de Drive (hojas, documentos y fotos)',
    icon: 'FolderInput',
  },
  trackers_drive_syncs: {
    label: 'Ver las carpetas de Drive que llenan tablas',
    icon: 'FolderInput',
  },
  trackers_retry_sync: { label: 'Volver a correr una sincronización', icon: 'RotateCw' },
  // Programas contables conectados directo (Siigo, Alegra, QuickBooks), 0165.
  accounting_status: { label: 'Ver cómo va el programa contable', icon: 'Calculator' },
  accounting_payroll_summary: { label: 'Ver la nómina según la contabilidad', icon: 'Wallet' },
  accounting_sync_now: { label: 'Traer ya los datos del programa contable', icon: 'RefreshCw' },
  trackers_define: { label: 'Crear o cambiar una tabla', icon: 'Table2' },
  trackers_list: { label: 'Ver las tablas inventadas', icon: 'Table2' },
  trackers_query: { label: 'Consultar la tabla', icon: 'Table2' },
  trackers_upsert: { label: 'Anotar en la tabla', icon: 'Table2' },
  trackers_remove: { label: 'Borrar de la tabla', icon: 'Table2' },
  apps_list: { label: 'Ver las aplicaciones', icon: 'LayoutGrid' },
  apps_design: { label: 'Diseñar una aplicación (borrador)', icon: 'LayoutGrid' },
  apps_create: { label: 'Crear una aplicación', icon: 'LayoutGrid' },
  apps_get: { label: 'Abrir una aplicación', icon: 'LayoutGrid' },
  apps_update: { label: 'Cambiar una aplicación', icon: 'LayoutGrid' },
  apps_publish: { label: 'Publicar una aplicación', icon: 'LayoutGrid' },
  apps_delete: { label: 'Eliminar una aplicación', icon: 'Trash2' },
  apps_assign_members: { label: 'Asignar personas a una aplicación', icon: 'Users' },
  apps_invite_users: { label: 'Invitar usuarios a una aplicación', icon: 'Mail' },
  apps_automations_list: { label: 'Ver las automatizaciones de una aplicación', icon: 'Zap' },
  apps_automations_create: { label: 'Crear una automatización', icon: 'Zap' },
  apps_automations_update: { label: 'Cambiar una automatización', icon: 'Zap' },
  apps_automations_pause: { label: 'Pausar o reanudar una automatización', icon: 'Zap' },
  views_list: { label: 'Ver las vistas', icon: 'LayoutPanelTop' },
  views_get: { label: 'Abrir una vista', icon: 'LayoutPanelTop' },
  views_create: { label: 'Crear una vista', icon: 'LayoutPanelTop' },
  views_update: { label: 'Cambiar una vista', icon: 'LayoutPanelTop' },
  views_share: { label: 'Compartir una vista', icon: 'Link2' },
  views_archive: { label: 'Archivar una vista', icon: 'Archive' },
  views_restore: { label: 'Restaurar una vista archivada', icon: 'Archive' },
  views_delete: { label: 'Eliminar una vista', icon: 'Trash2' },
  views_company_pulse: { label: 'Armar el pulso de la empresa', icon: 'LayoutPanelTop' },
  views_refresh_summary: { label: 'Actualizar el resumen del día', icon: 'LayoutPanelTop' },
  views_schedule_pulse: { label: 'Programar el resumen diario', icon: 'CalendarClock' },
  views_weekly_review: { label: 'Escribir la revisión semanal', icon: 'LayoutPanelTop' },
  views_schedule_weekly_review: { label: 'Programar la revisión semanal', icon: 'CalendarClock' },

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
  meetings_join_live: { label: 'Entrar a la reunión en vivo', icon: 'Radio' },
  meetings_live_status: { label: 'Ver cómo va la reunión', icon: 'Radio' },
  meetings_speak: { label: 'Hablar en la reunión en vivo', icon: 'Volume2' },
  meetings_list_transcripts: { label: 'Ver qué reuniones dejaron transcripción', icon: 'Video' },
  meetings_get_transcript: { label: 'Leer la transcripción de la reunión', icon: 'ScrollText' },
  meetings_import_transcript: { label: 'Guardar la reunión en el cerebro', icon: 'Mic' },
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
  // Acciones seguras de repetir (0168): una repetición pedida a sabiendas lo
  // dice en la propia frase que se aprueba. Gemela de `pendingSummary` en
  // packages/agent-tools/src/approvals/summary.ts.
  const repeat = input.repeatConfirmedByUser === true ? ' · REPETICIÓN: ya se había hecho' : '';
  return `${confirmationSummaryBase(toolId, input)}${repeat}`;
}

function confirmationSummaryBase(toolId: string, input: Record<string, unknown>): string {
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
    case 'views_schedule_pulse': {
      // La hora y los días a la vista: es lo que la persona aprueba.
      const hour = typeof input.hour === 'number' ? input.hour : 7;
      const minute = typeof input.minute === 'number' ? input.minute : 0;
      const days = Array.isArray(input.weekdays) ? input.weekdays.join(',') : '1-5';
      return `Programar el resumen diario de la vista «${input.view ?? 'pulso_empresa'}» — a las ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${input.timezone ?? 'America/Bogota'}), días ${days}${input.notifyEmail ? ' · también por correo' : ''}`;
    }
    case 'views_schedule_weekly_review': {
      // El día y la hora a la vista: es lo que la persona aprueba.
      const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
      const day = typeof input.weekday === 'number' ? (days[input.weekday] ?? 'lunes') : 'lunes';
      const hour = typeof input.hour === 'number' ? input.hour : 7;
      const minute = typeof input.minute === 'number' ? input.minute : 30;
      return `Programar la revisión semanal de la vista «${input.view ?? 'pulso_empresa'}» — los ${day} a las ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} (${input.timezone ?? 'America/Bogota'})${input.notifyEmail ? ' · también por correo' : ''}`;
    }
    case 'vehicles_register':
      return `Registrar el vehículo de placa ${input.plate}`;
    case 'payables_record':
      return `Anotar la factura ${input.number} de ${input.supplierName}`;
    case 'payables_approve': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Aprobar ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor — no paga nada; el pago se programa después`;
    }
    case 'payables_reject': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Rechazar ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor: «${String(input.reason ?? '').slice(0, 120)}»`;
    }
    case 'tax_certificates': {
      const kind =
        input.kind === 'iva' ? 'IVA' : input.kind === 'ica' ? 'ICA' : 'retención en la fuente';
      const n = Array.isArray(input.suppliers) ? input.suppliers.length : 0;
      return `Mandar por correo los certificados de ${kind} ${input.period ? `del bimestre ${input.period} de ${input.year}` : `de ${input.year}`} ${n ? `a ${n === 1 ? 'un proveedor' : `${n} proveedores`}` : 'a todos los proveedores con retención y correo'}`;
    }
    case 'payroll_register_novelty':
      return `Registrar ${String(input.kind ?? 'una novedad').replace(/_/g, ' ')} en la nómina de ${input.person} desde el ${input.date}${input.dateTo ? ` hasta el ${input.dateTo}` : ''}`;
    case 'payroll_approve_period':
      return `Aprobar la nómina ${input.label ? `de ${input.label}` : 'liquidada más reciente'} — no paga nada; el pago se hace desde el banco`;
    case 'payroll_leave_decide':
      return `${input.decision === 'rechazada' ? 'Rechazar' : 'Aprobar'} la solicitud de ausencia${input.person ? ` de ${input.person}` : ''}${input.decision === 'rechazada' && input.note ? `: «${String(input.note).slice(0, 120)}»` : ''}`;
    case 'sst_log_activity':
      return `Registrar en el SG-SST ${String(input.kind ?? 'una actividad').replace(/_/g, ' ')}${input.title ? ` «${input.title}»` : ''} del ${input.date}`;
    case 'sst_report_incident':
      return `Reportar ${input.kind === 'incidente' ? 'un incidente' : input.kind === 'enfermedad_laboral' ? 'una enfermedad laboral' : 'un accidente de trabajo'} del ${input.occurredOn} y crear los avisos de FURAT e investigación`;
    case 'payables_schedule': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Programar el pago de ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor ${input.date ? `para el ${input.date}` : 'el día que sugiere la caja'}`;
    }
    case 'sales_quote_create':
      return `Crear una cotización para «${input.client}» con ${Array.isArray(input.lines) ? input.lines.length : 0} línea(s)`;
    case 'sales_quote_send':
      return `Mandar la cotización ${input.quote} por correo ${Array.isArray(input.to) && input.to.length ? `a ${input.to.join(', ')}` : 'al correo del cliente'}`;
    case 'sales_invoice_emit':
      return `Emitir la factura electrónica de ${input.document} en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : 'el programa contable'} — sale con su CUFE a la DIAN`;
    case 'crm_create_opportunity':
      return `Abrir la oportunidad «${input.title}» con ${input.client}${typeof input.value === 'number' ? ` por $${input.value.toLocaleString('es-CO')}` : ''}${input.stage ? ` en ${input.stage}` : ''}`;
    case 'crm_update_opportunity':
      return `Actualizar la oportunidad «${input.opportunity}»${input.stage ? `: pasarla a ${input.stage}` : ''}${input.lostReasonKind ? ` (perdida por ${input.lostReasonKind})` : ''}${typeof input.value === 'number' ? `, valor $${input.value.toLocaleString('es-CO')}` : ''}`;
    case 'crm_log_activity':
      return `Anotar ${input.kind === 'task' ? 'la tarea' : 'la actividad'} «${String(input.title ?? '').slice(0, 120)}»${input.opportunity ? ` en «${input.opportunity}»` : input.client ? ` de ${input.client}` : ''}${input.kind === 'task' && input.dueOn ? ` para el ${input.dueOn}` : ''}`;
    case 'crm_send_nps':
      return input.linkOnly
        ? `Crear el enlace de la encuesta de satisfacción para ${input.client}`
        : `Mandar la encuesta de satisfacción a ${input.client} por correo ${Array.isArray(input.to) && input.to.length ? `a ${input.to.join(', ')}` : 'a su contacto principal'}`;
    case 'team_invite':
      return `Invitar a ${input.email} a la empresa como ${input.role === 'admin' ? 'administrador' : 'miembro'}${input.position ? ` (${String(input.position).slice(0, 80)})` : ''}${input.team ? ` en el equipo ${String(input.team).slice(0, 80)}` : ''} — le llega un correo con el enlace`;
    case 'whatsapp_reply':
      return `Responder por WhatsApp, como persona, en la conversación abierta: «${String(input.text ?? '').slice(0, 120)}»`;
    case 'whatsapp_group_send':
      return `Escribir en el grupo de WhatsApp «${String(input.group ?? '').slice(0, 80)}»: «${String(input.text ?? '').slice(0, 120)}» — lo ve todo el grupo`;
    case 'gdrive_upload_file':
      return `Guardar ${input.fileName ? `«${String(input.fileName).slice(0, 80)}»` : 'el archivo'} en la carpeta de Drive ${String(input.folderId ?? '').slice(0, 40)} — no crea carpetas`;
    case 'projects_create':
      return input.fromDocument
        ? `Abrir un proyecto desde ${input.fromDocument}${input.tasksFromLines ? ', con una tarea por línea' : ''}`
        : `Abrir ${input.kind === 'proyecto' ? 'el proyecto' : 'la orden de servicio'} «${input.title}»${input.client ? ` para ${input.client}` : ''}${typeof input.budgetAmount === 'number' ? ` con presupuesto de costo de $${input.budgetAmount.toLocaleString('es-CO')}` : ''}`;
    case 'projects_log_time':
      return `Registrar ${input.hours} h${input.person ? ` de ${input.person}` : ''} en ${input.project}${input.date ? ` el ${input.date}` : ' hoy'}${input.billable === false ? ' (no cobrables)' : ''}`;
    case 'projects_invoice':
      return `Dejar en borrador la factura de ${input.milestone ? `el hito «${input.milestone}» de ` : typeof input.amount === 'number' ? `$${input.amount.toLocaleString('es-CO')} de ` : 'lo que falta de '}${input.project} — no se emite`;
    case 'fleet_log_fuel':
      return `Registrar el tanqueo de ${input.plate}: ${input.gallons} galones por $${Number(input.amount ?? 0).toLocaleString('es-CO')}${typeof input.odometerKm === 'number' ? ` a los ${input.odometerKm.toLocaleString('es-CO')} km` : ''}`;
    case 'fleet_log_maintenance':
      return `Registrar en ${input.plate}: «${String(input.description ?? '').slice(0, 120)}»${typeof input.cost === 'number' ? ` por $${input.cost.toLocaleString('es-CO')}` : ''}`;
    case 'fleet_log_trip': {
      const route = [
        input.origin,
        ...(Array.isArray(input.stops) ? input.stops : []),
        input.destination,
      ]
        .filter(Boolean)
        .join(' → ');
      return `Registrar el recorrido ${route || 'sin ruta'}${input.plate ? ` en ${input.plate}` : ''}${input.date ? ` el ${input.date}` : ''}`;
    }
    case 'inventory_move':
      return input.kind === 'ajuste'
        ? `Ajustar «${input.product}» a ${input.countedQty} contados${input.location ? ` en ${input.location}` : ''}`
        : `Registrar ${input.kind === 'traslado' ? `el traslado a ${input.toLocation}` : `la ${input.kind}`} de ${input.qty} de «${input.product}»${input.unitCost != null ? ` a $${input.unitCost}` : ''}`;
    case 'purchasing_create_po':
      return input.fromSuggestions
        ? `Crear órdenes de compra con lo que hay que reponer${input.approve ? ', y dejarlas aprobadas' : ''}`
        : `Crear una orden de compra a ${input.supplier} con ${Array.isArray(input.lines) ? input.lines.length : 0} producto(s)${input.approve ? ', y dejarla aprobada' : ''}`;
    case 'purchasing_send_po':
      return `Aprobar y enviar la orden de compra ${input.label ?? input.purchaseOrderId}${input.supplierName ? ` a ${input.supplierName}` : ''}${typeof input.expectedTotal === 'number' ? ` por $${input.expectedTotal.toLocaleString('es-CO')}` : ''}${input.to ? ` (${input.to})` : ''}`;
    case 'purchasing_receive':
      return `Recibir ${Array.isArray(input.lines) && input.lines.length ? 'parte de la mercancía' : 'toda la mercancía pendiente'} de la orden ${input.purchaseOrderId}`;
    case 'budget_set_line':
      return `${Number(input.amount) > 0 ? `Fijar ${input.category} en $${Number(input.amount).toLocaleString('es-CO')}` : `Quitar ${input.category}`} del presupuesto ${input.month ? `del mes ${input.month}` : 'de cada mes'}${input.year ? ` de ${input.year}` : ''}`;
    case 'board_generate':
      return `Armar el informe para socios ${input.period ? `de ${input.period}` : 'del mes anterior'} — queda en borrador, no se manda`;
    case 'board_send':
      return `Mandar por correo el informe para socios ${input.report ? `(${input.report})` : 'del mes anterior'} ${Array.isArray(input.to) && input.to.length ? `a ${input.to.join(', ')}` : 'a los correos configurados'}`;
    case 'close_mark_task':
      return `${input.status === 'no_aplica' ? 'Marcar como no aplica' : input.status === 'pendiente' ? 'Volver a pendiente' : 'Dar por hecha'} la tarea «${input.task}» del cierre${input.period ? ` de ${input.period}` : ''}${input.evidence ? `: «${String(input.evidence).slice(0, 120)}»` : ''}`;
    case 'close_close_period':
      return input.action === 'reabrir'
        ? `Reabrir el mes ${input.period ?? 'cerrado'}${input.reason ? `: «${String(input.reason).slice(0, 120)}»` : ''}`
        : `Cerrar el mes ${input.period ?? 'que toca'} — bloquea los cambios de Cortex con fecha de ese mes`;
    case 'accounting_write_purchase': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Causar ${n === 1 ? 'una factura' : `${n} facturas`} de proveedor en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : input.provider === 'quickbooks' ? 'QuickBooks' : 'el programa contable'} — queda en los libros de la empresa`;
    }
    case 'accounting_write_receipt': {
      const n = Array.isArray(input.payments) ? input.payments.length : 0;
      return `Registrar ${n === 1 ? 'un recibo de caja' : `${n} recibos de caja`} en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : input.provider === 'quickbooks' ? 'QuickBooks' : 'el programa contable'} — queda en los libros de la empresa`;
    }
    case 'accounting_write_supplier_payment': {
      const n = Array.isArray(input.invoices) ? input.invoices.length : 0;
      return `Registrar ${n === 1 ? 'un pago' : `${n} pagos`} a proveedores en ${input.provider === 'siigo' ? 'Siigo' : input.provider === 'alegra' ? 'Alegra' : input.provider === 'quickbooks' ? 'QuickBooks' : 'el programa contable'} — queda en los libros de la empresa`;
    }
    case 'contracts_draft':
      return `Redactar un borrador de contrato (${String(input.template ?? 'plantilla')})${input.counterparty && typeof input.counterparty === 'object' && (input.counterparty as Record<string, unknown>).name ? ` con ${String((input.counterparty as Record<string, unknown>).name)}` : ''} — queda como borrador para revisión de un abogado; no se firma ni se envía`;
    case 'contracts_extract_obligations':
      return 'Leer el contrato y proponer sus obligaciones y fechas con su frase — ninguna se vigila hasta que alguien la confirme';
    case 'compliance_mark':
      return `Marcar «${input.item}» como ${input.status === 'cumplido' ? 'cumplido' : input.status === 'en_curso' ? 'en curso' : input.status === 'no_aplica' ? 'no aplica' : 'pendiente'}${input.evidenceNote ? `: «${String(input.evidenceNote).slice(0, 120)}»` : ''}`;
    case 'compliance_pqrs_create':
      return `Radicar ${input.kind === 'queja' ? 'una queja' : input.kind === 'reclamo' ? 'un reclamo' : input.kind === 'sugerencia' ? 'una sugerencia' : input.kind === 'felicitacion' ? 'una felicitación' : 'una petición'} de ${input.requesterName}: «${String(input.subject ?? '').slice(0, 100)}» (llegó por ${input.channel})`;
    case 'compliance_pqrs_respond':
      return `Guardar la respuesta de ${input.pqrs}${input.close ? ' y cerrarla' : ''} — no se envía; enviarla es otro paso`;
    case 'compliance_case_update':
      return `${input.id ? 'Actualizar' : 'Registrar o actualizar'} el proceso judicial ${input.title ? `«${input.title}»` : (input.radicado ?? '')}${input.nextHearingOn ? `, con la próxima diligencia el ${input.nextHearingOn}` : ''}`;
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
