/**
 * The industry examples.
 *
 * WHY THIS FILE IS THE HARDEST PART OF THE PAGE.
 *
 * Cortex works for any company whose memory is scattered across mail, chats and
 * documents. Saying that on a landing page is how a landing page ends up
 * addressing nobody: "for every industry" reads as "for none of them".
 *
 * So the page splits the claim in two. The MECHANISM is stated once and is the
 * same for everyone — it read what you already have, it answers, it shows where
 * the answer came from. The EXAMPLES are chosen by the visitor and are as
 * specific as the trade they belong to: a customs coordinator's questions use a
 * customs coordinator's words, and a billing coordinator would not recognise
 * them. One promise, six vocabularies.
 *
 * Rules the copy here follows:
 *
 *  · A question is written the way somebody types it at 9am, lowercase and
 *    impatient, not the way a brochure would phrase it.
 *  · Every question is attributed to the ROLE that asks it. That is how the
 *    page covers "by industry and by role" without a second selector nobody
 *    would touch.
 *  · `before` says what that person actually did instead — the contrast is the
 *    argument, and it has to be a specific act (call the yard, open the
 *    spreadsheet), never "waste time".
 *  · Sources are real shapes of evidence: a clause number, a day, a minute in a
 *    recording, and the exact words. No invented company names, no invented
 *    customers.
 *  · Amounts in Colombian pesos.
 */

export type SourceTone = 'stamp' | 'seal' | 'hold';

export interface AnswerSource {
  /** The document, system or conversation the fact was read from. */
  source: string;
  /** When it was read or when it happened — already formatted, never computed. */
  when: string;
  /** The exact words, quoted. This is the whole point of the device. */
  quote: string;
  tone?: SourceTone;
}

export interface Ask {
  role: string;
  text: string;
}

export interface Industry {
  id: string;
  /** Tab label. */
  label: string;
  /** Short form for the tag inside the answer card. */
  tag: string;
  asks: Ask[];
  before: string;
  answer: {
    question: string;
    /** Rendered as HTML-free text; the leading sentence carries the verdict. */
    lead: string;
    rest: string;
    sources: AnswerSource[];
  };
}

/**
 * Typed as a non-empty tuple rather than `Industry[]` so that the first entry —
 * the one the hero renders — is known to exist under `noUncheckedIndexedAccess`
 * without a runtime guard for a case that cannot happen.
 */
