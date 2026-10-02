/**
 * Lo que la página pública le dice a quien está pensando en comprar.
 *
 * REGLA DE ESTE ARCHIVO: cada frase tiene que poder señalarse en el producto.
 * Nada de clientes, testimonios, cifras de uso ni porcentajes de ahorro: no
 * existen, y una página que inventa uno pierde el derecho a que le crean lo
 * demás. Los números que aparecen en los ejemplos visuales están marcados en
 * pantalla como «Ejemplo ilustrativo» y usan empresas inventadas.
 *
 * De dónde sale cada bloque:
 *   - Procesos:       apps/web/lib/self-service/catalog.ts (PROCESS_TEMPLATES)
 *   - Contables:      docs/features/accounting-connectors.md
 *   - Bancos:         docs/features/bank-statements.md
 *   - Caja:           docs/features/cash-forecast.md
 *   - Piloto:         docs/features/autopilot.md
 *   - Equipo:         docs/features/team-work.md (sección Privacidad)
 *   - Acciones:       docs/features/safe-actions.md
 *   - Vistas:         docs/features/views.md
 *   - Planes:         infra/supabase/migrations/0086_per_seat_pricing.sql y
 *                     0116_plan_gerente.sql (tabla public.plans)
 *
 * TODO(prueba social): cuando haya clientes que acepten aparecer con nombre,
 * este es el sitio para sus citas. Hasta entonces, nada de testimonios.
 */

/**
 * A dónde lleva «Pide tu acceso». Hoy no hay un canal público (ni correo de
 * ventas ni formulario), así que la página no lo promete: el botón principal
 * lleva a /signup y dice en voz alta que se necesita un código de invitación.
 * Al poner aquí un `mailto:` o un enlace de WhatsApp, el héroe y el cierre
 * cambian solos a «Pide tu acceso» y /signup pasa a ser «Ya tengo código».
 */
export const ACCESS_REQUEST_HREF: string | null = null;

/**
 * LOS PRECIOS EXISTEN, PERO NO SE PUBLICAN TODAVÍA.
 *
 * Las tarifas están en `public.plans` (0086, 0116) y se copian abajo tal cual.
 * Se dejaron de mostrar en la página a propósito (ver la sección Pricing
 * comentada en Landing.tsx, commit b38c1bf): no hay pasarela de pago y una
 * tarifa anunciada obliga a sostenerla. Cambiar esta
 * constante a `true` publica precio y cupos por persona sin tocar nada más.
 */
export const SHOW_PRICES = false;

export type Plan = {
  name: string;
  forWhom: string;
  /** Lo que el plan es, en una línea. Sale del `tagline` de la base. */
  tagline: string;
  points: string[];
  /** Sólo se pinta con SHOW_PRICES. */
  price?: { amount: string; per: string };
  quota?: { answers: string; documents: string };
  featured?: boolean;
};

export const PLANS: Plan[] = [
  {
    name: 'Equipo',
    forWhom: 'Desde 5 personas',
    tagline: 'Un asistente por persona, para el equipo que ya trabaja adentro.',
    points: [
      'Todo Cortex para cada persona del equipo',
      'Cupo de respuestas y documentos por persona',
      'Los cupos se cuentan juntos para tu empresa',
    ],
    price: { amount: '$30.000', per: 'por persona al mes' },
    quota: { answers: '150', documents: '70' },
  },
  {
    name: 'Empresa',
    forWhom: 'Desde 25 personas',
    tagline: 'El mismo producto, más barato por persona, desde 25 personas.',
    points: [
      'El mismo producto que Equipo',
      'Menor precio por persona',
      'Más respuestas y documentos por persona',
    ],
    price: { amount: '$24.000', per: 'por persona al mes' },
    quota: { answers: '250', documents: '150' },
  },
  {
    name: 'Gerente',
    forWhom: 'Para la empresa que quiere delegar la operación',
    tagline: 'Un gerente operativo para tu empresa: propone, recuerda y rinde cuentas.',
    points: [
      'Implantación con nosotros',
      'WhatsApp y un acuerdo de servicio',
      'Sin tope de respuestas ni documentos',
    ],
    featured: true,
  },
];

