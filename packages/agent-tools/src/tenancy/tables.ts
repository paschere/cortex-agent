/**
 * Which workspace every table belongs to — the registry the scoped client reads.
 *
 * WHY A REGISTRY AND NOT A CONVENTION. The risk this whole change exists to
 * close is not "we forget the filter today", it is "somebody adds a query in
 * three months and nobody notices it has no filter". A convention cannot fail;
 * a registry can, and that is the point: `createOrgScopedClient` REFUSES to
 * serve a table that is not listed here. A new table therefore fails on its
 * first query, in development, with a message that says what to do — instead of
 * quietly returning every tenant's rows. `registry.test.ts` moves that failure
 * earlier still, to CI, by scanning the source for `.from('…')` and asserting
 * every name it finds is classified.
 *
 * The three kinds are decisions, not shades of the same thing:
 *
 *   tenant   The table has `organization_id`. Every read is filtered by it and
 *            every write carries it. This is the default and should stay the
 *            default; put a table here unless there is a reason not to.
 *
 *   derived  The table has no `organization_id` and inherits its tenant from a
 *            parent row. Reads and writes must constrain `parentKey`, and the
 *            client throws if they do not — so "forgot the filter" is equally
 *            impossible here, the row set is just reached by a different key.
 *            Reserved for tables that are pure children of a scoped parent and
 *            are never listed on their own (see migration 0064 § 12).
 *
 *   shared   The table is genuinely not tenant data: authentication, OAuth
 *            handshake state, product content. Each one carries the reason in
 *            `why`, because "shared" is the answer that can hide a leak and it
 *            should be uncomfortable to write.
 */

export const ORGANIZATION_COLUMN = 'organization_id';

/** The tenant of a `tenant` row is stated on the row itself. */
interface TenantTable {
  kind: 'tenant';
  /**
   * True only for `dev_task_events`, whose row is written by a webhook before
   * the delivery can be attributed to anything. A null never matches a filter,
   * so those rows are visible to no workspace, which is the correct reading.
   */
  nullable?: boolean;
}

/** The tenant of a `derived` row is its parent's; the parent must be named. */
interface DerivedTable {
  kind: 'derived';
  /** Column that points at the scoped parent. Every query must constrain it. */
  parentKey: string;
  /** The table it inherits from, for the error message. */
  parent: string;
}

/** Not tenant data at all. `why` is mandatory on purpose. */
interface SharedTable {
  kind: 'shared';
  why: string;
}

export type TableTenancy = TenantTable | DerivedTable | SharedTable;

const tenant = (nullable = false): TenantTable => ({ kind: 'tenant', nullable });
const derived = (parent: string, parentKey: string): DerivedTable => ({
  kind: 'derived',
  parent,
  parentKey,
});
const shared = (why: string): SharedTable => ({ kind: 'shared', why });