export const INDUSTRIES: readonly [Industry, ...Industry[]] = [
  {
    id: 'inmobiliaria',
    label: 'Inmobiliaria',
    tag: 'inmobiliaria',
    asks: [
      {
        role: 'Administradora de arriendos',
        text: '¿quién responde por el calentador del 704, el propietario o el arrendatario?',
      },
      {
        role: 'Asesor comercial',
        text: '¿qué comisión le ofrecimos al propietario del 1102?',
      },
      {
        role: 'Contadora de propiedad horizontal',
        text: '¿a este contrato le toca incremento con IPC este mes?',
      },
    ],
    before:
      'Buscabas el contrato escaneado en Drive, y si no aparecía llamabas a la administradora del edificio a ver si se acordaba.',
    answer: {
      question: '¿quién responde por el calentador del 704, el propietario o el arrendatario?',
      lead: 'El propietario.',
      rest: 'El contrato deja al arrendatario sólo las reparaciones locativas, y tanto la administradora como el grupo del edificio dan por sentado que el calentador entró con el inmueble, no con el inquilino.',
      sources: [
        {
          source: 'Contrato de arrendamiento · cláusula 8',
          when: 'firmado 03 mar',
          quote:
            '«Las reparaciones necesarias del inmueble corren por cuenta del arrendador; las locativas, por cuenta del arrendatario.»',
        },
        {
          source: 'Grupo de WhatsApp del edificio',
          when: '03 ago 19:48',
          quote: '«Ese calentador vino con el apartamento desde la entrega.»',
        },
        {
          source: 'Llamada con la administradora',
          when: '05 ago · min 03:22',
          quote: '«Eso lo cubre el propietario, siempre ha sido así en esa torre.»',
        },
      ],
    },
  },
  {
    id: 'logistica',
    label: 'Logística y aduanas',
    tag: 'logística y aduanas',
    asks: [
      { role: 'Coordinador de tráfico', text: '¿el WGY482 puede salir mañana?' },
      { role: 'Jefe de patio', text: '¿qué quedamos con este cliente sobre los sábados?' },
      {
        role: 'Analista de comercio exterior',
        text: '¿ya llegó el BL original del embarque de Cartagena o seguimos con copia?',
      },
    ],
    before:
      'Llamabas al patio, mirabas el RUNT placa por placa y te metías a dos grupos de WhatsApp a buscar qué se había hablado con el cliente.',
    answer: {
      question: '¿el WGY482 puede salir mañana?',
      lead: 'El vehículo sí; el conductor asignado no.',
      rest: 'La licencia de quien está programado figura vencida en el RUNT, y el SOAT y la RTM del tractocamión están vigentes. Si lo despachas mañana viernes, ten en cuenta que el cliente no recibe sábados: descargaría el lunes.',
      sources: [
        {
          source: 'RUNT',
          when: '08 ago 07:41',
          quote: 'Licencia C2 del conductor asignado: vencida el 22 jul.',
          tone: 'seal',
        },
        {
          source: 'Contrato marco · cláusula 9',
          when: 'firmado 14 feb',
          quote:
            '«Los despachos se reciben en planta de lunes a viernes, entre las 7:00 y las 16:00.»',
        },
        {
          source: 'Llamada con el jefe de bodega',
          when: '31 jul · min 12:04',
          quote: '«Los sábados no hay quien reciba, mejor el lunes a primera hora.»',
        },
      ],
    },
  },
  {
    id: 'contabilidad',
    label: 'Contabilidad y consultoría',
    tag: 'contabilidad y consultoría',
    asks: [
      {
        role: 'Auxiliar de cartera',
        text: '¿cuánto le facturamos en julio y qué quedó pendiente?',
      },
      {
        role: 'Contadora',
        text: '¿este cliente es autorretenedor o le practicamos retefuente?',
      },
      {
        role: 'Socio',
        text: '¿en qué quedamos con ellos: el extracto lo piden ustedes o lo pedimos nosotros?',
      },
    ],
    before:
      'Abrías el Excel de cartera, buscabas las facturas en la carpeta compartida y al final le escribías a la persona que lleva la cuenta.',
    answer: {
      question: '¿cuánto le facturamos en julio y qué quedó pendiente?',
      lead: 'En julio se le facturaron $18.400.000 en tres facturas.',
      rest: 'Dos quedaron pagadas. La de honorarios de julio, por $6.900.000, sigue pendiente y el cliente pidió cruzarla contra el anticipo de junio antes de girar.',
      sources: [
        {
          source: 'Factura FV-2214',
          when: 'emitida 05 jul',
          quote: 'Honorarios julio — $6.900.000. Estado: pendiente.',
          tone: 'hold',
        },
        {
          source: 'Correo del cliente',
          when: '29 jul 16:12',
          quote: '«Les pido cruzar esa factura contra el anticipo que ya giramos en junio.»',
        },
        {
          source: 'Reunión de cierre',
          when: '24 jul · min 08:41',
          quote: '«El extracto se los mandamos nosotros el primer día hábil del mes.»',
        },
      ],
    },
  },
  {
    id: 'construccion',
    label: 'Construcción',
    tag: 'construcción',
    asks: [
      {
        role: 'Residente de obra',
        text: '¿qué le prometimos a la interventoría sobre el andén de la torre 3?',
      },
      {
        role: 'Director de proyecto',
        text: '¿el mayor valor del concreto quedó aprobado en acta o sigue en discusión?',
      },
      {
        role: 'Almacenista',
        text: '¿la póliza de cumplimiento del subcontratista de fachada sigue vigente?',
      },
    ],
    before:
      'Pedías el acta escaneada por WhatsApp y confiabas en que alguien se acordara de lo que se dijo en el comité de hace tres semanas.',
    answer: {
      question: '¿qué le prometimos a la interventoría sobre el andén de la torre 3?',
      lead: 'Que queda fundido antes de la entrega de la torre 3, y que el mayor valor lo asume la obra.',
      rest: 'Está en el acta del comité de la semana 12, lo repetiste en el comité del 31 de julio y la interventoría lo dio por aceptado por correo al día siguiente.',
      sources: [
        {
          source: 'Acta de comité · semana 12',
          when: 'radicada 18 jul',
          quote: '«El mayor valor del concreto de 4.000 psi lo asume el constructor.»',
        },
        {
          source: 'Comité de obra',
          when: '31 jul · min 41:20',
          quote: '«El andén de la torre 3 queda fundido antes de la entrega, eso no se mueve.»',
        },
        {
          source: 'Correo de la interventoría',
          when: '01 ago 09:05',
          quote: '«Damos por aceptado lo del andén en los términos del acta.»',
        },
      ],
    },
  },
  {
    id: 'salud',
    label: 'Salud',
    tag: 'salud · área administrativa',
    asks: [
      {
        role: 'Auditora de cuentas médicas',
        text: '¿por qué nos glosaron esta cuenta y qué respondimos la vez pasada?',
      },
      {
        role: 'Coordinadora de facturación',
        text: '¿qué tarifa quedó pactada con esta EPS para consulta especializada?',
      },
      {
        role: 'Jefe de contratación',
        text: '¿este contrato con la EPS ya se renovó o seguimos con el otrosí?',
      },
    ],
    before:
      'Buscabas el contrato en la carpeta de contratación y el correo de la glosa anterior en la bandeja de una compañera que ya no está.',
    answer: {
      question: '¿por qué nos glosaron esta cuenta y qué respondimos la vez pasada?',
      lead: 'La glosaron por soporte incompleto: falta la autorización previa.',
      rest: 'Es la misma causal de mayo. Esa vez la respuesta adjuntó la autorización y el reporte de la atención, y la glosa se levantó. La tarifa del anexo, por si la necesitas para la respuesta, también está citada abajo.',
      sources: [
        {
          source: 'Correo de la EPS',
          when: '02 ago 11:26',
          quote: '«Glosa 05 — soporte: no se adjunta autorización previa del servicio.»',
          tone: 'seal',
        },
        {
          source: 'Respuesta a glosa',
          when: '14 may',
          quote: '«Se adjunta autorización y reporte de atención; se solicita levantar la glosa.»',
        },
        {
          source: 'Contrato con la EPS · anexo tarifario',
          when: 'vigente desde 01 ene',
          quote: '«Consulta especializada: tarifa SOAT vigente menos el diez por ciento (10%).»',
        },
      ],
    },
  },
  {
    id: 'juridico',
    label: 'Servicios jurídicos',
    tag: 'servicios jurídicos',
    asks: [
      {
        role: 'Abogada asociada',
        text: '¿qué plazo pide este contrato para dar el preaviso?',
      },
      {
        role: 'Paralegal',
        text: '¿este contrato tiene cláusula de exclusividad y con qué alcance?',
      },
      {
        role: 'Socio',
        text: '¿qué le respondimos al cliente sobre el pacto de no competencia el martes?',
      },
    ],
    before:
      'Releías el contrato marco completo para encontrar una cláusula de dos líneas, y después buscabas el correo donde el cliente confirmó la fecha de inicio.',
    answer: {
      question: '¿qué plazo pide este contrato para dar el preaviso?',
      lead: 'Sesenta días calendario, por escrito.',
      rest: 'No calculo la fecha límite: la cláusula fija el plazo y el correo del cliente fija el inicio de la vigencia, así que te propongo la fecha abajo para que la confirmes tú antes de que quede en el calendario de nadie.',
      sources: [
        {
          source: 'Contrato de prestación · cláusula 14',
          when: 'firmado 28 ene',
          quote:
            '«Cualquiera de las partes podrá terminarlo mediante preaviso escrito de sesenta (60) días calendario.»',
        },
        {
          source: 'Correo del cliente',
          when: '12 jun 08:33',
          quote: '«Confirmamos que la vigencia arrancó el 1 de febrero.»',
        },
        {
          source: 'Llamada con el socio',
          when: '18 jul · min 06:15',
          quote: '«Avisemos con tiempo, no el último día como la vez pasada.»',
        },
      ],
    },
  },
];