export const PAINS = [
  {
    id: 'cartera',
    area: 'Plata que se pierde',
    title: 'Cobra a tiempo, sin perseguir a nadie.',
    body: 'Cortex mira la cartera todos los días, te dice a quién cobrar hoy, redacta el recordatorio y escala lo que pasa de 60 días. Cuando el abono llega al banco, lo ata a su factura.',
  },
  {
    id: 'pulso',
    area: 'No saber cómo va la empresa',
    title: 'Cómo vas, en una sola pantalla, cada mañana.',
    body: 'Ventas, cartera vencida, caja, metas y pendientes en una vista que se actualiza sola, con un resumen escrito a primera hora y una revisión cada lunes. ¿Varias empresas? Míralas juntas en el centro de mando.',
  },
  {
    id: 'caja',
    area: 'La caja',
    title: 'Sabe hoy si te alcanza en ocho semanas.',
    body: 'Proyección de caja a 13 semanas con la razón de cada línea: quién suele pagar tarde, qué se repite cada mes. Pregunta «¿y si Nexa paga 30 días tarde?» y ve qué semana se aprieta.',
  },
  {
    id: 'equipo',
    area: 'El equipo',
    title: 'Reparte la carga antes de que algo se venza.',
    body: 'Qué tiene abierto cada quien, qué venció y qué cerró. Cada persona ve «Mi semana»; quien reparte recibe una sugerencia concreta de a quién pasarle qué. Sin rankings ni vigilancia.',
  },
  {
    id: 'rutina',
    area: 'Tareas repetitivas',
    title: 'Lo rutinario se hace solo. Lo importante te espera.',
    body: 'El piloto automático arma el plan del día, hace lo que tiene permitido y te deja una lista corta con lo que necesita tu decisión. Nace apagado: tú decides, área por área, si sólo avisa, si propone o si lo hace.',
  },
  {
    id: 'vistas',
    area: 'Informes que nadie actualiza',
    title: 'Pide el tablero escribiendo. Compártelo con un enlace.',
    body: 'Tableros, formularios y portales sobre los datos de tu empresa, con tu logo y tus colores. Se cambian escribiendo y se comparten por enlace, con contraseña si quieres.',
  },
] as const;

export const STEPS = [
  {
    title: 'Conecta lo que ya usas',
    body: 'Tu programa contable, tu correo, una carpeta de Drive o el extracto del banco en Excel. La llave se prueba antes de guardarse; si no sirve, no se guarda.',
    note: 'Siigo, Alegra, QuickBooks, Gmail, Outlook, Drive',
  },
  {
    title: 'Elige un proceso',
    body: 'Activa uno listo —cartera que avisa sola, seguimiento de envíos, inventario con alertas, solicitudes del equipo— o descríbelo con tus palabras. Cortex pregunta lo justo.',
    note: 'Sin desarrolladores ni plantillas que llenar',
  },
  {
    title: 'Cortex trabaja solo',
    body: 'Cada mañana revisa, avisa y hace lo rutinario dentro de los permisos que le diste. Lo que necesita tu decisión llega a una lista de aprobaciones.',
    note: 'Tú decides qué hace solo y qué te consulta',
  },
] as const;

export const INTEGRATIONS = [
  { group: 'Contabilidad', items: ['Siigo Nube', 'Alegra', 'QuickBooks Online'] },
  {
    group: 'Correo, agenda y archivos',
    items: ['Gmail', 'Outlook', 'Google Drive', 'Google Sheets', 'Google Calendar'],
  },
  {
    group: 'Extractos bancarios',
    items: ['Bancolombia', 'Davivienda', 'BBVA', 'Banco de Bogotá'],
  },
  { group: 'Conversación', items: ['WhatsApp', 'Reuniones de Google Meet'] },
  { group: 'Y lo tuyo', items: ['Excel y CSV', 'Páginas web', 'La API de tu sistema'] },
] as const;

export const INDUSTRIES = [
  {
    name: 'Logística y carga',
    examples: [
      'Cada guía que llega a una carpeta de Drive queda en una tabla, con su número como clave.',
      'Seguimiento de envíos que consulta el estado afuera y avisa cuando cambia.',
      'Despachos por persona: quién está cargado y a quién pasarle qué.',
    ],
  },
  {
    name: 'Distribución y comercio',
    examples: [
      'Inventario que avisa al bajar del mínimo y prepara la orden de compra para aprobar.',
      'Abonos del extracto del banco atados a la factura que pagan.',
      'Clientes y oportunidades por etapa, alimentados desde el correo.',
    ],
  },
  {
    name: 'Servicios profesionales',
    examples: [
      'Respuestas sobre contratos que citan la cláusula exacta.',
      'Vencimientos leídos de tus documentos, con aviso antes y no después.',
      'Lo que se dijo en cada reunión, guardado para preguntarle después.',
    ],
  },
  {
    name: 'Construcción y obra',
    examples: [
      'Facturas de proveedores y órdenes de compra, de la carpeta a una tabla.',
      'Caja a 13 semanas con nómina y pagos que se repiten cada mes.',
      'Solicitudes de obra con formulario, responsable y recordatorio si se quedan quietas.',
    ],
  },
] as const;

