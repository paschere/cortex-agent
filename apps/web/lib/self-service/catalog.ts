/**
 * LAS PUERTAS DE ENTRADA DEL AUTOSERVICIO.
 *
 * Dos catálogos que no son código de producto sino frases: de dónde pueden
 * venir los datos de una empresa y qué procesos se activan con ellos. Cada
 * opción termina en un lugar que ya existe — el chat con la petición escrita,
 * el Feed en el modo que toca, la conexión de Google —, así que agregar una
 * opción es agregar una entrada aquí, no una pantalla.
 *
 * Las peticiones van escritas como las diría una persona y son genéricas a
 * propósito: Cortex propone las columnas y pregunta antes de crear nada.
 */

export type SourceId = 'drive' | 'sheet' | 'email' | 'file' | 'describe' | 'api';

export type SourceOption = {
  id: SourceId;
  title: string;
  body: string;
  /** Si pide un enlace antes de seguir. */
  needsUrl?: { label: string; placeholder: string; pattern: RegExp };
  /** Si necesita la cuenta de Google conectada. */
  needsGoogle?: boolean;
  /** A dónde lleva: una petición para el chat o una ruta. */
  go: { prompt: (url: string) => string } | { href: string };
  cta: string;
};

export const SOURCES: SourceOption[] = [
  {
    id: 'drive',
    title: 'Una carpeta de Drive',
    body: 'Facturas, guías, contratos en PDF, Word o Excel. Cortex lee cada archivo nuevo y lo vuelve una fila.',
    needsUrl: {
      label: 'Pega el enlace de la carpeta',
      placeholder: 'https://drive.google.com/drive/folders/…',
      pattern: /^https:\/\/drive\.google\.com\/.+/,
    },
    needsGoogle: true,
    go: {
      prompt: (url) =>
        `Quiero que esta carpeta de Drive llene una tabla: ${url}\nMira qué archivos tiene, propónme las columnas y, cuando te confirme, déjala sincronizada para que cada archivo nuevo sea una fila.`,
    },
    cta: 'Leer la carpeta',
  },
  {
    id: 'sheet',
    title: 'Una hoja de cálculo',
    body: 'Google Sheets o un Excel publicado. La tabla se mantiene al día con lo que cambie en la hoja.',
    needsUrl: {
      label: 'Pega el enlace de la hoja',
      placeholder: 'https://docs.google.com/spreadsheets/…',
      pattern: /^https:\/\/.+/,
    },
    go: {
      prompt: (url) =>
        `Crea una tabla a partir de esta hoja de cálculo y mantenla sincronizada: ${url}\nDime qué columnas encontraste y cuál identifica cada fila antes de crearla.`,
    },
    cta: 'Leer la hoja',
  },
  {
    id: 'email',
    title: 'Tu correo',
    body: 'Gmail. Cortex encuentra facturas, pedidos y acuerdos en tus correos y te propone dónde guardarlos.',
    needsGoogle: true,
    go: {
      prompt: () =>
        'Revisa mis correos de los últimos 30 días y dime qué información de la empresa vale la pena ordenar en tablas (facturas, pedidos, acuerdos, clientes). Propónme la primera tabla con sus columnas.',
    },
    cta: 'Revisar mi correo',
  },
  {
    id: 'file',
    title: 'Tu programa contable',
    body: 'Siigo, Alegra o QuickBooks: conéctalo una vez y Cortex trae clientes, facturas y pagos solo. ¿Otro programa? Sube el archivo exportado.',
    go: { href: '/integrations#programas-contables' },
    cta: 'Conectar mi programa',
  },
  {
    id: 'describe',
    title: 'Cuéntaselo a Cortex',
    body: '¿No tienes nada ordenado? Describe cómo funciona tu negocio y Cortex arma las tablas que necesitas.',
    go: {
      prompt: () =>
        'Te cuento cómo funciona mi negocio para que me propongas las tablas que necesito y las armes cuando te confirme: ',
    },
    cta: 'Contarle',
  },
  {
    id: 'api',
    title: 'Otro sistema o una API',
    body: 'Pega la dirección de tu ERP o sistema interno; Cortex prueba la conexión y te muestra lo que trae.',
    go: { href: '/feed?mode=api' },
    cta: 'Conectar',
  },
];

