import { type NeedKey, type TaskTemplate, type TemplateField, fieldsFor } from './shape';

/**
 * LA GALERÍA DE SIEMPRE: doce tareas GENERALES que sirven en cualquier empresa
 * con las herramientas que Cortex ya tiene. Son texto. Cada una pide un plan
 * por adelantado y deja lo que mueve plata o escribe afuera detrás del visto
 * bueno de siempre.
 */

const CAUTION =
  'Empieza declarando tu plan. No envíes mensajes, no pagues ni cambies nada sin pedirme confirmación; lo que no puedas hacer, dímelo en vez de inventarlo.';

function t(
  id: string,
  title: string,
  summary: string,
  minutes: number,
  needs: NeedKey[],
  prompt: string,
  declared: TemplateField[] = [],
): TaskTemplate {
  const full = `${prompt}\n\n${CAUTION}`;
  return {
    id,
    source: 'builtin',
    title,
    summary,
    prompt: full,
    needs,
    minutes,
    fields: fieldsFor(full, declared),
  };
}

export const BUILTIN_TEMPLATES: readonly TaskTemplate[] = [
  t(
    'conciliar-banco',
    'Concilia el extracto del banco',
    'Cruza los movimientos del extracto con tus libros y te deja lo que no cuadra.',
    15,
    ['bank_file', 'accounting'],
    'Concilia el extracto bancario que te adjunté con la contabilidad del mes: cruza cada movimiento con sus facturas, pagos o cobros, separa lo conciliado de lo pendiente y de lo que no encuentras, y explica cada diferencia. Entrégame una tabla de partidas conciliadas, otra de partidas abiertas y un resumen con el saldo según el banco y según los libros. Si no encuentras el extracto adjunto, pídemelo.',
  ),
  t(
    'informe-socios',
    'Prepara el informe para socios del mes',
    'Ventas, gastos, caja y lo que sigue, en un informe listo para revisar.',
    10,
    ['accounting'],
    'Prepara el informe para socios del último mes cerrado: resultados frente al mes anterior, ventas y gastos principales, caja y cartera, hechos relevantes y los tres riesgos o decisiones que los socios deben mirar. Usa solo cifras reales de la contabilidad y de lo que ya sabes de la empresa, y cita de dónde sale cada cifra. Déjalo como borrador para que yo lo revise antes de enviarlo a nadie.',
  ),
  t(
    'cobrar-cartera',
    'Cobra la cartera vencida (con aprobación)',
    'Lista quién te debe, redacta cada recordatorio y espera tu visto bueno.',
    12,
    ['accounting', 'gmail'],
    'Revisa la cartera vencida: ordénala por monto y antigüedad, agrupa por cliente y propón para cada uno un recordatorio de cobro cordial y claro (con las facturas, montos y fechas exactas). Prepara los mensajes como borradores y deja cada envío pendiente de mi aprobación; no mandes nada por tu cuenta.',
  ),
  t(
    'resumen-correos',
    'Resume los correos importantes de la semana',
    'Lo que pide una respuesta, lo que es dinero y lo que puede esperar.',
    5,
    ['gmail'],
    'Revisa mi correo de los últimos 7 días y arma un resumen de lo importante: lo que está esperando una respuesta mía (con quién y desde cuándo), lo que tiene que ver con dinero, contratos o fechas límite, y lo que puede esperar. Para lo urgente propón una respuesta corta como borrador, sin enviarla.',
  ),
  t(
    'comparar-proveedores',
    'Compara proveedores de {{producto o servicio}}',
    'Busca opciones, compara precio, condiciones y reputación, y recomienda.',
    15,
    [],
    'Busca y compara proveedores de {{producto o servicio}} en Colombia: precio, condiciones de pago y entrega, garantías, reputación y qué dicen sus clientes. Presenta una tabla comparativa, marca la fuente de cada dato y cierra con una recomendación razonada y las preguntas que haría antes de decidir. Si ya tenemos proveedores o cotizaciones de esto en la empresa, inclúyelos primero.',
    [
      {
        key: 'producto o servicio',
        label: 'Qué se compra',
        placeholder: 'p. ej. papelería de oficina',
      },
    ],
  ),
  t(
    'documentos-vencen',
    'Revisa documentos que vencen este mes',
    'Contratos, pólizas, licencias y certificados que caducan pronto.',
    5,
    [],
    'Revisa los documentos de la empresa que vencen este mes y el siguiente (contratos, pólizas, licencias, certificados, permisos): lista cada uno con su fecha, quién es responsable y qué hay que hacer para renovarlo. Ordena por urgencia y propón los siguientes pasos de cada uno.',
  ),
  t(
    'presupuesto-proximo',
    'Arma el presupuesto del próximo mes desde lo real',
    'Parte de lo que de verdad ingresó y se gastó, no de supuestos.',
    10,
    ['accounting'],
    'Arma el presupuesto del próximo mes partiendo de lo real: ingresos y gastos de los últimos tres a seis meses, compromisos ya conocidos (cuotas, nómina, impuestos, pagos por vencer) y estacionalidad. Presenta una propuesta por rubro con su justificación, los supuestos que usaste y un escenario prudente y otro optimista. No cambies nada en la contabilidad; es una propuesta para que yo la ajuste.',
  ),
  t(
    'facturas-sin-causar',
    'Busca facturas sin causar en Siigo',
    'Compras y gastos que llegaron pero todavía no están contabilizados.',
    10,
    ['siigo'],
    'Busca en Siigo las facturas de compra y los gastos que ya llegaron (por correo o cargados) pero todavía no están causados. Lista cada una con proveedor, fecha, valor y por qué crees que falta, agrupadas por mes, y propón cómo causarlas. No causes ni modifiques nada sin mi aprobación.',
  ),
  t(
    'preparar-nomina',
    'Prepara la nómina del periodo',
    'Devengados, deducciones y novedades, listo para tu revisión.',
    15,
    ['accounting'],
    'Prepara la nómina del periodo actual: toma los empleados vigentes y sus novedades (ingresos, retiros, incapacidades, horas extras, bonos, préstamos), calcula devengados, deducciones y aportes, y señala cualquier dato faltante o raro. Entrégame el resumen por persona y el total del periodo como borrador; no liquides ni pagues nada sin mi aprobación.',
  ),
  t(
    'investigar-cliente',
    'Investiga a un cliente nuevo: {{cliente}}',
    'Quiénes son, a qué se dedican y qué conviene saber antes de la reunión.',
    10,
    [],
    'Investiga a {{cliente}} como cliente nuevo: a qué se dedican, tamaño y ubicación, noticias recientes, personas clave, riesgos o alertas públicas y qué podría necesitar de nosotros. Revisa también si ya tenemos historia con ellos (correos, cotizaciones, ventas). Resume en una página con las fuentes y sugiere tres preguntas para la primera conversación.',
    [
      {
        key: 'cliente',
        label: 'Nombre del cliente',
        placeholder: 'p. ej. Distribuciones Andina S.A.S.',
      },
    ],
  ),
  t(
    'ordenar-drive',
    'Ordena los archivos de Drive de {{carpeta}}',
    'Propone una estructura y mueve lo que apruebes; no borra nada.',
    15,
    ['drive'],
    'Revisa la carpeta de Drive «{{carpeta}}» y propón una estructura más ordenada: carpetas por tema o año, convenciones de nombres y qué archivos están repetidos o desactualizados. Muéstrame el plan completo de movimientos antes de hacer cualquiera; no borres nada, solo mueve o renombra lo que yo apruebe.',
    [{ key: 'carpeta', label: 'Carpeta o área', placeholder: 'p. ej. Contratos 2025' }],
  ),
  t(
    'crear-app',
    'Crea una app para {{proceso}}',
    'Una app a medida para tu equipo, con vista previa antes de crearla.',
    10,
    [],
    'Crea una app para {{proceso}}: pregúntame lo mínimo necesario, propón las pantallas, los campos y quién la usa, muéstrame la vista previa antes de crearla y, cuando yo apruebe, créala. Piensa en que se use desde el celular por personas sin experiencia técnica.',
    [
      {
        key: 'proceso',
        label: 'Para qué proceso',
        placeholder: 'p. ej. registrar visitas a clientes',
      },
    ],
  ),
];