export const TRUST = [
  {
    title: 'Nada sale sin tu permiso',
    body: 'Un borrador no es un envío. Lo que sale de la empresa pasa por aprobación, salvo lo que tú mismo le permitiste hacer solo. El piloto automático nunca mueve plata.',
  },
  {
    title: 'Permisos por persona',
    body: 'Cada quien ve los espacios que le corresponden. Las áreas sensibles son sólo para quien administra.',
  },
  {
    title: 'Todo queda registrado',
    body: 'Cada acción queda en el registro de auditoría: quién, qué, cuándo y con qué resultado.',
  },
  {
    title: 'Acciones verificadas, nunca dobles',
    body: 'Un reintento o un doble clic no manda el mismo correo dos veces. Lo importante se comprueba después: «Verificado: el correo está en Enviados».',
  },
  {
    title: 'Los datos de tu empresa, sólo de tu empresa',
    body: 'La información de cada empresa está separada. Una consulta no se vuelve memoria si tú no lo decides.',
  },
  {
    title: 'Equipo sin vigilancia',
    body: 'Se mide el trabajo, no a las personas: sin capturas de pantalla ni rankings. Cada persona puede ver lo que se mide de ella, en línea con el habeas data de la Ley 1581.',
  },
] as const;

export const FAQS = [
  {
    q: '¿Necesito un desarrollador para usar Cortex?',
    a: 'No. Los programas contables se conectan pegando una llave o dando un permiso, los procesos se activan con un clic o describiéndolos con tus palabras, y los tableros se piden escribiendo.',
  },
  {
    q: '¿Funciona con Siigo?',
    a: 'Sí. Siigo Nube, Alegra y QuickBooks Online se conectan directo: Cortex trae clientes, productos, facturas de venta y pagos recibidos, y las facturas con saldo llegan solas a la cartera.',
  },
  {
    q: '¿Mis datos están seguros?',
    a: 'Los datos de cada empresa están separados, cada persona ve sólo lo que le corresponde y cada acción queda registrada. Lo que sale de la empresa —un correo, un recordatorio— pasa por aprobación salvo que tú le hayas permitido hacerlo solo.',
  },
  {
    q: '¿Cortex puede equivocarse?',
    a: 'Sí, como cualquiera. Por eso cada respuesta muestra de dónde salió, lo dudoso se queda para que lo revises (un abono que podría ser de dos facturas no se ata solo) y lo importante pide tu aprobación antes de hacerse.',
  },
  {
    q: '¿Qué pasa si no tengo nada ordenado?',
    a: 'Es el punto de partida más común. Empieza con lo que tengas: el extracto del banco en Excel, una carpeta de facturas, tu correo. Cortex arma las tablas y te dice qué falta conectar.',
  },
  {
    q: '¿Cuánto tarda empezar?',
    a: 'Crear el espacio y conectar el programa contable es cuestión de minutos; la primera carga se trae sola. Un proceso se activa en una conversación corta y empieza a trabajar ese mismo día.',
  },
  {
    q: '¿Puedo hablar con Cortex por WhatsApp?',
    a: 'Sí. Conectas el número de la empresa, cada persona vincula el suyo y le escribe a Cortex desde el teléfono. También puedes guardar en el cerebro los grupos que elijas.',
  },
  {
    q: '¿Mi equipo se va a sentir vigilado?',
    a: 'No es la idea, y el producto está hecho para que no pase: no hay capturas de pantalla ni rankings, cada persona ve lo que se mide de ella y las sugerencias son para repartir trabajo, nunca para sancionar.',
  },
  {
    q: '¿Todo lo que comparto se guarda en el cerebro?',
    a: 'No. Puedes trabajar con un archivo sólo para una consulta. Guardar conocimiento duradero de la empresa es una decisión aparte.',
  },
  {
    q: '¿Cuánto cuesta?',
    a: 'Equipo y Empresa se cobran por persona al mes; Gerente se acuerda contigo, con implantación y acuerdo de servicio. Hoy el acceso es por invitación y sin tarjeta: todavía no cobramos dentro de Cortex, el plan se acuerda contigo y lo activamos.',
  },
] as const;