export type ProcessTemplate = {
  id: string;
  area: 'Plata' | 'Ventas y clientes' | 'Operación' | 'Equipo';
  title: string;
  body: string;
  needs: string;
  prompt: string;
  featured?: boolean;
};

export const PROCESS_TEMPLATES: ProcessTemplate[] = [
  {
    id: 'receivables',
    area: 'Plata',
    title: 'Cartera que avisa sola',
    body: 'Te dice a quién cobrar hoy, redacta el recordatorio y escala lo que pasa de 60 días.',
    needs: 'Facturas (Drive, correo o archivo contable)',
    prompt:
      'Activa el seguimiento de cartera: avísame cuando una factura venza y otra vez a los 30, 60 y 90 días, y prepárame un recordatorio amable para cada cliente que yo apruebe antes de enviarlo. Si no tienes mis facturas todavía, dime cómo traerlas.',
    featured: true,
  },
  {
    id: 'shipments',
    area: 'Operación',
    title: 'Seguimiento de envíos',
    body: 'Lee guías o pedidos, consulta el estado afuera (vuelos, transportadora) y avisa cuando cambia.',
    needs: 'Carpeta u hoja con los envíos',
    prompt:
      'Quiero hacer seguimiento de mis envíos: arma una tabla con cada envío, consulta su estado en la fuente externa que corresponda y avísame cuando cambie. Pregúntame de dónde salen los envíos y qué servicio consultar.',
  },
  {
    id: 'pipeline',
    area: 'Ventas y clientes',
    title: 'Clientes y oportunidades',
    body: 'Un tablero por etapas que se alimenta del correo y te recuerda a quién no le has escrito.',
    needs: 'Tu correo',
    prompt:
      'Arma un tablero de oportunidades por etapas con lo que encuentres en mi correo, y avísame cuando lleve más de una semana sin escribirle a un cliente que está en negociación.',
  },
  {
    id: 'inventory',
    area: 'Operación',
    title: 'Inventario con alertas',
    body: 'Avisa cuando algo baja del mínimo y prepara la orden de compra para que la apruebes.',
    needs: 'Hoja de inventario',
    prompt:
      'Quiero alertas de inventario: toma mi hoja de inventario, avísame cuando un producto baje de su mínimo y prepárame la orden de compra para aprobarla. Pregúntame dónde está la hoja.',
  },
  {
    id: 'requests',
    area: 'Equipo',
    title: 'Solicitudes del equipo',
    body: 'Un formulario con enlace; cada pedido llega con responsable, fecha y recordatorio si se queda quieto.',
    needs: 'Nada, se crea vacío',
    prompt:
      'Crea una tabla de solicitudes del equipo (qué se pide, quién lo pide, responsable, fecha y estado) y una vista con un formulario que pueda compartir por enlace. Recuérdale al responsable si una solicitud lleva 3 días quieta.',
  },
  {
    id: 'morning',
    area: 'Equipo',
    title: 'Resumen de la mañana',
    body: 'Cada día hábil a primera hora: lo que vence, lo que se movió y lo que espera tu decisión.',
    needs: 'Nada',
    prompt:
      'Crea una rutina que cada día hábil a las 7 a. m. me mande un resumen corto: lo que vence hoy, lo que cambió ayer y lo que espera mi aprobación.',
  },
];

/** La URL de una opción: el chat con la petición, o la ruta que tenga. */
export function sourceHref(option: SourceOption, url = ''): string {
  if ('href' in option.go) return option.go.href;
  return `/chat?prompt=${encodeURIComponent(option.go.prompt(url.trim()).slice(0, 4000))}`;
}