export const TABLE_TENANCY: Readonly<Record<string, TableTenancy>> = {
  // --- Directory and access -------------------------------------------------
  management_workflows: tenant(),
  knowledge_reviews: tenant(),
  management_workflow_events: tenant(),
  management_profiles: tenant(),
  management_cases: tenant(),
  activation_runs: tenant(),
  activation_automations: tenant(),
  activation_operations: tenant(),
  feed_prepared_views: tenant(),
  management_operations: tenant(),
  management_operation_events: tenant(),
  management_events: tenant(),
  // El libro del seguimiento de Gerencia (0158): lleva su propio
  // organization_id porque el vigilante lo lee por empresa, no por asunto.
  management_case_notices: tenant(),
  users: tenant(),
  teams: tenant(),
  team_members: tenant(),
  team_tool_permissions: tenant(),
  agents: tenant(),

  // --- Brain Knowledge ------------------------------------------------------
  kb_collections: tenant(),
  // Quién ve cada espacio (migración 0123). Tenant y no derivada de
  // `kb_collections`, por la misma razón que `team_members` lleva la columna en
  // vez de heredarla: se lee al revés — «qué espacios alcanza esta persona» —
  // sin un espacio en la mano.
  kb_space_grants: tenant(),
  kb_documents: tenant(),
  // Migración 0157: lo que se dijo en el chat, propuesto para la memoria de la
  // empresa hasta que alguien con permiso lo acepte. Tenant: una propuesta de
  // otra empresa aceptada aquí sería un «acuerdo» ajeno en la boca de Cortex.
  memory_proposals: tenant(),
  // Migración 0159: qué escalón de mora de qué factura ya se avisó. Tenant: el
  // vigilante de cartera corre por espacio y sólo reclama avisos del suyo.
  receivable_notices: tenant(),
  kb_chunks: derived('kb_documents', 'document_id'),
  // Tenant rather than derived even though most rows name a document: the whole
  // point of the table is "what did THIS workspace spend", which has to be
  // answerable without naming a document, and some rows have none.
  kb_embedding_usage: tenant(),
  gdrive_sync_state: tenant(),
  meeting_imports: tenant(),
  meeting_briefings: tenant(),
  // Calls Cortex joined live and kept after they ended (migration 0119). Tenant
  // rather than derived from kb_documents: the Calls page lists a workspace's
  // sittings without naming a document, and a call with no transcript still
  // has a row (document_id is nullable).
  live_calls: tenant(),

  // --- Chat and memory ------------------------------------------------------
  conversations: tenant(),
  messages: tenant(),
  user_memories: tenant(),
  user_preferences: tenant(),
  google_chat_links: tenant(),
  whatsapp_links: tenant(),

  // --- WhatsApp (migration 0068) --------------------------------------------
  // The bridge never touches Postgres itself; it posts to Cortex routes, which
  // write through a scoped handle like everything else. So these are ordinary
  // tenant tables even though the rows originate outside the request cycle.
  whatsapp_sessions: tenant(),
  whatsapp_session_keys: tenant(),
  whatsapp_groups: tenant(),
  whatsapp_messages: tenant(),
  whatsapp_ingest_windows: tenant(),
  whatsapp_group_replies: tenant(),
  // 0189: los procesos del puente (id, modo, techo, última señal). Ninguna
  // fila es de una empresa: dice qué proceso existe, no a quién sirve.
  whatsapp_bridge_instances: shared(
    'Bridge processes (id, mode, session cap, last heartbeat). No workspace data; which workspace a process holds lives on whatsapp_sessions.owner_instance.',
  ),
  // 0185: atención a clientes. Tenant las tres, en el sentido más delicado:
  // cada conversación es de UN cliente de UNA empresa, y una fila ajena aquí
  // sería el saldo de un cliente contado al de otra empresa.
  wa_customer_settings: tenant(),
  wa_customer_conversations: tenant(),
  wa_customer_messages: tenant(),

  // --- Automation -----------------------------------------------------------
  scheduled_jobs: tenant(),
  scheduled_job_runs: tenant(),
  pipelines: tenant(),
  pipeline_runs: tenant(),
  orchestration_runs: tenant(),
  orchestration_tasks: tenant(),
  orchestration_events: derived('orchestration_runs', 'run_id'),
  // Errands (migration 0089): a long-running commission that owns a sequence of
  // orchestration runs. All three carry their own organization_id — an errand
  // belongs to the company that asked for it, and its legs and its questions
  // are read on their own (the sweep scans legs across errands, the nav counts
  // open questions across the workspace), so neither is `derived`.
  errands: tenant(),
  errand_legs: tenant(),
  errand_questions: tenant(),

  // --- Configuración guiada (migration 0094) --------------------------------
  // La entrevista de puesta en marcha: lo que una empresa contó, lo que se le
  // propuso a partir de eso y qué se creó. Ambas tenant, y la segunda tenant y
  // no `derived` sobre la sesión a propósito: la pregunta que justifica la
  // tabla — "de lo que se configuró hablando, ¿qué sigue vivo dos semanas
  // después?" — se hace sobre TODA la empresa sin nombrar una sesión, que es
  // exactamente lo que una clasificación `derived` prohibiría.
  guided_setup_sessions: tenant(),
  guided_setup_items: tenant(),

  // --- Avisos (migration 0096) ----------------------------------------------
  // Hechos puntuales con hora dirigidos a una persona: un trámite que terminó,
  // una rutina que no pudo correr, un encargo que preguntó algo. Tenant y no
  // `derived` sobre `users` aunque toda fila nombre a una persona: la pregunta
  // que justifica la tabla — «¿qué ha pasado en este espacio de trabajo?» — se
  // hace por espacio, y el contador de la campana se lee por (espacio, persona)
  // sin nombrar una fila padre, que es justo lo que una clasificación `derived`
  // prohibiría. El aviso además cita el contenido de lo que ocurrió (el nombre
  // del trámite, el asunto del correo que salió), así que la fila es la cosa a
  // proteger y debe llevar el espacio encima.
  notifications: tenant(),

  // --- Integrations and tokens ----------------------------------------------
  integrations: tenant(),
  user_mcp_servers: tenant(),
  user_mcp_tools: derived('user_mcp_servers', 'server_id'),
  // The HTTP tools an organization defined for itself (migration 0067). Tenant
  // data in the strongest sense: the row names a destination inside — or
  // dangerously near — the customer's own systems, and holds the credential
  // used to reach it.
  custom_tools: tenant(),
  mcp_tokens: tenant(),
  mcp_pending_actions: tenant(),

  // --- Oversight ------------------------------------------------------------
  // What one turn actually handed the model (migration 0080), and the
  // per-conversation adjustments to it. Both tenant: a capture quotes the
  // workspace's own corpus, and a setting changes that workspace's assistant.
  turn_contexts: tenant(),
  turn_context_settings: tenant(),
  // How long each turn took (migration 0084). Tenant: latency is not comparable
  // across workspaces — corpus size, tool count and connected integrations all
  // move it — so a distribution that mixed them would describe nobody.
  turn_latencies: tenant(),

  // --- Learning (migration 0083) --------------------------------------------
  // What using Cortex taught it. Tenant in the strongest sense there is: this
  // is the one module in the product that GENERALISES from how a company works,
  // so a lost filter here would not leak a visible row — it would take one
  // customer's usage and quietly use it to answer another one. All three carry
  // their own organization_id rather than deriving it from the document they
  // point at, because every question the module asks ("what has this workspace
  // learned", "what is still waiting on somebody") is asked across documents
  // without naming one, which a `derived` classification would correctly refuse.
  learning_signals: tenant(),
  learning_adjustments: tenant(),
  learning_proposals: tenant(),
  audit_events: tenant(),
  security_events: tenant(),
  // Migración 0168: acciones seguras de repetir (una fila por acción con efectos).
  action_idempotency: tenant(),
  security_policies: tenant(),

  // --- Mandatos (migración 0099) --------------------------------------------
  // Lo que una empresa decidió que Cortex puede hacer sin preguntarle, y cada
  // vez que lo hizo. Tenant en el sentido más fuerte que hay en el producto:
  // una fila de `mandates` no es un dato, es un PERMISO — un filtro perdido aquí
  // no enseñaría la fila de otra empresa, dejaría que la declaración de una
  // empresa autorizara acciones dentro de otra. Es la única tabla del sistema
  // cuya lectura puede convertir un `confirm` en un `allow`.
  //
  // `mandate_uses` es tenant y no `derived` sobre `mandates` aunque toda fila
  // nombre una concesión: la pregunta que justifica la tabla —«¿qué hizo Cortex
  // por su cuenta en esta empresa este mes?»— se hace por espacio de trabajo y
  // sin nombrar un mandato, que es justo lo que una clasificación `derived`
  // prohibiría. Y el presupuesto diario se cuenta sobre varias concesiones a la
  // vez, no sobre una.
  mandates: tenant(),
  mandate_uses: tenant(),
  rate_limit_buckets: derived('users', 'user_id'),

  // --- Product surfaces -----------------------------------------------------
  growth_signals: tenant(),
  dev_repositories: tenant(),
  dev_tasks: tenant(),
  dev_task_events: tenant(true),
  vehicles: tenant(),
  vehicle_fines: tenant(),
  vehicle_consults: derived('vehicles', 'vehicle_id'),
  presentation_files: tenant(),
  // Los archivos del producto, antes en Supabase Storage (migración 0109). La
  // fila ES el contenido — el PDF de un candidato, el audio de una reunión — o
  // sea, exactamente la cosa a proteger, así que lleva el espacio encima.
  // Tenant y no `derived` de la fila que lo describe (kb_documents,
  // presentation_files) porque un archivo se lee por (bucket, path) sin nombrar
  // esa fila, que es lo que una clasificación `derived` prohibiría.
  app_files: tenant(),

  // --- Trámites web (migration 0087) ----------------------------------------
  // Errands on third-party portals, taught from a screen recording and replayed
  // without a model. Tenant in the strongest sense there is: a flow row names
  // the customer's own portals, and `browser_credentials` holds the login the
  // company uses on them. A lost filter here would not leak a record -- it
  // would let one workspace spend another workspace's password.
  //
  // The three children are derived rather than tenant because every read of
  // them is "the detail of THIS flow" or "the detail of THIS run", and a second
  // copy of the workspace id on a child row is a second thing that can be wrong.
  // `browser_flow_runs` is tenant because the screen lists a workspace's recent
  // runs across every flow, which naming a flow would make impossible.
  browser_credentials: tenant(),
  browser_flows: tenant(),
  browser_profiles: tenant(),
  browser_flow_versions: derived('browser_flows', 'flow_id'),
  browser_flow_grants: derived('browser_flows', 'flow_id'),
  browser_flow_runs: tenant(),
  browser_flow_run_steps: derived('browser_flow_runs', 'run_id'),
  // Un trámite parado esperando a una persona (migración 0111). `tenant` y no
  // `derived` del trámite: la consulta que de verdad se hace es «¿qué hay
  // parado en este espacio de trabajo?» — la hace la pantalla y la hace el
  // barrido que vence los viejos — y ninguna de las dos nombra un flow.
  browser_flow_checkpoints: tenant(),

  // --- Commitments (migration 0069) -----------------------------------------
  // Dated promises and the notices already sent about them. Both carry their
  // own organization_id rather than deriving the notice's tenant from its
  // commitment: the daily watcher scans notices by workspace and date without
  // naming a commitment, which a `derived` classification would (correctly)
  // refuse.
  commitments: tenant(),
  commitment_notices: tenant(),

  // --- Reports (migration 0079) ---------------------------------------------
  // Saved informes: the resolved document, not the query behind it. Tenant in
  // the strongest sense — a row holds an aggregate OF a workspace's data, so a
  // missing filter would not leak a visible row, it would silently move one
  // company's totals into another's report. The share link reads this table by
  // token through the service client, outside the scoped handle, because a link
  // clicked from WhatsApp carries no session to scope by.
  reports: tenant(),
  // Una pregunta guardada: qué bloques componen un informe a la medida y con
  // qué parámetros (migración 0107). Tenant, y no `derived` sobre nada, porque
  // no cuelga de ninguna fila padre — y porque una receta filtrada de menos no
  // filtra una fila visible, hace algo peor: deja que un espacio de trabajo
  // corra contra sus datos la pregunta que otro se molestó en formular, lo que
  // devuelve un informe perfectamente plausible sobre la empresa equivocada.
  report_recipes: tenant(),
  // A chart drawn inside a conversation, resolved and stored the moment it was
  // drawn so that keeping it costs no second query (migration 0088). Tenant for
  // exactly the reason above: the row is an aggregate of one workspace's data.
  // Not `derived` on conversations even though it carries a conversation_id —
  // the id is nullable (a chart can outlive the thread it was drawn in, and the
  // saved informe outlives both), and a derived table whose parent key may be
  // null has no tenancy at all.
  chat_charts: tenant(),
  // A file dropped into a chat and the destination the person chose for it
  // (migration 0088). Tenant rather than derived on conversations even though
  // the conversation id is not null here: on the 'turn' path the row HOLDS the
  // document's text, so it is the thing being protected rather than a pointer
  // to it, and it should carry the workspace itself.
  chat_attachments: tenant(),
  feed_sources: tenant(),
  feed_source_signals: tenant(),
  feed_combined_dependencies: tenant(),

  // --- Proposed actions (migration 0077) ------------------------------------
  // Drafted emails waiting on a human, and the record of every human edit to
  // one. Tenant on both: an action holds a client's address and the text that
  // will be sent over an employee's own signature, and the revisions hold both
  // sides of every rewrite. `action_revisions` carries its own organization_id
  // rather than deriving it from the action, because the interesting question
  // ("what does this workspace keep rewriting?") is asked across actions
  // without naming one — which a `derived` classification would refuse.
  actions: tenant(),
  action_revisions: tenant(),

  // --- Microsoft 365 (migration 0078) ---------------------------------------
  // The ledger of Outlook threads folded into Brain Knowledge: what was
  // archived, which document it became, and which client it belongs to. Tenant
  // in the strongest sense — the row names a client's correspondence.
  microsoft_mail_ingests: tenant(),
  // Lo mismo para Gmail (migración 0121), con una diferencia que importa: aquí
  // SÍ hay filas de correo interno, porque el destino puede ser el espacio
  // personal de quien conectó el buzón. Tenant igual — la fila nombra
  // correspondencia de una empresa — y la privacidad de más la pone el espacio,
  // que sólo su dueño puede leer.
  gmail_thread_ingests: tenant(),
  // El marcapáginas de cada buzón conectado: por dónde va la carga histórica y
  // por dónde va el barrido diario.
  gmail_sync_state: tenant(),
  mail_policies: tenant(),
  mail_consulted_threads: tenant(),
  mail_learning_proposals: tenant(),
  // Los adjuntos vistos, archivados o descartados (migración 0124). Tenant por
  // lo mismo que los hilos: la fila nombra correspondencia de una empresa, y
  // además dice el nombre del archivo, que a veces ya lo dice todo.
  mail_attachment_ingests: tenant(),
  // Los avisos de correo que se mandaron (migración 0126). Tenant: la fila
  // nombra un hilo de correspondencia de una empresa y el motivo por el que
  // interrumpió a alguien.
  mail_alerts: tenant(),

  // --- Clients (migration 0075) ---------------------------------------------
  // The customer companies everything else hangs off, and the three tables that
  // attach things to them. Tenant on all four: a client row IS the customer
  // list, `client_domains` says which mail belongs to whom, `client_contacts`
  // holds outsiders' names and addresses, and `client_links` names, one by one,
  // the documents and threads a workspace has decided are about a customer.
  // None of them is derivable from a parent — the review list reads
  // `client_links` across every client, and the search reads `client_domains`
  // by domain alone, both of which a `derived` classification would refuse.
  clients: tenant(),
  client_domains: tenant(),
  client_contacts: tenant(),
  client_links: tenant(),
  // 0179: los otros nombres de un cliente y las notas de su ficha.
  client_aliases: tenant(),
  client_notes: tenant(),

  // --- Document extraction (migration 0076) ---------------------------------
  // What was read out of each document, field by field, with the sentence each
  // value came from, plus the log of what humans corrected. Tenant on all three
  // rather than deriving the fields from their extraction: the review screen
  // counts what is pending across every document at once, and the corrections
  // are grouped by (document type, field) across the whole workspace to find
  // where the extractor is wrong — both are questions asked without naming a
  // parent row, which a `derived` classification would correctly refuse.
  document_extractions: tenant(),
  document_fields: tenant(),
  document_field_corrections: tenant(),
  source_classification_audit: tenant(),
  // --- Documentos que vencen (migración 0184) --------------------------------
  // El SOAT, la póliza o la licencia de UNA empresa, con su cita y su
  // responsable, y qué documentos ya se miraron. Tenant las dos: una fila
  // ajena aquí sería avisarle a una empresa del vencimiento de otra.
  document_expirations: tenant(),
  document_expiration_scans: tenant(),
  // --- Contratos y cumplimiento (migración 0195) -----------------------------
  // Los contratos de UNA empresa con sus obligaciones y su línea de tiempo,
  // sus plantillas propias, su perfil de cumplimiento (con el token del
  // formulario público de PQRS), su lista de cumplimiento, sus PQRS y sus
  // procesos judiciales. Tenant todas: una fila ajena aquí sería el contrato
  // laboral, el reclamo de un consumidor o la demanda de otra empresa.
  contract_templates: tenant(),
  contracts: tenant(),
  contract_obligations: tenant(),
  contract_events: tenant(),
  compliance_profiles: tenant(),
  compliance_items: tenant(),
  pqrs: tenant(),
  legal_cases: tenant(),
  legal_case_actions: tenant(),
  // --- Ayuda y soporte (migración 0190) --------------------------------------
  // Lo que una empresa le escribió a soporte y su voto en la ayuda. Tenant: un
  // filtro perdido le enseñaría a una empresa el problema que contó otra. La
  // bandeja de operación lee todas a propósito, con su propia puerta.
  support_tickets: tenant(),
  support_ticket_messages: tenant(),
  help_feedback: tenant(),
  // --- Módulos por empresa (migración 0186) ----------------------------------
  // Qué áreas de Cortex prendió o apagó cada empresa. Tenant: un filtro que
  // faltara le apagaría a una empresa el módulo que apagó otra.
  company_modules: tenant(),

  // --- Pagos (migration 0098) -----------------------------------------------
  // Lo que dice cada fuente sobre un pago, y lo que creemos a partir de todas
  // ellas. Tenant en el sentido más fuerte que hay en este producto: un filtro
  // perdido aquí no enseñaría una fila ajena, movería el dinero de una empresa
  // a la cartera de otra — una fuga con forma de número, que nadie audita
  // porque ya parece plausible.
  //
  // `payment_reports` es tenant y no `derived` sobre `payments` aunque casi
  // toda fila acabe apuntando a una: `payment_id` es NULABLE a propósito (un
  // reporte a la espera es el estado normal de una importación recién traída),
  // y una tabla derivada cuya clave padre puede ser nula no tiene inquilino
  // ninguno. Además la pregunta que justifica la tabla — «¿qué llegó de Siigo
  // este mes y qué no emparejó?» — se hace por espacio de trabajo sin nombrar
  // un pago, que es justo lo que una clasificación `derived` prohibiría.
  payments: tenant(),
  payment_reports: tenant(),

  // --- Metas (migración 0101) -----------------------------------------------
  // La cifra que alguien fijó, la lectura congelada de cada período cerrado, y
  // el registro de haberlo avisado. Las tres llevan su propio organization_id
  // en vez de derivar el inquilino de la meta: el cron barre las lecturas y los
  // avisos POR ESPACIO Y POR FECHA sin nombrar ninguna meta, que es exactamente
  // lo que una clasificación `derived` prohibiría — y con razón, porque sin la
  // columna esa consulta cruzaría inquilinos.
  //
  // `goal_readings` es tenant en el sentido más fuerte que tiene el producto,
  // igual que `usage_counters`: cada fila es un AGREGADO de los datos de un
  // espacio, así que un filtro que faltara no enseñaría una fila ajena — pondría
  // las cifras de una empresa en el tablero de otra, donde parecen un número y
  // no un escape.
  goals: tenant(),
  goal_readings: tenant(),
  goal_notices: tenant(),

  // --- La ficha de la empresa (migración 0104) -------------------------------
  // Los hechos que la empresa escribe sobre sí misma. Tenant, y de la clase que
  // más incomoda: estas filas no se enseñan en una tabla, SE INYECTAN ENTERAS EN
  // EL PROMPT de cada turno de cada superficie. Un filtro que faltara aquí no
  // dejaría a nadie leer la ficha de otra empresa — le pondría el NIT, el plazo
  // de pago y los límites de otra empresa EN LA BOCA A CORTEX, que los diría con
  // toda la seguridad del mundo porque para él son lo que es cierto. Una fuga
  // que no se ve en ninguna pantalla y que sale por la voz del producto.
  company_facts: tenant(),
  // La marca (migración 0170): logo, colores y nombre para mostrar. Sale en
  // las vistas compartidas, así que un filtro que faltara pondría el logo de
  // otra empresa en el tablero que se le manda a un cliente.
  company_branding: tenant(),

  // --- Tablas inventadas (migración 0115) ----------------------------------
  // El esquema de una tabla que este espacio se inventó, y sus filas. Tenant
  // las dos: un filtro que faltara aquí no enseñaría una hoja ajena — pondría
  // los remates, las placas o los contenedores de una empresa en la boca de
  // Cortex para otra, que los citaría como si fueran suyos.
  trackers: tenant(),
  tracker_rows: tenant(),
  // 0161: una fuente conectada que llena una tabla sola. Tenant: corre con la
  // identidad de quien la creó y escribe sólo en la tabla de su espacio.
  tracker_syncs: tenant(),
  // 0198: una consulta a una API por fila de una tabla, y su estado por fila.
  // Tenant las dos: gastan la cuota de una API con la llave de la empresa y
  // escriben en las filas de su espacio.
  row_lookups: tenant(),
  row_lookup_state: tenant(),
  // Mensaje, cargo y equipo que lleva una invitación hasta que se acepta (0199).
  invitation_details: tenant(),
  // 0164: una carpeta de Drive que llena una tabla, y su libro de archivos.
  // Tenant las dos: el libro guarda lo que se leyó de documentos de la empresa.
  drive_folder_syncs: tenant(),
  drive_folder_sync_files: tenant(),
  // 0165: la conexión con un programa contable (Siigo…) y las facturas por
  // cobrar que trae. Tenant las dos: la primera guarda la llave cifrada de la
  // empresa en ese programa; la segunda, su cartera.
  accounting_connections: tenant(),
  accounting_invoices: tenant(),
  // Migración 0166: cuándo bajó el saldo de una factura de programa contable
  // avisada. Tenant: la escribe el vigilante de cartera de ese espacio.
  receivable_balance_drops: tenant(),
  // 0172: el libro de plata. Tenant las cuatro, en el sentido más fuerte: un
  // filtro perdido aquí no enseñaría una fila ajena, pondría la nómina, la
  // caja y el margen de una empresa en las cifras de otra, con forma de número.
  ledger_movements: tenant(),
  ledger_accounts: tenant(),
  ledger_category_rules: tenant(),
  ledger_sync_state: tenant(),
  // 0173: los planes sobre el libro — escenarios guardados y lo que una persona
  // dijo que se repite (o que ignora). Tenant: son decisiones de una empresa
  // sobre su propia caja.
  ledger_scenarios: tenant(),
  ledger_recurring: tenant(),
  // 0175: la caja mínima de la empresa. Tenant: una fila por empresa, llave
  // `organization_id`; es la decisión de una empresa sobre su propia caja.
  ledger_settings: tenant(),

  // --- Vistas (migración 0156) ------------------------------------------------
  // Pantallas armadas sobre las tablas de arriba. Tenant las tres. La vista es
  // la que más se asoma afuera: su token abre filas de la empresa a quien lo
  // tenga, así que la ÚNICA lectura sin alcance es la búsqueda por token (ver
  // `findViewByToken`), y todo lo que sigue se lee con el espacio de esa fila.
  custom_views: tenant(),
  custom_view_versions: tenant(),
  custom_view_submissions: tenant(),
  // 0160: cada edición, tarjeta movida o botón usado en una vista, con quién.
  custom_view_events: tenant(),
  // 0208: aplicaciones — varias pantallas (vistas con app_id), roles con
  // permisos por tabla y miembros con rol. Tenant las cuatro: una app ajena
  // en el listado diría qué opera otra empresa, y un rol ajeno abriría sus filas.
  custom_apps: tenant(),
  custom_app_screens: tenant(),
  custom_app_roles: tenant(),
  custom_app_members: tenant(),
  // 0178: las vistas guardadas del visualizador de datos (filtros, orden,
  // columnas) por alcance — una tabla de la empresa, la lista de clientes.
  // Tenant: el nombre y los filtros de una vista dicen qué mira una empresa
  // («clientes en mora de Antioquia»), y una ajena en la lista sería una fuga.
  grid_views: tenant(),
  // 0171: las cifras que el pulso calculó cada día, para comparar sin
  // inventar. Tenant: son ventas, cartera y pagos de la empresa.
  pulse_snapshots: tenant(),

  // --- Ventas (migración 0182) ----------------------------------------------
  // Cotizaciones, pedidos y facturas con sus líneas, su línea de tiempo y el
  // consecutivo por empresa. Tenant las cuatro: son precios, clientes y
  // facturas de UNA empresa. El enlace público de una cotización se busca por
  // token sin alcance en un solo sitio (apps/web/lib/sales/public.ts) y todo lo
  // demás se lee con el espacio de esa fila.
  sales_documents: tenant(),
  sales_document_lines: tenant(),
  sales_document_events: tenant(),
  sales_sequences: tenant(),

  // --- Embudo comercial (migración 0193) -------------------------------------
  // Oportunidades, actividades, el embudo, el riesgo de perder cada cliente y
  // las encuestas de satisfacción. Tenant todas: son negocios, clientes y
  // opiniones de UNA empresa. La encuesta pública se busca por token sin
  // alcance en un solo sitio (apps/web/lib/crm/public.ts) y lo demás se lee
  // con el espacio de esa fila.
  crm_pipelines: tenant(),
  crm_opportunities: tenant(),
  crm_activities: tenant(),
  crm_client_risk: tenant(),
  nps_surveys: tenant(),
  nps_responses: tenant(),

  // --- Registro de trabajo (migración 0174) ----------------------------------
  // Quién tiene que hacer qué, quién lo hizo y cuándo. Tenant las tres, en el
  // sentido más delicado del producto: estas filas hablan de PERSONAS del
  // equipo (su trabajo, sus días fuera). Un filtro perdido aquí no enseñaría
  // una fila ajena: pondría el trabajo de la gente de una empresa en las
  // cifras de otra. Y `work_people_meta` es tenant y no `derived` sobre
  // `users` porque se lee por espacio («los equipos de esta empresa») sin
  // nombrar a una persona.
  work_items: tenant(),
  work_people_meta: tenant(),
  work_settings: tenant(),

  // --- Perseguir lo pendiente y aprender de lo recomendado (migración 0177) --
  // Los recordatorios ya reclamados (resumen diario de vencidos, aprobaciones
  // paradas) y cada recomendación de Cortex con lo que pasó después. Tenant
  // las dos: hablan de personas y clientes de UNA empresa, y la tasa de acierto
  // que sale de `recommendations` ordena los consejos de esa misma empresa.
  follow_through_notices: tenant(),
  recommendations: tenant(),

  // --- Piloto automático (migración 0176) ------------------------------------
  // La configuración, cada corrida diaria y cada cosa que vio, decidió e hizo.
  // Tenant las tres: hablan de la cartera, el banco y la gente de UNA empresa,
  // y una fila ajena aquí sería «hice esto en tu nombre» dicho a otra empresa.
  autopilot_settings: tenant(),
  autopilot_runs: tenant(),
  autopilot_items: tenant(),

  // --- Cuentas por pagar (migración 0181) ------------------------------------
  // Proveedores, sus facturas con el flujo de aprobación y lo revisado al
  // recibir. Tenant las tres: hablan de a quién le debe plata UNA empresa y
  // cuándo piensa pagarle; una fila ajena sería la deuda de otra en la caja.
  suppliers: tenant(),
  payable_invoices: tenant(),
  payable_intake_log: tenant(),

  // --- Nómina, vacaciones y SG-SST (migración 0194) --------------------------
  // Empleados con su salario, novedades, liquidaciones, desprendibles,
  // ausencias y el SG-SST con sus accidentes. Tenant todas: una fila ajena
  // sería el sueldo, la incapacidad o el accidente de alguien de otra empresa.
  payroll_settings: tenant(),
  employees: tenant(),
  payroll_periods: tenant(),
  payroll_novelties: tenant(),
  payroll_payslips: tenant(),
  payroll_items: tenant(),
  leave_requests: tenant(),
  sst_settings: tenant(),
  sst_plan: tenant(),
  sst_activities: tenant(),
  sst_incidents: tenant(),

  // --- Calendario tributario (migración 0180) --------------------------------
  // El perfil tributario (NIT, casillas del RUT) y cada fecha del año que sale
  // de él. Tenant las dos: el NIT y las fechas de una empresa en otra serían
  // avisos de impuestos ajenos, con el nombre de su contador.
  tax_profiles: tenant(),
  tax_obligations: tenant(),
  // Borradores de declaraciones y certificados de retención (migración 0197):
  // cifras de ventas, compras y retenciones de UNA empresa con sus terceros.
  tax_drafts: tenant(),
  tax_withholding_certificates: tenant(),

  // --- Inventario y compras (migración 0183) ---------------------------------
  // El catálogo, las bodegas, el libro de existencias (y su vista, que lleva
  // organization_id) y las órdenes de compra con sus líneas. Tenant todas: una
  // fila ajena aquí sería el costo, las existencias o lo que le compra una
  // empresa a sus proveedores en la pantalla de otra.
  products: tenant(),
  stock_locations: tenant(),
  stock_movements: tenant(),
  stock_levels: tenant(),
  purchase_orders: tenant(),
  purchase_order_lines: tenant(),

  // --- Estados financieros, presupuesto e informe para socios (0191) ---------
  // La clasificación de gastos, la copia de lo que dijo el programa contable,
  // el presupuesto con sus celdas y el informe mensual con su enlace. Tenant
  // todas: una fila ajena sería el resultado, la deuda o el informe de otra
  // empresa en la pantalla (o en el correo a los socios) de ésta.
  statement_settings: tenant(),
  accounting_report_snapshots: tenant(),
  budgets: tenant(),
  budget_lines: tenant(),
  board_report_settings: tenant(),
  board_reports: tenant(),

  // --- Órdenes de servicio y proyectos · flota y rutas (0196) ---------------
  // Proyectos con sus horas, tarifas, costos e hitos de facturación; el plan
  // de mantenimiento, lo hecho, los tanqueos y los recorridos de la flota.
  // Tenant todas: una fila ajena sería el margen, las horas de la gente o los
  // vehículos de otra empresa. Las tareas son `work_items` (ya tenant).
  projects: tenant(),
  project_rates: tenant(),
  time_entries: tenant(),
  project_costs: tenant(),
  project_milestones: tenant(),
  maintenance_plans: tenant(),
  maintenance_events: tenant(),
  fuel_logs: tenant(),
  trips: tenant(),

  // --- Registrar en el programa contable y cerrar el mes (0192) --------------
  // El plan de cuentas que Cortex usa para escribir, cada escritura en el
  // programa (compras, recibos, pagos a proveedor), el cierre de cada mes con
  // su lista y su bitácora. Tenant todas: una fila ajena sería una partida
  // escrita en el programa contable de otra empresa, o su mes cerrado.
  accounting_account_map: tenant(),
  accounting_writebacks: tenant(),
  close_periods: tenant(),
  close_tasks: tenant(),
  close_events: tenant(),

  // --- Plans, consumption and first run (migration 0085) --------------------
  // What a workspace is on, what it has consumed, and where it is in its first
  // ten minutes. `usage_events` and `usage_counters` are tenant in the strongest
  // sense the product has: a missing filter here would not show one company
  // another's rows, it would put another company's consumption on their
  // invoice — a leak that looks like a number rather than like data.
  //
  // Neither is written by application code. Both are filled by triggers on the
  // tables that already record the work (migration 0085 § 9), so the workspace
  // is copied from the row being metered and is never chosen.
  organization_subscriptions: tenant(),
  usage_events: tenant(),
  usage_counters: tenant(),
  organization_onboarding: tenant(),
  // Cobro dentro del producto (migración 0187): prueba, período pagado, pagos y
  // avisos de la pasarela. Tenant: lo que una empresa pagó y si está en mora no
  // es de nadie más. `access_requests` NO está aquí a propósito: es global (la
  // persona todavía no tiene empresa) y se lee sólo por el `pool` desde la
  // consola de operadores, como `company_groups`.
  billing_subscriptions: tenant(),
  billing_payments: tenant(),
  billing_events: tenant(),

  // --- Per-person pricing (migration 0086) ----------------------------------
  // The most people a workspace held at once in a billing period. Tenant for the
  // same reason as the counters above, and it is the sharper case of the two:
  // since 0086 a workspace's ceiling is its per-person quota TIMES this number,
  // so a lost filter here would not leak a row — it would compute one company's
  // limit, and one company's invoice, from another company's headcount. Written
  // only by triggers on public.users, so the workspace is copied from the
  // directory row and never chosen.
  organization_seat_periods: tenant(),

  // --- Answer-quality evaluation (migration 0082) ---------------------------
  // What the suite scored, run by run. Tenant on the run: the questions and the
  // corpus are the same everywhere (they live in git), but the configuration
  // under test is a workspace's own — its embedding model, its thresholds, its
  // tool catalogue. `evaluation_case_results` is derived rather than tenant
  // because every read of it is "the detail of THIS run", and a second copy of
  // the workspace id on a child row is a second thing that can be wrong.
  evaluation_runs: tenant(),
  evaluation_case_results: derived('evaluation_runs', 'run_id'),

  // --- Derechos del titular (migración 0188) --------------------------------
  // «Descargar todos los datos» y «eliminar la cuenta de la empresa». Tenant
  // las dos. `organization_deletions` no tiene llave foránea a la empresa a
  // propósito (es el acta del borrado y lo sobrevive), y la purga la salta.
  data_exports: tenant(),
  organization_deletions: tenant(),

  // --- Not tenant data ------------------------------------------------------
  // La autorización de tratamiento de datos (Ley 1581) y las consultas y
  // reclamos del titular (0188). De la PERSONA, como ba_two_factor: quien está
  // en dos empresas autoriza una vez, y se leen siempre por el id de la sesión.
  legal_consents: shared(
    'Proof of a person’s data-processing authorization (Ley 1581): keyed by ba_user, read only by the signed-in account’s own id; the optional organization_id only records where it was given.',
  ),
  legal_requests: shared(
    'A data subject’s own consultas y reclamos (Ley 1581 arts. 14-15): keyed by ba_user, read only by the signed-in account’s own id, and kept after the account is deleted as proof of attention.',
  ),
  // The price list. Product content, identical for every workspace, exactly
  // like `tool_embeddings`: four rows that only a migration changes, and no
  // workspace ever writes here. Scoping it by workspace would mean a copy of
  // the catalogue per tenant and a plan that could differ from the one on the
  // pricing page.
  plans: shared(
    'The plan catalogue. Product content: the same four rows for every workspace, written only by migrations. Which plan a workspace is ON is organization_subscriptions, which is tenant.',
  ),
  ba_user: shared(
    'Identity. One row per human across every workspace they belong to; the per-workspace directory row is public.users.',
  ),
  ba_session: shared(
    'Identity. Sessions belong to a person, and name the workspace they are acting in.',
  ),
  ba_account: shared('Identity. The SSO provider link for a person.'),
  ba_verification: shared('Identity. Short-lived verification tokens.'),
  ba_two_factor: shared('Identity. TOTP secrets belong to a person, not a workspace.'),
  ba_organization: shared(
    'The workspaces themselves. Scoping this by workspace would be circular.',
  ),
  ba_member: shared('Which people belong to which workspace. This table IS the tenancy graph.'),
  ba_invitation: shared(
    'Pending invitations. Carries its own organizationId and is only ever read through better-auth, which checks the inviter belongs to it.',
  ),
  oauth_clients: shared(
    'Registered MCP OAuth clients. Client registration is install-wide and holds no tenant data.',
  ),
  oauth_authorization_codes: shared(
    'Single-use handshake state keyed by a hash. Carries a user_id, and the workspace is resolved from that directory row the moment the code is exchanged.',
  ),
  oauth_access_tokens: shared(
    'Bearer tokens keyed by a hash. Same as the codes: the workspace comes from the user_id the token resolves to.',
  ),
  oauth_refresh_tokens: shared('Bearer tokens keyed by a hash. See oauth_access_tokens.'),
  tool_embeddings: shared(
    "Embeddings of the product's own tool descriptions, keyed by tool id. Product content, identical for every workspace; which tools a person may call is decided before ranking.",
  ),
};

