/**
 * LAS HERRAMIENTAS DEL CATÁLOGO, DICHAS COMO LAS DIRÍA UNA PERSONA.
 *
 * El registro tiene ~150 herramientas y todas traen una descripción en INGLÉS
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
  'gmail.propose_learning': 'Propón un aprendizaje para revisar de este hilo: ',
  'security.report_refusal': 'Registra por qué se rechazó esta acción: ',
  'security.get_action_policy': 'Muéstrame los permisos de acción de esta empresa',
  'security.set_action_policy': 'Ayúdame a configurar los permisos de acción para ',
  'management.brief': 'Muéstrame el resumen gerencial de esta empresa',
  'management.inspect': 'Consulta el asunto y su historial: ',
  'management.record': 'Registra este asunto para hacerle seguimiento: ',
  'management.daily_brief': 'Prepara el parte diario de esta empresa',
  'management.collection_status': 'Muéstrame cómo va el seguimiento de cobro: ',
  'management.start_collection': 'Prepara el seguimiento de cobro para ',
  'management.advance_collection': 'Actualiza el seguimiento de cobro de ',
  'management.operation': 'Muéstrame el ciclo gerencial y sus decisiones',
  'work.record': 'Registra que ',
  'work.record_batch': 'Anota en el registro de trabajo todas las filas de ',
  'work.preview_batch': 'Muéstrame qué trabajo entraría al registro desde ',
  'work.assign': 'Pásale a ',
  'work.suggest_mapping': '¿Cómo se volvería trabajo la tabla ',
  'work.configure': 'Configura el registro de trabajo para ',
  'work.update_person': 'Anota mis días fuera: ',
  'work.query': '¿Qué tengo pendiente?',
  'whatsapp.customer_conversations': '¿Qué clientes escribieron por WhatsApp?',
  'whatsapp.reply': 'Contéstale por WhatsApp al cliente: ',
  'management.propose_decision': 'Prepara una propuesta de decisión para revisar: ',

  'actions.list': 'Muéstrame las acciones que esperan mi aprobación',
  'actions.propose': 'Déjame redactado un mensaje para ',

  // La otra cola, y las dos frases tienen que distinguirse leídas seguidas en
  // el mismo menú: arriba son borradores que Cortex escribió y nadie ha
  // mandado; esto son llamadas que se pararon a medio ejecutar en otra
  // conversación —Claude, Google Chat, WhatsApp— y siguen paradas.
  'approvals.list': '¿Qué espera mi aprobación?',

  // Sin complemento y sin id: la frase no nombra el archivo porque el modelo lo
  // tiene delante, en el bloque de adjuntos del turno. Si no hay ninguno, lo
  // dirá — que es mejor menú que una fila que aparece y desaparece según lo que
  // haya en el chat.
  'attachments.promote': 'Guarda en el cerebro el archivo que te adjunté',

  'browser.list_flows': `Muéstrame los ${MODULE.many} que ya aprendiste`,
  'browser.run_flow': `Corre el ${MODULE.one} `,
  'browser.submit_flow': `Radica el ${MODULE.one} `,
  // La frase empieza por el dato porque así es como llega: la persona escribe
  // el código que le acaba de entrar, no «retoma el trámite».
  'browser.resume_flow': 'El código que me llegó es ',
  // La navegación libre se pide así; los pasos sueltos (act, read_page,
  // ask_person, request_secret, close_page) los decide el bot dentro de la
  // pestaña y no son una petición — están en la fontanería del test.
  'browser.open_page': 'Entra a este sitio web y encárgate: ',

  'chat.send_dm': 'Escríbele por Google Chat a ',
  'chat.send_message': 'Publica en el espacio de Google Chat ',

  'clients.directory': 'Muéstrame los clientes',
  'clients.link': 'Cuelga esto del cliente ',
  'clients.merge': 'Une estos dos clientes, son la misma empresa: ',
  'clients.overview': 'Dame el panorama completo del cliente ',
  'clients.register': 'Registra al cliente ',
  // Con el NIT dicho: la herramienta busca por nombre, por NIT, por dominio de
  // correo o por la dirección de alguien que trabaja ahí, y quien tiene el NIT
  // delante —una factura, una remesa— es justo quien no sabe el nombre exacto
  // con el que quedó registrado el cliente.
  'clients.search': 'Busca al cliente o el NIT ',

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
  'documents.confirm_expiration': 'Confirma la fecha de vencimiento que leíste de ',
  'documents.correction_stats': '¿Qué campos de los documentos toca corregir siempre?',
  // La pregunta de todos los días, no «lista los vencimientos».
  'documents.expiring': '¿Qué documentos vencen este mes?',
  'help.search': '¿Cómo uso Cortex para ',
  'documents.extract': 'Léeme este documento y sácale los datos: ',
  'documents.pending_review': 'Muéstrame los documentos leídos que faltan por confirmar',
  // «Documentos confirmados» es cómo lo llamamos nosotros. Nadie llega pidiendo
  // un documento confirmado: llega pidiendo las facturas de un cliente o las
  // guías con el plazo vencido. Los seis tipos no caben en una línea, así que
  // van los tres que se piden a diario — los otros los encuentra el buscador de
  // la puerta por el resumen del grupo, que sí los nombra enteros.
  'documents.records': 'Búscame las facturas, guías o declaraciones de ',
  'documents.reject': 'Descarta la lectura del documento ',
  // La pregunta que trae la descripción de la herramienta («cuánto le
  // facturamos a Coltrans en julio») y no «súmame los documentos», que es la
  // implementación dicha en voz alta.
  'documents.totals': '¿Cuánto le hemos facturado a ',
  'documents.track_expiration': 'Avísame antes de que venza ',

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
  'gmail.archive_thread': 'Guarda en el cerebro el hilo de correo ',
  'gmail.search': 'Busca en Gmail ',
  'gmail.train_brain': 'Aprende de mi correo de ',
  'gmail.training_status': 'Cuéntame cómo va el aprendizaje de mi buzón',
  'gmail.send_draft': 'Envía el borrador de Gmail ',
  'gmail.send_message': 'Manda este correo tal cual: ',

  'growth.find_signals': 'Búscame señales de mercado nuevas',
  'growth.identify_contact': 'Averigua quién decide en ',
  'growth.list_signals': 'Muéstrame las señales de mercado guardadas',
  'growth.update_signal': 'Califica la señal de mercado ',
  'growth.draft_outreach': 'Prepara un borrador comercial basado en la evidencia para ',

  // Metas. La de fijar deja el número por escribir a propósito: el objetivo lo
  // dice la empresa, y una frase que ya lo trajera puesto sería Cortex fijando
  // una meta que nadie declaró.
  // La frase es la pregunta de auditoría, no «muéstrame la ficha»: quien la
  // escribe está comprobando de dónde salen las respuestas que recibe, y la
  // herramienta contesta con lo que sabe Y con lo que le falta.
  'company.facts': '¿Qué sabes de nuestra empresa?',
  // Sin nombre a propósito, y sin puntos suspensivos: la pregunta entera es la
  // que más se hace y la que enseña que el producto sabe contestarla. Quien
  // quiera una persona concreta la escribe detrás.
  'directory.line': '¿Quién le responde a quién?',
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

  'kb.context': 'Ármame el contexto del cerebro sobre ',
  'kb.create_document': 'Guarda esto en el cerebro: ',
  'kb.share_space': 'Dale acceso al espacio ',
  'kb.list_spaces': 'Muéstrame los espacios del cerebro',
  'kb.search': 'Busca en el cerebro ',

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

  'meetings.join_live': 'Métete a esta reunión de Meet y escúchala: ',
  'meetings.speak': 'Dile en voz alta a la reunión: ',
  'meetings.live_status': '¿Qué se está diciendo ahora en la reunión?',
  'meetings.get_transcript': 'Léeme la transcripción de la reunión ',
  'meetings.import_transcript': 'Guarda en el cerebro la reunión ',
  'meetings.list_transcripts': 'Muéstrame las reuniones que dejaron transcripción',
  'meetings.prepare_briefing': 'Prepárame para la reunión ',
  'meetings.schedule_briefings': 'Prepárame un briefing antes de cada reunión de mañana',

  'mscal.create_event': 'Agéndame en Outlook una reunión ',
  'mscal.list_events': 'Muéstrame la agenda de Outlook de ',

  'outlook.archive_thread': 'Archiva en el cerebro el hilo de Outlook ',
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
  'payments.preview_bank_statement': 'Mira este extracto del banco: ',
  'payments.import_bank_statement': 'Importa el extracto del banco ',
  'payments.bank_unmatched': '¿Qué entró al banco que no sé de qué factura es?',
  'payments.apply_to_invoice': 'Ata el pago del banco a la factura ',
  'payments.recovered': '¿Cuánta plata me has ayudado a recuperar?',
  'recommendations.list': '¿Qué me has recomendado y qué pasó?',

  'ledger.record': 'Anota en el libro de plata que ',
  'ledger.record_batch': 'Anota en el libro de plata los movimientos de ',
  'ledger.preview_batch': 'Mira qué entraría al libro de plata desde ',
  'ledger.recategorize': 'Los pagos a ',
  'ledger.query': '¿En qué se nos fue la plata este mes?',
  'ledger.set_balance': 'El saldo de hoy en la cuenta ',
  'ledger.forecast': '¿Cómo va a estar la caja las próximas semanas?',
  'ledger.explain_week': '¿Por qué la caja queda tan apretada la semana del ',
  'ledger.save_scenario': 'Guarda como escenario que ',
  'ledger.declare_recurring': 'Todos los meses pagamos ',
  'ledger.decide_recurring': 'Confirma el movimiento que se repite de ',
  'ledger.set_minimum_cash': 'Avísame si la caja baja de ',
  'ledger.categorize_pending': 'Ponle categoría a lo que falta en el libro de plata',
  'payables.inbox': '¿Qué facturas de proveedor tengo por aprobar?',
  'payables.pay_plan': '¿Qué pagos a proveedores hay esta semana y cómo queda la caja?',
  'payables.record': 'Anota la factura de proveedor ',
  'payables.approve': 'Aprueba las facturas de proveedor ',
  'payables.reject': 'Rechaza la factura de proveedor ',
  'payables.schedule': 'Programa el pago de las facturas aprobadas ',
  'autopilot.plan': '¿Qué vas a hacer hoy?',
  'autopilot.status': '¿Qué hiciste hoy?',
  'autopilot.configure': 'Hazte cargo de ',
  'autopilot.remind': 'Recuérdale a ',
  'modules.list': '¿Qué módulos tengo prendidos?',
  'modules.set': 'Prende el módulo de ',

  'inventory.stock': '¿Qué productos están bajo el mínimo?',
  'inventory.move': 'Registra que llegaron ',
  'inventory.reorder': '¿Qué tengo que comprar esta semana?',
  'purchasing.create_po': 'Prepárame las órdenes de compra de lo que está bajo el mínimo',
  'purchasing.send_po': 'Envíale al proveedor la orden de compra ',
  'purchasing.receive': 'Llegó la mercancía de la orden de compra ',
  'projects.create': 'Abre una orden de servicio para ',
  'projects.status': '¿Cómo van los proyectos? ¿Cuáles están atrasados?',
  'projects.log_time': 'Registra mis horas de hoy en el proyecto ',
  'projects.profitability': '¿Cuánto nos está dejando cada proyecto?',
  'projects.invoice': 'Factura lo que falta del proyecto ',
  'fleet.status': '¿Qué vehículo necesita mantenimiento?',
  'fleet.log_fuel': 'Registra el tanqueo del vehículo ',
  'fleet.log_maintenance': 'Registra el mantenimiento del vehículo ',
  'fleet.log_trip': 'Registra el recorrido de hoy: ',
  'tax.calendar': '¿Qué impuestos nos vencen este mes?',
  'tax.configure': 'Configura el calendario tributario con el NIT ',
  'tax.mark': 'Marca como pagada la declaración de ',
  'tax.draft': 'Prepárame el borrador del IVA de ',
  'tax.certificates': 'Mándales a los proveedores el certificado de retención de ',
  'tax.exogena_export': 'Prepárame la exógena del año ',
  'statements.get': '¿Cómo nos fue este año? Muéstrame el estado de resultados y el balance',
  'budget.get': '¿Cómo vamos contra el presupuesto?',
  'budget.set_line': 'Presupuesta para arriendo cada mes ',
  'forecast.pnl': '¿Cuánto vamos a vender los próximos 12 meses?',
  'board.generate': 'Arma el informe para socios del mes pasado',
  'board.send': 'Manda el informe para socios a ',
  'contracts.draft': 'Redáctame un borrador de contrato de ',
  'contracts.list': '¿Qué contratos vencen o hay que avisar este trimestre?',
  'contracts.obligations': '¿Qué obligaciones de contratos tenemos este mes?',
  'contracts.extract_obligations': 'Lee las obligaciones del contrato firmado de ',
  'compliance.status': '¿Cómo vamos en cumplimiento legal y societario?',
  'compliance.mark': 'Marca como cumplida la obligación de ',
  'compliance.pqrs_create': 'Radica como PQRS el mensaje de ',
  'compliance.pqrs_respond': 'Guarda la respuesta de la PQRS ',
  'compliance.case_update': 'Actualiza el proceso judicial con radicado ',
  // Cierre contable (0192).
  'close.status': '¿Cómo va el cierre del mes? ¿Qué falta?',
  'close.mark_task': 'Da por hecha la tarea del cierre ',
  'close.close_period': 'Cierra el mes de ',
  'accounting.write_purchase': 'Causa en el programa contable las facturas de proveedor aprobadas',
  'accounting.write_receipt': 'Registra en el programa contable los recibos de caja del mes',
  'accounting.write_supplier_payment':
    'Registra en el programa contable los pagos a proveedores del mes',

  'payroll.client_report': 'Dame el costo del equipo puesto en el cliente ',
  'payroll.cost_projection': 'Proyéctame lo que va a costar el equipo en ',
  // «El perfil de » a secas se lee, en el mismo menú donde está «Dame el
  // panorama completo del cliente », como si fuera la ficha de una empresa. Es
  // la de una persona, y trae su sueldo.
  'payroll.employee_profile': 'Dame el perfil de nómina de ',
  'payroll.expenses_report': 'Dame el informe de gastos de ',
  'payroll.payroll_stats': '¿Cuánto nos ha costado la nómina?',
  'payroll.team_assignments': '¿Quién está asignado a cada cliente?',
  'payroll.team_overview': 'Dame el panorama del equipo, sin nombres ni sueldos',
  // La nómina propia y el SG-SST (0194).
  'payroll.period_summary': '¿Cómo va la nómina de este mes?',
  'payroll.register_novelty': 'Registra horas extra en la nómina de ',
  'payroll.approve_period': 'Aprueba la nómina liquidada de ',
  'payroll.payslip': 'Muéstrame mi último desprendible de pago',
  'payroll.leave_request': 'Quiero pedir vacaciones del ',
  'payroll.leave_status': '¿Cuántos días de vacaciones tengo?',
  'payroll.leave_decide': 'Aprueba la solicitud de vacaciones de ',
  'sst.status': '¿Cómo vamos con el SG-SST? ¿Qué nos falta?',
  'sst.log_activity': 'Registra la capacitación de ',
  'sst.report_incident': 'Quiero reportar un accidente de trabajo: ',

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
  'reports.compose': 'Ármame un informe a la medida con ',
  'reports.generate': 'Hazme el informe de ',
  'reports.list': 'Muéstrame los informes guardados',
  'reports.open': 'Ábreme el informe de ',
  'reports.recipes': 'Muéstrame los informes a la medida que ya tengo',
  'reports.run': 'Vuelve a correr el informe a la medida ',
  'reports.share': 'Comparte por enlace el informe de ',

  'kb.propose_memory': 'Recuerda para la empresa que ',
  'trackers.define': 'Crea una tabla para vigilar ',
  'trackers.list': 'Muéstrame las tablas que hemos inventado',
  'trackers.query': 'Muéstrame la tabla de ',
  'trackers.remove': 'Borra de la tabla ',
  'trackers.upsert': 'Anota en la tabla ',
  'feed.connect_google_sheet': 'Conecta esta hoja de Google: ',
  'trackers.propose_from_source': 'Lee la hoja y propón la tabla: ',
  'trackers.sync_from_source': 'Haz que la tabla se llene sola desde la fuente ',
  'trackers.update_from_source': 'Que la fuente actualice la tabla ',
  'trackers.syncs': 'Muéstrame las tablas que se llenan solas',
  'trackers.row_lookup_create': 'Consulta en una API el estado de cada fila de la tabla ',
  'trackers.row_lookup_status': 'Muéstrame cómo van las consultas automáticas',
  'trackers.row_lookup_update': 'Cambia o pausa la consulta automática ',
  'trackers.propose_from_drive_folder': 'Mira la carpeta de Drive y propón la tabla: ',
  'trackers.sync_from_drive_folder': 'Llena una tabla con los archivos de la carpeta de Drive ',
  'trackers.drive_syncs': 'Muéstrame las carpetas de Drive que llenan tablas',
  'trackers.retry_sync': 'Vuelve a correr la sincronización de ',
  'accounting.status': '¿Cómo va la conexión con el programa contable?',
  'accounting.sync_now': 'Trae ya lo nuevo del programa contable',
  'apps.list': 'Muéstrame las aplicaciones que tenemos',
  'apps.create': 'Hazme una aplicación para ',
  'apps.get': 'Muéstrame cómo está armada la aplicación ',
  'apps.update': 'Cambia la aplicación ',
  'apps.publish': 'Publica la aplicación ',
  'apps.assign_members': 'Asigna a mi equipo a la aplicación ',
  'apps.invite_users': 'Invita a estas personas a la aplicación ',
  'views.archive': 'Archiva la vista ',
  'views.company_pulse': 'Dime cómo va la empresa en una vista',
  'views.refresh_summary': 'Actualiza el resumen de hoy de la vista ',
  'views.schedule_pulse': 'Actualiza cada mañana el resumen del pulso de la empresa',
  'views.weekly_review': '¿Cómo nos fue esta semana?',
  'views.schedule_weekly_review': 'Hazme un resumen cada lunes de cómo nos fue',
  'views.create': 'Hazme una vista con ',
  'views.get': 'Muéstrame la vista ',
  'views.list': 'Muéstrame las vistas que tenemos',
  'views.share': 'Comparte por enlace la vista ',
  'views.update': 'Cambia la vista ',

  'sales.draft_proposal': 'Redáctame una propuesta para ',
  'sales.quote_create': 'Hazle una cotización a ',
  'sales.quote_send': 'Mándale al cliente la cotización ',
  'sales.invoice_emit': 'Factura electrónicamente el pedido ',
  'sales.list': '¿Qué cotizaciones están esperando respuesta?',

  'crm.pipeline': '¿Cómo va el embudo comercial?',
  'crm.create_opportunity': 'Abre un negocio con ',
  'crm.update_opportunity': 'Pasa a negociación el negocio con ',
  'crm.log_activity': 'Anota que hablé con ',
  'crm.at_risk': '¿Qué clientes se nos están yendo?',
  'crm.send_nps': 'Mándale la encuesta de satisfacción a ',

  'team.invite': 'Invita a la empresa a ',

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

  'web.news': 'Busca noticias recientes sobre ',
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
