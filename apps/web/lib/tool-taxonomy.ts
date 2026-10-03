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
  whatsapp: {
    name: 'Atención por WhatsApp',
    blurb:
      'Los clientes que escribieron al número de la empresa: qué les contestó Cortex, de dónde salió cada dato, y responderles como persona dentro de su conversación.',
    tone: 'emerald',
    icon: 'MessagesSquare',
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
    name: 'Ventas',
    blurb:
      'Propuestas, cotizaciones con IVA y retenciones, pedidos y la factura electrónica: el cliente acepta la cotización desde un enlace con la marca de la empresa y la factura sale por Siigo o Alegra, que la sellan ante la DIAN, siempre con la aprobación de una persona.',
    tone: 'amber',
    icon: 'Handshake',
  },
  crm: {
    name: 'Embudo comercial',
    blurb:
      'Los negocios por etapa con su valor, probabilidad y cierre esperado; el pronóstico ponderado por mes; la etapa que se mueve sola con la cotización; el seguimiento de lo quieto; los clientes que se están yendo, con la evidencia; y la encuesta de satisfacción con su tarea cuando alguien califica mal.',
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
  ledger: {
    name: 'Libro de plata',
    blurb:
      'Toda la plata de la empresa en un solo libro: lo que entró y salió y lo que está por cobrar y por pagar, venga del programa contable, del extracto del banco, de los pagos, de una factura leída o del chat, contado una sola vez y con su categoría. De aquí salen ventas, gastos, margen y caja, y la proyección de caja a 13 semanas con sus escenarios («¿y si el cliente paga tarde?», «¿y si contrato a dos personas?») medida contra la caja mínima que fija la empresa.',
    tone: 'emerald',
    icon: 'Coins',
  },
  payables: {
    name: 'Cuentas por pagar',
    blurb:
      'Las facturas de los proveedores desde que llegan —el ZIP de la factura electrónica en el correo, un PDF en la Bandeja, una compra en Siigo, Alegra o QuickBooks, o dictada en el chat— hasta que el banco las paga: revisión sola (doble cobro, NIT equivocado, precio que subió, retención que falta, orden de compra), aprobación, día de pago sugerido contra la caja mínima y el programa de pagos de la semana. Cortex nunca paga: aprueba, programa y se entera por el extracto.',
    tone: 'emerald',
    icon: 'Coins',
  },
  inventory: {
    name: 'Inventario',
    blurb:
      'Las existencias de cada producto por bodega, sumadas de un libro de entradas, salidas, ajustes y traslados —cada una con su referencia—, el costo promedio ponderado, lo que se consume por día y lo que está bajo el mínimo. Llegan del programa contable (Siigo, Alegra o QuickBooks, con existencias cuando lo dan) o de una hoja, y el conteo físico ajusta la diferencia.',
    tone: 'amber',
    icon: 'Boxes',
  },
  purchasing: {
    name: 'Compras',
    blurb:
      'De «esto está bajo el mínimo» a la mercancía en bodega: órdenes de compra por proveedor con la cantidad que cubre los días de entrega, aprobación en la cola de siempre, el PDF con la marca de la empresa al correo del proveedor, la recepción total o en parte, y la factura del proveedor atada a su orden. Lo aprobado entra a la proyección de caja como compra comprometida.',
    tone: 'amber',
    icon: 'Receipt',
  },
  accounting: {
    name: 'Programas contables',
    blurb:
      'Siigo, Alegra o QuickBooks Online conectados directo: clientes, productos, facturas y pagos llegan solos a tablas de la empresa, y las facturas con saldo entran a la cartera con el saldo que dice el programa. La llave la conecta un administrador en Integraciones y nunca pasa por el chat.',
    tone: 'emerald',
    icon: 'Coins',
  },
  documents: {
    name: 'Documentos leídos',
    blurb:
      'Facturas, guías, declaraciones de aduana, certificados de origen, contratos, pólizas y comprobantes de pago leídos a campos que se pueden sumar, sin perder las palabras de donde salió cada dato; y los papeles que vencen (SOAT, tecnomecánica, pólizas, licencias, permisos, habilitaciones, contratos) con su fecha, su cita y quién los renueva. Nada entra en una cifra ni se vigila hasta que una persona lo confirma.',
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
      'La nómina liquidada en Cortex con la ley colombiana (novedades, desprendibles, vacaciones y permisos, aprobación) y el servicio aparte de nómina: lo que se pagó, gastos, costo por cliente y proyecciones.',
    tone: 'rose',
    icon: 'Wallet',
  },
  kb: {
    name: 'Cerebro',
    blurb: 'La memoria de la empresa: busca en los documentos internos y escribe nuevos.',
    tone: 'sky',
    icon: 'BookOpen',
  },
  // Familia propia y no parte de `kb` porque lo que toca es el ADJUNTO de una
  // conversación —con su id, su chat y su semana de vida—, y el documento del
  // cerebro es la consecuencia. Se agrupa con «Documentos» porque ahí es donde
  // termina, que es lo que la persona está pidiendo.
  attachments: {
    name: 'Archivos del chat',
    blurb:
      'Los archivos que alguien soltó en una conversación diciendo «sólo para este chat», y la forma de arrepentirse: subirlos al cerebro sin volver a cargarlos.',
    tone: 'sky',
    icon: 'Paperclip',
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
  management: {
    name: 'Gerencia',
    blurb:
      'Los asuntos que Cortex lleva como gerente: el resumen del día, el detalle de cada asunto y el registro de lo que se decidió o se hizo, con su evidencia.',
    tone: 'primary',
    icon: 'Target',
  },
  recommendations: {
    name: 'Lo que Cortex recomendó',
    blurb:
      'Cada recomendación que hizo Cortex —en la revisión semanal, las señales del equipo, las alertas de la caja, el pulso y Gerencia— con si se siguió y qué pasó después, medido sin atribuirse lo que habría pasado igual.',
    tone: 'sky',
    icon: 'Target',
  },
  modules: {
    name: 'Módulos',
    blurb:
      'Qué áreas de Cortex tiene prendidas la empresa —finanzas, ventas, inventario, nómina, flota, piloto y las demás— y prenderlas o apagarlas. Apagar un módulo lo saca del menú y de las herramientas sin borrar datos.',
    tone: 'primary',
    icon: 'Boxes',
  },
  autopilot: {
    name: 'Piloto automático',
    blurb:
      'Lo que Cortex hace solo cada mañana: arma el plan del día de la empresa, hace lo rutinario que tiene permitido (atar pagos que casan sin duda, categorizar el libro, reintentar sincronizaciones, recordar vencimientos) y deja la lista corta de lo que necesita tu decisión. Nunca mueve plata.',
    tone: 'primary',
    icon: 'Workflow',
  },
  statements: {
    name: 'Estados financieros',
    blurb:
      'Estado de resultados de caja con el año anterior al lado, balance general (del programa contable o aproximado, diciendo qué le falta) e indicadores con su fórmula: márgenes, liquidez, endeudamiento, días de cartera, inventario y proveedores, punto de equilibrio.',
    tone: 'emerald',
    icon: 'BarChart3',
  },
  budget: {
    name: 'Presupuesto',
    blurb:
      'El presupuesto del año por categoría y mes, contra lo real con semáforo, y lo que se salió avisado por el piloto.',
    tone: 'emerald',
    icon: 'Target',
  },
  forecast: {
    name: 'Pronósticos',
    blurb:
      'Ventas y resultados de los próximos 12 meses con estacionalidad o al ritmo reciente, qué clientes los sostienen, la demanda por producto y escenarios, con sus supuestos en palabras.',
    tone: 'emerald',
    icon: 'TrendingUp',
  },
  close: {
    name: 'Cierre del mes',
    blurb:
      'La lista guiada del cierre de cada mes, que se revisa sola contra los datos (extractos hasta fin de mes, abonos sin factura, facturas de proveedor sin aprobar o sin causar, recibos sin registrar, movimientos sin categoría, nómina, impuestos, inventario), y el candado del mes cerrado. Con el programa contable conectado, Cortex causa las compras y registra recibos y pagos en Siigo, Alegra o QuickBooks, siempre con vista previa y tu aprobación.',
    tone: 'emerald',
    icon: 'Receipt',
  },
  contracts: {
    name: 'Contratos',
    blurb:
      'Borradores de contrato desde plantillas (prestación de servicios, NDA, laborales, compraventa, arrendamiento, otrosí, terminación) para revisión de un abogado, las obligaciones de cada contrato firmado con su frase y el aviso previo vigilado. No es asesoría legal.',
    tone: 'primary',
    icon: 'FileText',
  },
  compliance: {
    name: 'Cumplimiento',
    blurb:
      'La lista societaria y legal de la empresa según su perfil (asamblea, libros, matrícula, RNBD, política de datos, SAGRILAFT/PTEE), las PQRS con su plazo en días hábiles y los procesos judiciales. Lo que depende de un umbral sale «por confirmar».',
    tone: 'rose',
    icon: 'ShieldCheck',
  },
  board: {
    name: 'Informe para socios',
    blurb:
      'El informe mensual de gerencia armado solo con los datos (resultados, presupuesto, caja, cartera, indicadores, hitos, riesgos), con PDF de marca, enlace con contraseña y envío con tu aprobación.',
    tone: 'primary',
    icon: 'FileText',
  },
  sst: {
    name: 'SG-SST',
    blurb:
      'Seguridad y salud en el trabajo: el cumplimiento de los estándares mínimos, las capacitaciones, exámenes, inspecciones y simulacros, y los accidentes con sus plazos de FURAT e investigación.',
    tone: 'emerald',
    icon: 'ShieldCheck',
  },
  tax: {
    name: 'Impuestos',
    blurb:
      'El calendario tributario de la empresa sacado del NIT y del RUT —renta, IVA, retención, exógena, Régimen Simple, ICA, PILA, nómina electrónica y Cámara de Comercio— con avisos al contador y la evidencia de lo presentado o pagado. Cortex no presenta ni paga ante la DIAN.',
    tone: 'amber',
    icon: 'Receipt',
  },
  work: {
    name: 'Registro de trabajo',
    blurb:
      'Quién tiene que hacer qué y quién lo hizo: casos, compromisos, filas de tablas con responsable y lo que cualquiera anote. Mide trabajo, no personas: cada quien ve todo lo suyo y quien administra ve al equipo.',
    tone: 'sky',
    icon: 'Users',
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
    blurb:
      'Leer el buzón, buscar hilos, preparar borradores y enviar los que se aprueben — y aprender del buzón entero: guardarlo en tu cerebro y leer cada día lo nuevo.',
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
      'El correo de Microsoft 365: buscar, leer un hilo completo, dejar borradores, enviarlos y archivar en el cerebro lo que se habla con clientes.',
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
  trackers: {
    name: 'Tablas',
    blurb:
      'Tableros que esta empresa se inventa: el agente define los campos, llena las filas y las consulta. No sustituye clientes, vencimientos ni cartera.',
    tone: 'emerald',
    icon: 'Table2',
  },
  views: {
    name: 'Vistas',
    blurb:
      'Pantallas a la medida sobre las tablas de la empresa: tableros, portales y formularios. Se piden y se cambian escribiendo, y se comparten por enlace o con contraseña. Incluye el pulso de la empresa, con su resumen escrito cada mañana.',
    tone: 'primary',
    icon: 'SquareKanban',
  },
  projects: {
    name: 'Proyectos y órdenes de servicio',
    blurb:
      'El trabajo que se hace para cada cliente, de la cotización a la factura: tareas en el registro de trabajo, horas por persona con su costo, materiales que salen del inventario, gastos y subcontratos, hitos de facturación y el margen de cada uno contra lo presupuestado. Avisa lo que se pasa del presupuesto, lo atrasado y lo terminado sin facturar.',
    tone: 'primary',
    icon: 'SquareKanban',
  },
  fleet: {
    name: 'Flota y rutas',
    blurb:
      'Los vehículos de la empresa con su conductor, kilometraje y documentos (SOAT, tecnomecánica, póliza), el mantenimiento que toca por km o por tiempo, los tanqueos con su rendimiento y el consumo raro, los recorridos con sus paradas y lo que cuesta cada km.',
    tone: 'emerald',
    icon: 'Car',
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
      'Vueltas aprendidas en portales ajenos: entra, llena el formulario y trae el resultado. Los que radican algo piden aprobación. Y para el sitio que nadie le ha enseñado, navega en vivo: una pestaña que ves en el chat mientras trabaja, donde puedes tomar el control cuando un paso es tuyo.',
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
  help: {
    name: 'Ayuda de Cortex',
    blurb:
      'Cómo se usa Cortex, con los mismos artículos de /ayuda: «¿cómo conecto Siigo?», «¿dónde subo el extracto?». Contesta con los pasos y el enlace, nunca de memoria.',
    tone: 'primary',
    icon: 'BookOpen',
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
    blurb: 'Buscar en el cerebro, abrir archivos del Drive y leer o escribir hojas de cálculo.',
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
      'SOAT y RTM desde el RUNT, comparendos desde el SIMIT, todo lo que se vence con fecha —contratos, pólizas, plazos de aduana y pagos— y las vueltas en portales ajenos: las aprendidas corren solas, y a un sitio nuevo entra en vivo, con la pestaña a la vista en el chat.',
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
  // Con los clientes: el embudo es lo que viene con cada uno, y el riesgo de
  // perderlo es una pregunta sobre el cliente, no sobre la plata.
  crm: 'clients',
  presentations: 'clients',
  payments: 'billing',
  accounting: 'billing',
  ledger: 'billing',
  payables: 'billing',
  // Con la plata: una orden de compra es un «por pagar» que todavía no llega,
  // y el inventario es plata quieta en la bodega.
  inventory: 'billing',
  purchasing: 'billing',
  // Con la plata: un impuesto es una fecha y un pago, y quien pregunta por la
  // retención es quien pregunta por la caja.
  tax: 'billing',
  // Con la plata: los estados, el presupuesto, el pronóstico y el informe a
  // socios son la misma conversación que la caja y la cartera.
  statements: 'billing',
  budget: 'billing',
  // Con la plata: cerrar el mes es cuadrar la caja, la cartera y lo por pagar.
  close: 'billing',
  forecast: 'billing',
  board: 'billing',
  // Con la empresa: contratos y cumplimiento son cómo está parada legalmente.
  contracts: 'company',
  compliance: 'company',
  // Con los pagos y no con «Documentos y memoria»: lo que lee este módulo no es
  // documentación, son cifras con un papel detrás. La cartera se calcula
  // restándole los pagos a las facturas que salieron de aquí, así que separar
  // las dos mitades obligaría a buscar en dos sitios la misma conversación.
  documents: 'billing',
  gmail: 'comms',
  actions: 'comms',
  outlook: 'comms',
  slack: 'comms',
  // Con la comunicación: es contestarle a un cliente que escribió.
  whatsapp: 'comms',
  chat: 'comms',
  people: 'comms',
  gcal: 'agenda',
  mscal: 'agenda',
  meetings: 'agenda',
  inbox: 'agenda',
  kb: 'docs',
  attachments: 'docs',
  gdrive: 'docs',
  gsheets: 'docs',
  format: 'docs',
  // A report is a document Cortex writes, so it sits with the rest of what it
  // reads and writes rather than with the fleet — the person who asks for one
  // is asking for a document, whatever the numbers inside it are about.
  reports: 'docs',
  trackers: 'docs',
  views: 'docs',
  github: 'eng',
  linear: 'eng',
  payroll: 'money',
  // Con los vencimientos: el SG-SST es sobre todo plazos (FURAT, investigación,
  // actividades del plan) y la evidencia de que se cumplieron.
  sst: 'vehicles',
  goals: 'goals',
  management: 'goals',
  // Con Gerencia: el registro de trabajo es la otra mitad de «¿cómo va la
  // empresa?» — quién está cargado, qué se venció, qué se cerró a tiempo.
  work: 'goals',
  // Con Gerencia: el piloto es Cortex haciendo de gerente cada mañana.
  autopilot: 'goals',
  // Con metas y Gerencia: es la otra mitad de «¿cómo va la empresa?» — qué se
  // aconsejó y si sirvió.
  recommendations: 'goals',
  vehicles: 'vehicles',
  // La flota (0196) es la otra mitad de los vehículos: el mismo carro, visto
  // desde el taller, la bomba y la ruta en vez de desde el RUNT.
  fleet: 'vehicles',
  // Con los clientes: una orden de servicio es trabajo para un cliente que
  // sale de una cotización y termina en una factura.
  projects: 'clients',
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
  // Con la empresa: cómo está montada, qué áreas usa.
  modules: 'company',
  cortex: 'company',
  // Con Cortex mismo: es cómo se usa el producto, no un dato de la empresa.
  help: 'company',
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
    effect: 'Sin él no se puede ejecutar ningún trámite aprendido ni abrir una pestaña en vivo.',
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
    label: 'el motor de embeddings del cerebro',
    blocking: false,
    effect: 'Sin él la búsqueda solo empareja palabras, no significado.',
  },
};

/** Overrides for single tools whose family requirement does not apply to them. */
export const TOOL_CREDENTIALS: Record<string, CredentialRequirement | null> = {
  // La nómina que se liquida en Cortex (0194) vive en la base de la empresa:
  // no depende del servicio aparte de nómina que pide la familia `payroll`.
  'payroll.period_summary': null,
  'payroll.register_novelty': null,
  'payroll.approve_period': null,
  'payroll.payslip': null,
  'payroll.leave_request': null,
  'payroll.leave_status': null,
  'payroll.leave_decide': null,
  // El planeador de rutas (0196) calcula los km con Google si hay llave; sin
  // ella los km se escriben a mano, así que degrada, no bloquea.
  'fleet.log_trip': {
    vars: ['GOOGLE_MAPS_API_KEY'],
    label: 'el proveedor de rutas (Google Maps)',
    blocking: false,
    effect: 'Sin él, los km de un recorrido se escriben a mano.',
  },
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
  if (toolId in TOOL_CREDENTIALS) return TOOL_CREDENTIALS[toolId] ?? null;
  return FAMILY_CREDENTIALS[familyOf(toolId)] ?? null;
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