export class UnclassifiedTableError extends Error {
  constructor(table: string) {
    super(
      `Table "${table}" has no tenancy classification. Add it to TABLE_TENANCY in packages/agent-tools/src/tenancy/tables.ts: \`tenant()\` if it holds business data (and give it an organization_id column in a migration), \`derived(parent, key)\` if it is a child of a scoped table, or \`shared(why)\` if it genuinely is not tenant data.`,
    );
    this.name = 'UnclassifiedTableError';
  }
}

export function tenancyOf(table: string): TableTenancy {
  const entry = TABLE_TENANCY[table];
  if (!entry) throw new UnclassifiedTableError(table);
  return entry;
}

/**
 * Database functions, and what the scoped client does about them.
 *
 * Same posture as the tables: an unlisted function is refused rather than
 * forwarded, so a new RPC has to state whether it needs a tenant.
 *
 *   organization  The function takes `p_organization_id`; the client fills it in
 *                 so no caller can pass the wrong one (or forget it).
 *   person        The function takes `p_user_id` and derives everything from it.
 *                 Since migration 0064 a directory row belongs to exactly one
 *                 workspace, so the person already names the tenant — this is
 *                 the shape `kb_visible_space_ids` and the memory functions use,
 *                 and it is the safest of the three because there is no tenant
 *                 argument to get wrong.
 *   maintenance   Install-wide machinery that touches no tenant-visible data.
 */
