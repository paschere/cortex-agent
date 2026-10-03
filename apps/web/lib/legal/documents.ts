import { SIGNUP_CODE_COOKIE } from '@/lib/signup-code';
import { WORKSPACE_NAME_COOKIE } from '@/lib/workspace-cookie';
import type { LegalEntity } from './config';
import { LEGAL_DOCUMENT_VERSIONS, SIGNUP_CONSENT_COOKIE } from './versions';

/**
 * LOS TEXTOS LEGALES, ESCRITOS DESDE LO QUE EL CÓDIGO HACE DE VERDAD.
 *
 * ADVERTENCIA: BORRADOR TÉCNICO, NO ASESORÍA JURÍDICA. Estos textos los redactó
 * el equipo técnico a partir de los flujos de datos reales del repositorio (qué
 * se guarda, a qué proveedor va, cuánto se conserva). Un abogado colombiano
 * tiene que revisarlos antes de apagar LEGAL_DRAFT. Cada afirmación factual
 * tiene su fuente en el código; si el código cambia (un proveedor nuevo, un
 * plazo distinto), este archivo tiene que cambiar con él, y si el cambio es de
 * fondo, subir la versión en versions.ts.
 *
 * Los datos del responsable (razón social, NIT, dirección…) NO están aquí:
 * vienen de LEGAL_* (config.ts) y, si faltan, se ven como [MARCADOR].
 *
 * Formato mínimo a propósito: párrafos, listas, tablas y notas. Se pinta en
 * components/legal/LegalDocument.tsx.
 */

export type Block =
  | string
  | { list: string[] }
  | { table: { head: string[]; rows: string[][] } }
  | { note: string };

export interface Section {
  id: string;
  heading: string;
  blocks: Block[];
}

export interface LegalDocumentContent {
  slug: 'privacidad' | 'terminos' | 'cookies' | 'tratamiento-de-datos';
  title: string;
  version: string;
  summary: string;
  sections: Section[];
}

/** Quién es el responsable, en una línea. */
function who(e: LegalEntity): string {
  return `${e.razonSocial}, identificada con NIT ${e.nit}, con domicilio en ${e.direccion}, ${e.ciudad}, Colombia (en adelante, «Cortex» o «nosotros»)`;
}

function contact(e: LegalEntity): string {
  return `correo ${e.correo}, teléfono ${e.telefono}, o por escrito a ${e.direccion}, ${e.ciudad}`;
}

// ---------------------------------------------------------------------------
// Encargados y proveedores: la tabla que comparten privacidad y tratamiento
// ---------------------------------------------------------------------------
export function processorsTable(e: LegalEntity): { head: string[]; rows: string[][] } {
  return {
    head: ['Proveedor', 'Para qué', 'Qué datos recibe', 'Dónde'],
    rows: [
      [
        'Vercel Inc.',
        'Alojamiento de la aplicación web',
        'Todo lo que pasa por la aplicación mientras se usa',
        'Estados Unidos y red global',
      ],
      [
        'Railway Corp.',
        'Base de datos, archivos, cola de trabajos, copias de seguridad, puente de WhatsApp, navegador automatizado y asistente de reuniones',
        'Toda la información guardada en Cortex',
        e.regionAlojamiento,
      ],
      [
        'Anthropic, PBC',
        'Modelo de lenguaje que redacta las respuestas y ejecuta las tareas',
        'Las preguntas y el contexto necesario para responderlas (fragmentos de documentos, correos, mensajes y cifras pertinentes)',
        'Estados Unidos',
      ],
      [
        'Voyage AI',
        'Índice de búsqueda semántica (vectores) y reordenamiento de resultados',
        'Fragmentos de texto de documentos y correos que se indexan, y las consultas',
        'Estados Unidos',
      ],
      [
        'OpenAI, L.L.C.',
        'Conversación por voz en tiempo real y voces personalizadas (si se activan)',
        'El audio de la conversación de voz; para una voz personalizada, las grabaciones de voz de quien la crea',
        'Estados Unidos',
      ],
      [
        'Deepgram, Inc.',
        'Transcripción de audio (reuniones y archivos de audio)',
        'El audio que se transcribe',
        'Estados Unidos',
      ],
      [
        'Google LLC',
        'Inicio de sesión con Google y, si se conectan, Gmail, Calendar, Drive, Sheets, Contactos, Meet y Google Chat',
        'Lo que la persona autoriza al conectar su cuenta',
        'Estados Unidos y otros',
      ],
      [
        'Microsoft Corporation',
        'Correo y calendario de Outlook / Microsoft 365, si se conectan',
        'Lo que la persona autoriza al conectar su cuenta',
        'Estados Unidos y otros',
      ],
      [
        'Resend',
        'Correos de la plataforma (verificación, invitaciones, avisos)',
        'Dirección de correo y contenido del aviso',
        'Estados Unidos',
      ],
      [
        'Functional Software, Inc. (Sentry)',
        'Detección de errores técnicos',
        'Datos técnicos del error (navegador, dirección IP, ruta), sin grabación de pantalla',
        'Estados Unidos',
      ],
      [
        'Tavily, Firecrawl, Jina AI',
        'Búsqueda y lectura de páginas web públicas cuando se le pide a Cortex',
        'El texto de la búsqueda y la dirección de la página',
        'Estados Unidos y otros',
      ],
      [
        'Inngest, Inc.',
        'Cola de trabajos de respaldo (en retiro)',
        'Identificadores de las tareas programadas',
        'Estados Unidos',
      ],
    ],
  };
}

