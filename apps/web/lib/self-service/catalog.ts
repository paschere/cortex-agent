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
  area: 'Plata' | 'Ventas y clientes' | 'Operación' | 'Equipo' | 'Impuestos';
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
  // Documentos que vencen (0184): lo que ya está en el Cerebro, leído con su
  // cita; nada se vigila hasta que alguien confirma la fecha.
  {
    id: 'document_expirations',
    area: 'Operación',
    title: 'Documentos que vencen',
    body: 'SOAT, tecnomecánica, pólizas, licencias, permisos y contratos: Cortex les lee la fecha, le avisa a quien los renueva con tiempo y cierra el aviso cuando llega el documento renovado.',
    needs: 'Los documentos en el Cerebro (subidos, de Drive o del correo)',
    prompt:
      'Quiero que me avises antes de que se venzan los documentos de la empresa: SOAT y tecnomecánica de los vehículos, pólizas, licencias, permisos, habilitaciones, certificados y contratos. Dime cuáles ya tengo vigilados y cuáles leíste de mis documentos y esperan que confirme la fecha, con la frase de donde salió cada una, y pregúntame quién responde por cada tipo. Si todavía no has revisado lo que ya está en el Cerebro, mándame a Documentos que vencen para buscarlo (lo hago por tandas); si falta algún papel, dime cómo subirlo o regístralo cuando te dé la fecha.',
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
    id: 'quote_to_invoice',
    area: 'Ventas y clientes',
    title: 'Cotizar y facturar',
    body: 'Cotizaciones con tu marca e IVA bien calculado; el cliente las acepta desde un enlace y la factura electrónica sale por Siigo o Alegra con tu aprobación.',
    needs: 'Siigo o Alegra conectado para la factura electrónica (la cotización no lo necesita)',
    prompt:
      'Quiero cotizar y facturar desde Cortex: hazme la primera cotización (te digo el cliente, qué le vendo, cantidades y precios antes de IVA), y cuando la apruebe mándasela al cliente por correo con el enlace para aceptarla. Cuando la acepte, avísame y prepárame la factura electrónica en mi programa contable para que yo la apruebe. Si no tengo Siigo o Alegra conectado, dime cómo conectarlo.',
  },
  {
    id: 'inventory',
    area: 'Operación',
    title: 'Inventario con alertas',
    body: 'Existencias por bodega con costo promedio; cada mañana te dice qué bajó del mínimo y deja las órdenes de compra por proveedor listas para aprobar y enviar.',
    needs: 'Programa contable (Siigo, Alegra o QuickBooks) o una hoja de inventario',
    prompt:
      'Quiero alertas de inventario: dime qué productos están bajo el mínimo y qué tengo que comprar (usa el inventario de Cortex en /inventario; si está vacío, dime si lo traigo del programa contable conectado o de mi hoja de inventario, y qué columnas necesita: código, nombre, existencias, mínimo, cantidad a pedir, costo, proveedor y días de entrega). Prepárame las órdenes de compra por proveedor para aprobarlas, y que el piloto automático me las deje listas cada mañana.',
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
    id: 'company_pulse',
    area: 'Plata',
    title: 'Pulso diario de la empresa',
    body: 'Una vista con ventas, cartera vencida, caja, metas y pendientes, y un resumen escrito cada mañana con esas cifras.',
    needs: 'Lo que ya tengas: programa contable, facturas, pagos o metas',
    prompt:
      'Dime cómo va la empresa en una vista y actualízala cada día: arma el pulso de la empresa con los datos que ya tengas (ventas contra el mes anterior, cartera vencida, lo que entró, lo recuperado, metas y pendientes), dime qué falta conectar, y programa que el resumen de hoy se escriba cada día hábil a las 7 a. m.',
  },
  {
    id: 'weekly_review',
    area: 'Plata',
    title: 'Revisión semanal',
    body: 'Cada lunes: qué mejoró y qué empeoró frente a la semana pasada, lo que hizo Cortex por ti y tres acciones para la semana.',
    needs: 'El pulso de la empresa (si no está, se arma solo)',
    prompt:
      'Hazme un resumen cada lunes de cómo nos fue: qué mejoró, qué empeoró frente a la semana anterior, lo que hiciste por la empresa y tres acciones para la semana. Si todavía no hay pulso de la empresa, ármalo primero y programa también su resumen diario, que es lo que guarda las cifras para comparar.',
  },
  {
    id: 'team_follow_up',
    area: 'Equipo',
    title: 'Seguimiento del equipo',
    body: 'Cada lunes, cómo le fue al trabajo del equipo; y un aviso cuando alguien se carga de más o se acumulan vencidos.',
    needs: 'El trabajo del equipo conectado (Gerencia, compromisos o una tabla con responsable)',
    prompt:
      'Quiero hacerle seguimiento al trabajo de mi equipo: programa un resumen cada lunes a las 7 a. m. con cómo nos fue la semana anterior (lo cerrado, lo vencido, lo que mejoró, lo que pide atención y lo que no tiene responsable), sin rankings ni notas por persona. Y avísame cuando alguien tenga mucha más carga que el resto, se le acumulen vencidos o se acumule trabajo sin responsable, con la sugerencia de a quién pasarle qué. Si el trabajo del equipo todavía no está conectado, dime qué tablas sirven y cómo conectarlas antes de cambiar nada.',
  },
  // Impuestos (0180). Los cuatro de la DIAN pasan por un trámite del
  // navegador que la persona enseña una vez: Cortex nunca escribe la clave, el
  // CAPTCHA, el código del celular ni la firma, y lo que escribe en el portal
  // pide aprobación cada vez (`browser.submit_flow`).
  {
    id: 'tax_calendar',
    area: 'Impuestos',
    title: 'Calendario de impuestos que avisa solo',
    body: 'Con el NIT y el RUT, Cortex arma las fechas del año (renta, IVA, retención, exógena, ICA, PILA) y le avisa al contador antes de cada una.',
    needs: 'El NIT y el RUT (si está en el Cerebro, lo leo)',
    prompt:
      'Arma el calendario tributario de la empresa: lee el RUT si está en el Cerebro (si no, pregúntame el NIT y las casillas que necesitas: tipo de persona, gran contribuyente, Régimen Simple, IVA bimestral o cuatrimestral, agente de retención, ciudad del ICA, exógena, nómina electrónica y PILA), pregúntame quién es el contador y con cuántos días de anticipación avisarle, y propónme el perfil para que lo confirme.',
  },
  {
    id: 'dian_invoices',
    area: 'Impuestos',
    title: 'Descargar facturas recibidas de la DIAN cada semana',
    body: 'Cada lunes trae del portal de la DIAN las facturas electrónicas que te emitieron y las deja en el Cerebro, listas para cuadrar con el IVA.',
    needs: 'Acceso al portal de la DIAN; enseñar el trámite una vez',
    prompt:
      'Quiero que cada lunes descargues del portal de la DIAN las facturas electrónicas recibidas de la semana anterior y las guardes en el Cerebro. La primera vez, enséñame el trámite en el navegador de Cortex (Trámites web) con el perfil de la empresa y apruébalo; el inicio de sesión, el CAPTCHA, el código que llega al celular y la firma electrónica los haces tú en la pestaña en vivo, yo nunca los escribo. Después programa la rutina semanal y avísame qué facturas nuevas llegaron.',
  },
  {
    id: 'dian_mailbox',
    area: 'Impuestos',
    title: 'Revisar el buzón de la DIAN',
    body: 'Mira el buzón de notificaciones de la DIAN y te avisa si llegó un requerimiento, un emplazamiento o algo con plazo.',
    needs: 'Acceso al portal de la DIAN; enseñar el trámite una vez',
    prompt:
      'Revisa cada semana el buzón de notificaciones de la DIAN de la empresa y avísame si hay algo nuevo, con su plazo si lo tiene; si trae una fecha, propónmela como vencimiento. La primera vez, enséñame el trámite en el navegador de Cortex (Trámites web) con el perfil de la empresa y apruébalo; el inicio de sesión, el CAPTCHA, el código que llega al celular y la firma electrónica los haces tú en la pestaña en vivo, yo nunca los escribo. Sólo lees: no respondas nada en el portal sin que yo lo apruebe.',
  },
  {
    id: 'dian_rut',
    area: 'Impuestos',
    title: 'Sacar el RUT actualizado',
    body: 'Descarga la copia del RUT del portal de la DIAN, la guarda en el Cerebro y revisa si el perfil tributario sigue cuadrando.',
    needs: 'Acceso al portal de la DIAN; enseñar el trámite una vez',
    prompt:
      'Descarga del portal de la DIAN la copia actualizada del RUT de la empresa y guárdala en el Cerebro. La primera vez, enséñame el trámite en el navegador de Cortex (Trámites web) con el perfil de la empresa y apruébalo; el inicio de sesión, el CAPTCHA, el código que llega al celular y la firma electrónica los haces tú en la pestaña en vivo, yo nunca los escribo. Luego léelo y dime si el perfil tributario de Impuestos sigue cuadrando (responsabilidades, régimen, actividad); si algo cambió, propónme el cambio.',
  },
  {
    id: 'dian_account',
    area: 'Impuestos',
    title: 'Consultar el estado de cuenta en la DIAN',
    body: 'Cada mes consulta las obligaciones pendientes y saldos a favor en la DIAN y te dice si algo no cuadra con lo marcado como pagado.',
    needs: 'Acceso al portal de la DIAN; enseñar el trámite una vez',
    prompt:
      'Cada mes consulta el estado de cuenta de la empresa en el portal de la DIAN y compáralo con lo que está marcado como pagado en Impuestos; avísame si aparece una deuda, un saldo a favor o algo que no cuadre. La primera vez, enséñame el trámite en el navegador de Cortex (Trámites web) con el perfil de la empresa y apruébalo; el inicio de sesión, el CAPTCHA, el código que llega al celular y la firma electrónica los haces tú en la pestaña en vivo, yo nunca los escribo. Sólo consultas: nada de pagos ni solicitudes en el portal.',
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