export type RpcTenancy = 'organization' | 'person' | 'maintenance';

export const RPC_TENANCY: Readonly<Record<string, RpcTenancy>> = {
  // Migración 0189: el puente de WhatsApp multiempresa. claim/release reparten
  // sesiones entre procesos (devuelven ids de espacio y un booleano, nunca
  // contenido); phone_taken dice sí/no sobre un número de OTRA empresa.
  whatsapp_bridge_claim: 'maintenance',
  whatsapp_bridge_release: 'maintenance',
  whatsapp_phone_taken: 'organization',
  activation_commit_run: 'organization',
  // Migración 0156: gastar el intento de contraseña bajo candado, y limpiarlo.
  custom_view_reserve_unlock: 'organization',
  custom_view_clear_unlocks: 'organization',
  // Migración 0191: lo mismo para el enlace del informe para socios.
  board_report_reserve_unlock: 'organization',
  board_report_clear_unlocks: 'organization',
  // Migración 0182: el siguiente consecutivo de cotización, pedido o factura.
  sales_next_number: 'organization',
  activation_automation_claim: 'organization',
  feed_source_signal: 'organization',
  activation_automation_finish: 'organization',
  finance_classify_source: 'organization',
  finance_list_sources: 'organization',
  management_start_daily: 'organization',
  management_operate: 'organization',
  mail_review_learning: 'organization',
  management_workflow_checkpoint: 'organization',
  management_workflow_start: 'organization',
  management_workflow_claim: 'organization',
  management_workflow_settle: 'organization',
  management_workflow_cancel: 'organization',
  management_save_case: 'organization',
  management_save_profile: 'organization',
  kb_visible_space_ids: 'person',
  // Migración 0123. Las tres derivan lo que se puede ver del usuario, igual que
  // la búsqueda: `kb_space_access` lleva el usuario dentro justamente para no
  // ser «cuéntame quién tiene acceso a este espacio» sin más.
  kb_spaces_for: 'person',
  kb_space_level: 'person',
  kb_space_for: 'person',
  kb_space_access: 'person',
  kb_search_scoped: 'person',
  kb_brain_graph: 'person',
  kb_conflict_candidates: 'person',
  // Migration 0073. Both derive the visible spaces from p_user_id, exactly like
  // the search does — `kb_note_retrieval` is the only write in this surface
  // that takes raw chunk ids from a caller, and it re-derives every one of them
  // from that visible set rather than trusting the list it was handed.
  kb_fragment_health: 'person',
  kb_note_retrieval: 'person',
  user_memory_context: 'person',
  user_memory_list: 'person',
  user_memory_remember: 'person',
  user_memory_forget: 'person',
  user_memory_set_status: 'person',
  user_memory_touch: 'person',
  consume_rate_limit_token: 'person',
  provision_organization_agents: 'organization',
  kb_mark_reindexed_documents: 'maintenance',
  // Migration 0080. The retention sweep for captured turn contexts: strips
  // quoted material past its detail window, deletes rows past their purge date.
  // Takes no workspace and returns two counts — there is no session behind the
  // cron that calls it, and nothing tenant-visible comes back.
  turn_context_purge: 'maintenance',
  // Migration 0084. Same shape and the same cron as the sweep above: deletes
  // expired latency rows and returns a count. No workspace, nothing visible.
  turn_latency_purge: 'maintenance',
  // Migración 0168. Borra las filas de action_idempotency cuya ventana venció
  // hace más de dos días; devuelve un número. Sin empresa, nada visible.
  action_idempotency_purge: 'maintenance',
  // Migration 0088. The same shape again, for the chat's own scratch: expired
  // charts nobody kept and expired attachments. Skips a chart that became an
  // informe, and never touches a document that entered Brain Knowledge.
  chat_surface_purge: 'maintenance',
  // Migration 0085. Re-derives every consumption counter from the ledger it
  // summarises and returns only the ones that disagree — which should be none.
  // Takes no workspace and returns no tenant content: a workspace id, a period,
  // a meter and two integers that ought to be equal.
  usage_counter_drift: 'maintenance',
};

export class UnclassifiedFunctionError extends Error {
  constructor(fn: string) {
    super(
      `Database function "${fn}" has no tenancy classification. Add it to RPC_TENANCY in packages/agent-tools/src/tenancy/tables.ts and say how it is scoped: 'person' (takes p_user_id, which names the workspace), 'organization' (takes p_organization_id, which the scoped client fills in), or 'maintenance' (touches no tenant-visible data).`,
    );
    this.name = 'UnclassifiedFunctionError';
  }
}

export function rpcTenancyOf(fn: string): RpcTenancy {
  const entry = RPC_TENANCY[fn];
  if (!entry) throw new UnclassifiedFunctionError(fn);
  return entry;
}

/**
 * Workspace ids that exist for the system's own bookkeeping and can never be a
 * customer's. Neither has rows in `ba_member`, so no session can select them;
 * they are listed here so code that enumerates workspaces can skip them and so
 * the names are greppable from TypeScript. See migration 0064 §§ 1 and 4.
 */
export const TEMPLATE_ORGANIZATION_ID = 'cortex-template';
export const QUARANTINE_ORGANIZATION_ID = 'cortex-quarantine';