const CLIENT_CONNECTED = [
  'WhatsApp, mediante la vinculación de un teléfono como dispositivo (protocolo de WhatsApp Web).',
  'Programas contables: Siigo, Alegra y QuickBooks.',
  'HubSpot, Linear, Slack, GitHub y el sistema de nómina que la empresa conecte.',
  'Servidores MCP de terceros que la empresa agregue.',
];

// ---------------------------------------------------------------------------
// Política de tratamiento de datos personales (Ley 1581 / Decreto 1377 art. 13)
// ---------------------------------------------------------------------------
export function dataPolicy(e: LegalEntity): LegalDocumentContent {
  return {
    slug: 'tratamiento-de-datos',
    title: 'Política de tratamiento de datos personales',
    version: LEGAL_DOCUMENT_VERSIONS.tratamiento,
    summary:
      'Quién trata tus datos, para qué, qué derechos tienes y cómo ejercerlos. Esta política cumple la Ley 1581 de 2012 y el Decreto 1377 de 2013 (compilado en el Decreto 1074 de 2015).',
    sections: [
      {
        id: 'responsable',
        heading: '1. Responsable del tratamiento',
        blocks: [
          `El responsable del tratamiento de los datos personales descritos en esta política es ${who(e)}.`,
          `Canal de atención de consultas y reclamos: ${contact(e)}. También puedes radicarlos desde la aplicación, en Ajustes › Privacidad y datos.`,
        ],
      },
      {
        id: 'roles',
        heading: '2. Cuándo somos responsables y cuándo encargados',
        blocks: [
          'Cortex es una herramienta que usan empresas. Por eso tratamos dos clases de información, con papeles distintos:',
          {
            list: [
              'Los datos de las personas que usan Cortex (nombre, correo, credenciales de acceso, uso de la plataforma). Sobre ellos somos RESPONSABLES y esta política aplica directamente.',
              'La información que cada empresa cliente carga o conecta (sus documentos, correos, calendarios, mensajes de WhatsApp, clientes, proveedores, extractos bancarios, facturas, nómina, grabaciones de reuniones). Sobre ella, la empresa cliente es la RESPONSABLE y Cortex actúa como ENCARGADO: la tratamos sólo por cuenta de la empresa, según sus instrucciones y para prestarle el servicio.',
            ],
          },
          'Si eres cliente, proveedor, empleado o contacto de una empresa que usa Cortex y quieres ejercer tus derechos sobre la información que esa empresa tiene de ti, dirígete primero a esa empresa. Si nos escribes a nosotros, trasladaremos tu solicitud a la empresa responsable y te informaremos.',
        ],
      },
      {
        id: 'datos',
        heading: '3. Qué datos tratamos',
        blocks: [
          {
            list: [
              'Identificación y contacto: nombre, correo electrónico, empresa, cargo o papel en el espacio de trabajo.',
              'Acceso y seguridad: contraseña (guardada sólo como huella criptográfica), secretos de verificación en dos pasos, sesiones activas, registros de acceso y de las acciones hechas en la plataforma.',
              'Información de las fuentes que se conecten: correos, eventos de calendario, archivos de Drive, contactos, mensajes y grupos de WhatsApp, documentos cargados, grabaciones y transcripciones de reuniones.',
              'Información financiera y comercial de la empresa: extractos bancarios, facturas, cuentas por cobrar y por pagar, inventario, ventas, información contable y de nómina.',
              'Conversaciones con el asistente y lo que Cortex aprende de ellas (memorias, preferencias), que la persona puede revisar y borrar.',
              'Datos técnicos: dirección IP, navegador, dispositivo y errores técnicos.',
            ],
          },
        ],
      },
      {
        id: 'sensibles',
        heading: '4. Datos sensibles y de menores',
        blocks: [
          'La VOZ que se usa para crear una voz personalizada es un dato biométrico y, por tanto, sensible (art. 5 de la Ley 1581). Sólo se trata si la persona lo autoriza expresamente al crearla, con una frase de consentimiento grabada, y la autorización es facultativa: nadie está obligado a darla y no darla no impide usar Cortex.',
          'La información que una empresa cargue puede contener datos sensibles de terceros (por ejemplo, de salud en una incapacidad o de afiliación sindical en una nómina). La empresa cliente es responsable de contar con la autorización correspondiente; Cortex los trata sólo como encargado.',
          'Cortex no está dirigido a menores de edad y no recolectamos a sabiendas datos de niños, niñas o adolescentes.',
        ],
      },
      {
        id: 'finalidades',
        heading: '5. Finalidades',
        blocks: [
          {
            list: [
              'Crear y administrar la cuenta, autenticar a la persona y proteger el acceso.',
              'Prestar el servicio contratado: responder preguntas, buscar en la información de la empresa, redactar, programar tareas, vigilar vencimientos, preparar informes y ejecutar las acciones que una persona apruebe.',
              'Conectar y sincronizar las fuentes que la empresa autorice.',
              'Enviar avisos del servicio (verificación, invitaciones, alertas, resúmenes).',
              'Facturar y gestionar el plan contratado.',
              'Atender soporte, consultas y reclamos.',
              'Mantener la seguridad, prevenir fraude y abuso, diagnosticar errores y mejorar la calidad de las respuestas del servicio.',
              'Cumplir obligaciones legales y atender requerimientos de autoridades competentes.',
            ],
          },
          'No vendemos datos personales. No usamos la información de una empresa para atender a otra. Hasta donde lo permiten los contratos con los proveedores de modelos de lenguaje, la información enviada a ellos no se usa para entrenar sus modelos. [REVISAR CON EL ABOGADO: confirmar las condiciones de cada proveedor.]',
        ],
      },
      {
        id: 'derechos',
        heading: '6. Tus derechos como titular',
        blocks: [
          'Según el artículo 8 de la Ley 1581 de 2012 tienes derecho a:',
          {
            list: [
              'Conocer, actualizar y rectificar tus datos personales.',
              'Solicitar prueba de la autorización que nos diste.',
              'Ser informado, previa solicitud, del uso que les hemos dado.',
              'Presentar quejas ante la Superintendencia de Industria y Comercio (SIC) por infracciones, una vez agotado el trámite de consulta o reclamo ante nosotros.',
              'Revocar la autorización y/o solicitar la supresión de tus datos cuando no se respeten los principios, derechos y garantías constitucionales y legales. La supresión no procede cuando exista un deber legal o contractual de conservarlos.',
              'Acceder en forma gratuita a tus datos personales.',
            ],
          },
          'Desde Ajustes › Privacidad y datos puedes, sin escribirle a nadie: descargar tus datos, descargar todos los datos de la empresa (si eres dueño o administrador), eliminar tu usuario, eliminar la cuenta de la empresa (si eres el dueño) y revocar tu autorización.',
        ],
      },
      {
        id: 'procedimiento',
        heading: '7. Procedimiento para consultas y reclamos',
        blocks: [
          `Puedes presentar consultas y reclamos desde la aplicación (Ajustes › Privacidad y datos) o por ${contact(e)}. Pueden hacerlo el titular, sus causahabientes, su representante o apoderado.`,
          'CONSULTAS (art. 14): se responden en un término máximo de diez (10) días hábiles contados a partir del día siguiente a su recibo. Si no es posible, te informaremos antes del vencimiento los motivos y la fecha en que se atenderá, que no superará cinco (5) días hábiles adicionales.',
          'RECLAMOS (art. 15) — para corregir, actualizar o suprimir datos, o por un posible incumplimiento: deben incluir tu identificación, la descripción de los hechos, la dirección de respuesta y los documentos que quieras hacer valer. Si el reclamo está incompleto, te pediremos dentro de los cinco (5) días siguientes que lo completes; si pasan dos (2) meses sin que lo hagas, se entenderá que desististe. Una vez completo, incluiremos en la base la leyenda «reclamo en trámite» y lo atenderemos en máximo quince (15) días hábiles contados a partir del día siguiente a su recibo; si no es posible, te informaremos los motivos y la nueva fecha, que no superará ocho (8) días hábiles adicionales.',
          'Los plazos se cuentan en días hábiles de Colombia (sin sábados, domingos ni festivos). La aplicación calcula y te muestra la fecha límite de cada solicitud al radicarla.',
        ],
      },
      {
        id: 'transferencias',
        heading: '8. Transmisiones y transferencias internacionales',
        blocks: [
          `Para prestar el servicio usamos proveedores que tratan datos por nuestra cuenta (encargados), varios de ellos fuera de Colombia, principalmente en Estados Unidos. Los servidores donde se guarda la información están en: ${e.regionAlojamiento}. Con la aceptación de esta política autorizas expresamente esa transmisión internacional.`,
          { table: processorsTable(e) },
          'Además, cuando la empresa decide conectar otros servicios, la información fluye hacia ellos o desde ellos por instrucción de la empresa, bajo los términos de cada uno:',
          { list: CLIENT_CONNECTED },
          {
            note: '[REVISAR CON EL ABOGADO] Verificar para cada proveedor: contrato de transmisión de datos (Decreto 1377 art. 25) o cláusulas equivalentes, nivel adecuado de protección del país de destino según la Superintendencia de Industria y Comercio, y si alguna de estas operaciones es una transferencia (a otro responsable) que requiera declaración de conformidad.',
          },
        ],
      },
      {
        id: 'seguridad',
        heading: '9. Seguridad',
        blocks: [
          {
            list: [
              'Toda la comunicación viaja cifrada (HTTPS/TLS).',
              'Las credenciales de las conexiones (tokens de Google, Microsoft y otros) se guardan cifradas con AES-256-GCM.',
              'Las contraseñas se guardan como huella criptográfica, nunca en claro. Se ofrece verificación en dos pasos.',
              'La información de cada empresa está aislada: cada consulta a la base de datos se filtra por la empresa, y el sistema rechaza consultas a tablas que no tengan esa regla declarada.',
              'Copias de seguridad diarias de la base de datos.',
              'Registro de las acciones que Cortex ejecuta y de quién las aprobó.',
            ],
          },
          'Ningún sistema es invulnerable. Si ocurre un incidente que comprometa datos personales, lo informaremos a la Superintendencia de Industria y Comercio y a las personas afectadas conforme a la ley.',
        ],
      },
      {
        id: 'conservacion',
        heading: '10. Conservación',
        blocks: [
          'Conservamos los datos mientras la cuenta o la empresa estén activas y sea necesario para las finalidades descritas. Algunos plazos concretos:',
          {
            list: [
              'Archivos adjuntados en el chat: 7 días.',
              'Contexto técnico de cada respuesta del asistente: el texto citado se borra a los 14 días y el registro a los 90.',
              'Señales de aprendizaje del servicio: 180 días.',
              'Exportaciones de datos descargables: 7 días.',
              'Eliminación de la cuenta de una empresa: 30 días de gracia (se puede cancelar) y luego borrado definitivo.',
              'Copias de seguridad: se conservan las últimas 14 diarias, así que un dato borrado puede persistir hasta 14 días en ellas antes de desaparecer.',
              'Constancia de autorizaciones, consultas, reclamos y borrados: el tiempo necesario para probar el cumplimiento de la ley. [REVISAR CON EL ABOGADO: plazo exacto.]',
            ],
          },
        ],
      },
      {
        id: 'vigencia',
        heading: '11. Vigencia',
        blocks: [
          `Esta política rige desde el ${e.fechaVigencia} (versión ${LEGAL_DOCUMENT_VERSIONS.tratamiento}). Las bases de datos estarán vigentes mientras se preste el servicio y durante el término necesario para cumplir las finalidades y las obligaciones legales. Cuando la cambiemos de forma sustancial te lo informaremos y, si el cambio requiere una nueva autorización, te la pediremos dentro de la aplicación antes de seguir.`,
          {
            note: '[REVISAR CON EL ABOGADO] Inscripción de las bases de datos en el Registro Nacional de Bases de Datos (RNBD) de la SIC, si aplica según los activos de la sociedad.',
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Política de privacidad (aviso de privacidad, Decreto 1377 arts. 14-15)
// ---------------------------------------------------------------------------
export function privacyPolicy(e: LegalEntity): LegalDocumentContent {
  return {
    slug: 'privacidad',
    title: 'Política de privacidad',
    version: LEGAL_DOCUMENT_VERSIONS.privacidad,
    summary:
      'En pocas palabras: qué guardamos, por qué, con quién lo compartimos y qué puedes hacer tú. El detalle legal está en la Política de tratamiento de datos personales.',
    sections: [
      {
        id: 'resumen',
        heading: 'Lo esencial',
        blocks: [
          {
            list: [
              'La información de tu empresa es de tu empresa. La usamos para prestarle el servicio y para nada más.',
              'No vendemos datos. No usamos la información de una empresa para atender a otra.',
              'Cortex no envía, paga ni publica nada importante sin la aprobación de una persona, salvo lo que la empresa haya autorizado expresamente que haga solo.',
              'Puedes descargar o borrar tus datos tú mismo, desde Ajustes › Privacidad y datos.',
            ],
          },
          `Responsable: ${who(e)}. Contacto: ${contact(e)}.`,
        ],
      },
      {
        id: 'que',
        heading: 'Qué recogemos',
        blocks: [
          {
            list: [
              'Tu cuenta: nombre, correo, contraseña (como huella cifrada) y, si la activas, la verificación en dos pasos.',
              'Lo que conectes: si conectas Google o Microsoft, Cortex lee el correo, el calendario, los archivos y los contactos que autorices; si vinculas WhatsApp, los mensajes de los chats y grupos de ese número; si conectas un programa contable o un CRM, sus registros.',
              'Lo que cargues: documentos, extractos bancarios, facturas, audios y grabaciones de reuniones.',
              'Lo que conversas con Cortex y lo que aprende de ello (memorias y preferencias, que puedes ver y borrar en Ajustes).',
              'Datos técnicos mínimos para que funcione y sea seguro: IP, navegador, errores.',
            ],
          },
        ],
      },
      {
        id: 'para-que',
        heading: 'Para qué',
        blocks: [
          'Para responder tus preguntas con la información de tu empresa, preparar borradores, vigilar fechas y pendientes, y ejecutar las tareas que apruebes; para avisarte de lo importante; para mantener la plataforma segura; y para cobrar el plan. Las finalidades completas están en la Política de tratamiento.',
        ],
      },
      {
        id: 'ia',
        heading: 'Inteligencia artificial',
        blocks: [
          'Para responder, Cortex envía a un modelo de lenguaje (Anthropic) la pregunta y sólo los fragmentos de información necesarios para contestarla. Para buscar entre tus documentos, los fragmentos se convierten en vectores numéricos con Voyage AI. El audio se transcribe con Deepgram, y la voz en tiempo real usa OpenAI.',
          'Las respuestas de un modelo de lenguaje pueden contener errores. Por eso Cortex cita de dónde saca cada dato y pide aprobación antes de actuar.',
        ],
      },
      {
        id: 'con-quien',
        heading: 'Con quién la compartimos',
        blocks: [
          'Sólo con los proveedores que necesitamos para prestar el servicio, que la tratan por nuestra cuenta y bajo contrato:',
          { table: processorsTable(e) },
          'Y con los servicios que tu empresa decida conectar, por instrucción suya. También podemos entregar información a una autoridad que la pida conforme a la ley.',
        ],
      },
      {
        id: 'whatsapp',
        heading: 'Sobre WhatsApp',
        blocks: [
          'La conexión con WhatsApp funciona vinculando un teléfono como dispositivo, igual que WhatsApp Web; no usa la API oficial de WhatsApp Business. Quien vincula un número es responsable de informar a sus contactos y de usarlo conforme a las condiciones de WhatsApp.',
          {
            note: '[REVISAR CON EL ABOGADO] Riesgo contractual frente a los términos de servicio de WhatsApp/Meta y deber de información a los contactos cuyas conversaciones se procesan.',
          },
        ],
      },
      {
        id: 'derechos',
        heading: 'Lo que puedes hacer',
        blocks: [
          {
            list: [
              'Descargar tus datos, o todos los de la empresa si eres dueño o administrador.',
              'Eliminar tu usuario: se revocan tus conexiones, se borran tus memorias y preferencias y tu nombre deja de aparecer; lo que creaste dentro de la empresa sigue siendo de la empresa.',
              'Eliminar la cuenta de la empresa (el dueño), con 30 días para arrepentirse.',
              'Revocar tu autorización, hacer una consulta o presentar un reclamo, con la fecha límite legal a la vista.',
            ],
          },
          `Todo eso está en Ajustes › Privacidad y datos. Si no puedes entrar a la aplicación, escríbenos a ${e.correo}. Y si no quedas satisfecho, puedes acudir a la Superintendencia de Industria y Comercio (www.sic.gov.co).`,
        ],
      },
      {
        id: 'cookies',
        heading: 'Cookies',
        blocks: [
          'Sólo usamos cookies necesarias para que inicies sesión y la aplicación funcione. No usamos cookies de analítica ni de publicidad. El detalle está en el Aviso de cookies.',
        ],
      },
      {
        id: 'cambios',
        heading: 'Cambios',
        blocks: [
          `Versión ${LEGAL_DOCUMENT_VERSIONS.privacidad}, vigente desde el ${e.fechaVigencia}. Si cambiamos algo importante, te lo diremos dentro de la aplicación.`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Términos y condiciones
// ---------------------------------------------------------------------------
export function termsOfService(e: LegalEntity): LegalDocumentContent {
  return {
    slug: 'terminos',
    title: 'Términos y condiciones',
    version: LEGAL_DOCUMENT_VERSIONS.terminos,
    summary:
      'Las reglas de uso de Cortex: qué ofrecemos, qué esperamos de quien lo usa y qué pasa con la información al terminar.',
    sections: [
      {
        id: 'partes',
        heading: '1. Partes y aceptación',
        blocks: [
          `Estos términos regulan el uso de Cortex, plataforma prestada por ${who(e)}. Al crear una cuenta o usar la plataforma los aceptas. Si los aceptas en nombre de una empresa, declaras que tienes facultades para obligarla.`,
        ],
      },
      {
        id: 'servicio',
        heading: '2. El servicio',
        blocks: [
          'Cortex es un asistente de gestión para empresas: se conecta a las fuentes de información que la empresa autoriza, responde preguntas citando de dónde saca cada dato, prepara borradores y ejecuta tareas con la aprobación de una persona o dentro de los límites que la empresa configure.',
          'Podemos cambiar, mejorar o retirar funciones. Si retiramos algo esencial de un plan pagado, te avisaremos con antelación razonable.',
        ],
      },
      {
        id: 'cuentas',
        heading: '3. Cuentas y espacios de trabajo',
        blocks: [
          {
            list: [
              'Cada persona usa su propia cuenta y es responsable de mantener segura su contraseña. Recomendamos activar la verificación en dos pasos.',
              'El dueño del espacio de una empresa decide quién entra, con qué papel y qué fuentes se conectan.',
              'Debes ser mayor de edad y tener capacidad legal para contratar.',
            ],
          },
        ],
      },
      {
        id: 'datos-cliente',
        heading: '4. La información de la empresa',
        blocks: [
          'La información que la empresa carga o conecta es suya. Nos da una licencia limitada para tratarla con el único fin de prestarle el servicio. Respecto de los datos personales contenidos en ella, la empresa es la responsable y Cortex el encargado del tratamiento, conforme a la Política de tratamiento de datos personales.',
          'La empresa declara que tiene las autorizaciones necesarias de sus clientes, empleados, proveedores y contactos para que su información sea tratada en Cortex, incluidos los datos sensibles que llegue a cargar, y que les ha informado de ese tratamiento.',
        ],
      },
      {
        id: 'uso',
        heading: '5. Uso aceptable',
        blocks: [
          'No está permitido usar Cortex para:',
          {
            list: [
              'Actividades ilegales, fraude, suplantación o lavado de activos.',
              'Enviar mensajes masivos no solicitados (spam) por correo o WhatsApp.',
              'Tratar datos de personas sin la autorización que exige la ley.',
              'Intentar acceder a información de otras empresas, vulnerar la seguridad de la plataforma o sobrecargarla deliberadamente.',
              'Infringir derechos de propiedad intelectual de terceros.',
            ],
          },
          'Podemos suspender una cuenta que incumpla estas reglas, avisando cuando sea posible.',
        ],
      },
      {
        id: 'ia',
        heading: '6. Inteligencia artificial y decisiones',
        blocks: [
          'Cortex usa modelos de lenguaje que pueden equivocarse. Sus respuestas son apoyo para decidir, no asesoría jurídica, contable, tributaria ni financiera. Las decisiones y las acciones aprobadas son responsabilidad de la empresa y de quien las aprueba. Revisa las cifras importantes en su fuente: Cortex te dice cuál es.',
        ],
      },
      {
        id: 'terceros',
        heading: '7. Servicios de terceros',
        blocks: [
          'Las conexiones con Google, Microsoft, WhatsApp, programas contables y otros servicios dependen de esos terceros y de sus propios términos. No respondemos por sus fallas, cambios o suspensiones. La conexión con WhatsApp usa la vinculación de dispositivos (como WhatsApp Web) y no la API oficial; su uso puede estar sujeto a restricciones de WhatsApp.',
          {
            note: '[REVISAR CON EL ABOGADO] Alcance de la exoneración respecto de la integración no oficial de WhatsApp.',
          },
        ],
      },
      {
        id: 'pagos',
        heading: '8. Planes y pagos',
        blocks: [
          'Los planes, precios y límites de uso se publican en la aplicación. Los pagos se procesan a través de un proveedor de pagos; Cortex no guarda los datos completos de tarjetas. Salvo que se indique otra cosa, los planes se renuevan por periodos y pueden cancelarse antes de la siguiente renovación.',
          {
            note: '[REVISAR CON EL ABOGADO] Condiciones de renovación, reembolsos, retracto (Ley 1480 de 2011, si hay consumidores) y facturación electrónica.',
          },
        ],
      },
      {
        id: 'terminacion',
        heading: '9. Terminación y destino de la información',
        blocks: [
          'Puedes terminar en cualquier momento. Antes, el dueño o un administrador pueden descargar todos los datos de la empresa desde Ajustes › Privacidad y datos. Cuando el dueño pide eliminar la cuenta de la empresa, hay 30 días para cancelar; después se borra todo de forma definitiva (las copias de seguridad lo conservan hasta 14 días más).',
        ],
      },
      {
        id: 'propiedad',
        heading: '10. Propiedad intelectual',
        blocks: [
          'La plataforma, su código, su marca y su diseño son de Cortex. Lo que Cortex produce para la empresa a partir de su información (respuestas, informes, borradores) puede usarlo libremente la empresa.',
        ],
      },
      {
        id: 'responsabilidad',
        heading: '11. Disponibilidad y responsabilidad',
        blocks: [
          'Trabajamos para que Cortex esté disponible y funcione bien, pero no garantizamos que esté libre de interrupciones o errores. En la máxima medida permitida por la ley, nuestra responsabilidad total frente a una empresa se limita al valor pagado por ella en los [NÚMERO] meses anteriores al hecho que la origina, y no respondemos por lucro cesante ni daños indirectos.',
          {
            note: '[REVISAR CON EL ABOGADO] Límite de responsabilidad y su validez frente al régimen colombiano (incluido el Estatuto del Consumidor, si aplica).',
          },
        ],
      },
      {
        id: 'cambios',
        heading: '12. Cambios a estos términos',
        blocks: [
          'Podemos modificar estos términos. Si el cambio es importante, te pediremos aceptarlo dentro de la aplicación antes de seguir usándola; si no estás de acuerdo, puedes terminar el servicio y descargar tus datos.',
        ],
      },
      {
        id: 'ley',
        heading: '13. Ley aplicable y contacto',
        blocks: [
          `Estos términos se rigen por las leyes de la República de Colombia. Las controversias se intentarán resolver de forma directa; de no lograrse, se someterán a los jueces de ${e.ciudad}, Colombia. Contacto: ${contact(e)}.`,
          `Versión ${LEGAL_DOCUMENT_VERSIONS.terminos}, vigente desde el ${e.fechaVigencia}.`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Aviso de cookies
// ---------------------------------------------------------------------------
/**
 * La tabla se escribió leyendo el código (no hay analítica ni publicidad en el
 * repositorio: ni gtag, ni PostHog, ni @vercel/analytics, ni pixel, ni Sentry
 * Replay). Si alguien agrega una cookie no esencial, este aviso deja de ser
 * verdad y hace falta un control de consentimiento.
 */
export function cookiesNotice(e: LegalEntity): LegalDocumentContent {
  return {
    slug: 'cookies',
    title: 'Aviso de cookies',
    version: LEGAL_DOCUMENT_VERSIONS.privacidad,
    summary:
      'Cortex sólo usa cookies necesarias para iniciar sesión y para que la aplicación funcione. No usa cookies de analítica, publicidad ni seguimiento, así que no hay nada que aceptar ni rechazar.',
    sections: [
      {
        id: 'cuales',
        heading: 'Cookies que usamos',
        blocks: [
          {
            table: {
              head: ['Cookie', 'Para qué', 'Duración'],
              rows: [
                ['better-auth.session_token', 'Mantener tu sesión iniciada', '30 días'],
                [
                  'better-auth.session_data',
                  'Recordar la sesión unos minutos sin consultar la base',
                  '5 minutos',
                ],
                [
                  'better-auth.two_factor',
                  'Completar la verificación en dos pasos',
                  'Minutos, durante el ingreso',
                ],
                [
                  WORKSPACE_NAME_COOKIE,
                  'Llevar el nombre de la empresa del registro a la creación del espacio',
                  '10 minutos',
                ],
                [
                  SIGNUP_CODE_COOKIE,
                  'Llevar el código de invitación del registro',
                  'Minutos, durante el registro',
                ],
                [
                  SIGNUP_CONSENT_COOKIE,
                  'Llevar tu autorización de tratamiento del registro a tu cuenta',
                  '1 hora',
                ],
                [
                  'g_oauth_state, ms_oauth_state, h_oauth_state, qb_oauth_state',
                  'Proteger la conexión con Google, Microsoft, HubSpot o QuickBooks contra suplantación',
                  '10 minutos',
                ],
                [
                  'cortex_view_…',
                  'Recordar que desbloqueaste una vista compartida con contraseña',
                  '12 horas',
                ],
                ['cortex_first_steps_seen', 'No volver a mostrarte los primeros pasos', '1 año'],
              ],
            },
          },
          'Algunos nombres llevan el prefijo «__Secure-» cuando la conexión es segura.',
        ],
      },
      {
        id: 'almacenamiento',
        heading: 'Almacenamiento del navegador',
        blocks: [
          'La aplicación guarda en tu navegador (localStorage) preferencias de la interfaz: el tema claro u oscuro, si el menú lateral está recogido, y qué avisos o recorridos ya viste. No salen de tu navegador.',
        ],
      },
      {
        id: 'terceros',
        heading: 'Terceros',
        blocks: [
          'No hay cookies de terceros con fines de analítica o publicidad. Si inicias sesión con Google o conectas Microsoft, esas páginas son de ellos y usan sus propias cookies.',
        ],
      },
      {
        id: 'control',
        heading: 'Cómo controlarlas',
        blocks: [
          `Puedes borrar o bloquear las cookies desde tu navegador; si bloqueas las necesarias no podrás iniciar sesión. Preguntas: ${e.correo}.`,
        ],
      },
    ],
  };
}

export function legalDocumentBySlug(
  slug: LegalDocumentContent['slug'],
  e: LegalEntity,
): LegalDocumentContent {
  switch (slug) {
    case 'privacidad':
      return privacyPolicy(e);
    case 'terminos':
      return termsOfService(e);
    case 'cookies':
      return cookiesNotice(e);
    case 'tratamiento-de-datos':
      return dataPolicy(e);
  }
}
