import { type ContractType, type CounterpartyKind, DRAFT_NOTICE, type Renewal } from './shape';
import { countInWords, longSpanishDate, pesosInWords } from './text';

/**
 * LAS PLANTILLAS DE SERIE.
 *
 * ===========================================================================
 * SON BORRADORES, Y LO DICEN
 * ===========================================================================
 * Cada plantilla es un punto de partida razonable para una empresa colombiana,
 * escrito para que un abogado lo revise — no un contrato listo para firmar.
 * El texto que sale lleva arriba `DRAFT_NOTICE`, el PDF lleva la franja
 * «Borrador para revisión de un abogado» en cada página, y lo que no se sabe
 * sale como «[COMPLETAR: …]» en vez de inventarse. Las normas se citan sólo
 * donde la cita es segura (CST arts. 23-24, 46, 47, 62, 64 y 78; Código de
 * Comercio arts. 518 y 520 y 905); lo que cambió con la reforma laboral de
 * 2025 o depende del caso va en `legalNotes` como «confirma con tu abogado».
 *
 * ===========================================================================
 * CÓMO SE LLENA
 * ===========================================================================
 * El cuerpo lleva marcadores `{{campo}}`. Cada campo dice de dónde puede salir
 * (`source`: la ficha de la empresa, el cliente o proveedor enlazado, las
 * fechas y el valor del contrato) y, si nadie lo sabe, queda el marcador
 * visible. Lo que escribe la persona gana siempre; después el registro;
 * después el valor por defecto de la plantilla (sólo para texto de cláusula,
 * nunca para un dato de una persona o una cifra).
 */

export type FieldKind = 'text' | 'longtext' | 'money' | 'date' | 'days' | 'months';

/** De dónde puede salir un campo sin preguntarle a nadie. */
export type FieldSource =
  | 'empresa.nombre'
  | 'empresa.nit'
  | 'empresa.direccion'
  | 'empresa.ciudad'
  | 'empresa.representante'
  | 'empresa.representante_id'
  | 'empresa.correo'
  | 'contraparte.nombre'
  | 'contraparte.id'
  | 'contraparte.direccion'
  | 'contraparte.ciudad'
  | 'contraparte.correo'
  | 'contraparte.representante'
  | 'contraparte.representante_id'
  | 'contrato.inicio'
  | 'contrato.fin'
  | 'contrato.valor'
  | 'contrato.preaviso'
  | 'contrato.meses'
  | 'hoy';

export interface TemplateField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  source?: FieldSource;
  /** Sólo para texto de cláusula; nunca para datos de una persona ni cifras. */
  default?: string;
  hint?: string;
}

export interface ContractTemplate {
  key: string;
  type: ContractType;
  name: string;
  description: string;
  counterpartyKind: CounterpartyKind;
  /** Cómo se llama la contraparte en el texto. */
  counterpartyRole: string;
  defaults: { renewal: Renewal; noticeDays: number | null; renewalMonths?: number | null };
  fields: TemplateField[];
  body: string;
  /** Lo que un abogado tiene que mirar antes de firmar. */
  legalNotes: string[];
}

// ---------------------------------------------------------------------------
// Campos que se repiten
// ---------------------------------------------------------------------------

const COMPANY: TemplateField[] = [
  {
    key: 'empresa_nombre',
    label: 'Razón social de la empresa',
    kind: 'text',
    required: true,
    source: 'empresa.nombre',
  },
  {
    key: 'empresa_nit',
    label: 'NIT de la empresa',
    kind: 'text',
    required: true,
    source: 'empresa.nit',
  },
  {
    key: 'empresa_direccion',
    label: 'Dirección de la empresa',
    kind: 'text',
    source: 'empresa.direccion',
  },
  {
    key: 'empresa_representante',
    label: 'Representante legal de la empresa',
    kind: 'text',
    required: true,
    source: 'empresa.representante',
  },
  {
    key: 'empresa_representante_id',
    label: 'Cédula del representante legal',
    kind: 'text',
    source: 'empresa.representante_id',
  },
];

const party = (role: string): TemplateField[] => [
  {
    key: 'contraparte_nombre',
    label: `Nombre o razón social ${role}`,
    kind: 'text',
    required: true,
    source: 'contraparte.nombre',
  },
  {
    key: 'contraparte_id',
    label: `Cédula o NIT ${role}`,
    kind: 'text',
    required: true,
    source: 'contraparte.id',
  },
  {
    key: 'contraparte_direccion',
    label: `Dirección ${role}`,
    kind: 'text',
    source: 'contraparte.direccion',
  },
  {
    key: 'contraparte_correo',
    label: `Correo para notificaciones ${role}`,
    kind: 'text',
    source: 'contraparte.correo',
  },
];

const CITY: TemplateField = {
  key: 'ciudad',
  label: 'Ciudad donde se firma',
  kind: 'text',
  source: 'empresa.ciudad',
};
const TODAY: TemplateField = {
  key: 'fecha_firma',
  label: 'Fecha de firma',
  kind: 'date',
  source: 'hoy',
};

const SIGNATURES = `
Para constancia se firma en {{ciudad}}, el {{fecha_firma}}, en dos ejemplares del mismo tenor.


_____________________________
{{empresa_representante}}
C.C. {{empresa_representante_id}}
Representante legal de {{empresa_nombre}}


_____________________________
{{contraparte_nombre}}
C.C. / NIT {{contraparte_id}}`;

// ---------------------------------------------------------------------------
// Las plantillas
// ---------------------------------------------------------------------------

export const BUILTIN_TEMPLATES: readonly ContractTemplate[] = [
  {
    key: 'prestacion_servicios',
    type: 'prestacion_servicios',
    name: 'Prestación de servicios',
    description:
      'Para un contratista independiente o una empresa que presta un servicio: objeto, entregables, plazo, valor, forma de pago y autonomía.',
    counterpartyKind: 'proveedor',
    counterpartyRole: 'EL CONTRATISTA',
    defaults: { renewal: 'ninguna', noticeDays: 30 },
    fields: [
      ...COMPANY,
      ...party('del contratista'),
      { key: 'objeto', label: 'Objeto: qué servicio se presta', kind: 'longtext', required: true },
      { key: 'entregables', label: 'Entregables y cómo se reciben', kind: 'longtext' },
      {
        key: 'fecha_inicio',
        label: 'Fecha de inicio',
        kind: 'date',
        required: true,
        source: 'contrato.inicio',
      },
      {
        key: 'fecha_fin',
        label: 'Fecha de terminación',
        kind: 'date',
        required: true,
        source: 'contrato.fin',
      },
      {
        key: 'valor',
        label: 'Valor total u honorarios',
        kind: 'money',
        required: true,
        source: 'contrato.valor',
      },
      {
        key: 'forma_pago',
        label: 'Forma de pago',
        kind: 'longtext',
        hint: 'p. ej. «mensualidades vencidas, dentro de los 30 días siguientes a la factura»',
      },
      {
        key: 'preaviso_dias',
        label: 'Días de aviso para terminar',
        kind: 'days',
        source: 'contrato.preaviso',
      },
      CITY,
      TODAY,
    ],
    body: `CONTRATO DE PRESTACIÓN DE SERVICIOS

Entre {{empresa_nombre}}, identificada con NIT {{empresa_nit}}, con domicilio en {{empresa_direccion}}, representada legalmente por {{empresa_representante}}, identificado con cédula de ciudadanía {{empresa_representante_id}}, quien en adelante se denominará EL CONTRATANTE, y {{contraparte_nombre}}, identificado(a) con {{contraparte_id}}, con domicilio en {{contraparte_direccion}}, quien en adelante se denominará EL CONTRATISTA, se celebra el presente contrato de prestación de servicios, que se rige por las siguientes cláusulas:

PRIMERA. OBJETO. EL CONTRATISTA se obliga a prestar a EL CONTRATANTE, con plena autonomía técnica, administrativa y directiva, los siguientes servicios: {{objeto}}

SEGUNDA. ENTREGABLES. EL CONTRATISTA entregará: {{entregables}}

TERCERA. PLAZO. El plazo de ejecución es desde el {{fecha_inicio}} hasta el {{fecha_fin}}. Cualquier prórroga constará por escrito firmado por las partes.

CUARTA. VALOR Y FORMA DE PAGO. El valor del presente contrato es de {{valor}}, que EL CONTRATANTE pagará así: {{forma_pago}}. Cada pago se hará previa presentación de la factura o cuenta de cobro correspondiente y de los soportes que exija la normativa vigente.

QUINTA. OBLIGACIONES DE EL CONTRATISTA. a) Prestar los servicios con calidad, oportunidad y diligencia; b) entregar los entregables en las fechas acordadas; c) cumplir sus obligaciones con el sistema de seguridad social como trabajador independiente, conforme a la normativa vigente, y acreditarlo cuando EL CONTRATANTE lo solicite; d) guardar reserva sobre la información de EL CONTRATANTE; e) las demás propias de la naturaleza del servicio.

SEXTA. OBLIGACIONES DE EL CONTRATANTE. a) Pagar el valor en la forma acordada; b) suministrar la información necesaria para la prestación del servicio; c) recibir los entregables o indicar por escrito sus observaciones.

SÉPTIMA. AUTONOMÍA E INDEPENDENCIA. EL CONTRATISTA actuará por su propia cuenta, con autonomía técnica y administrativa, sin subordinación ni horario impuesto por EL CONTRATANTE. Este contrato no genera relación laboral entre las partes ni con el personal que EL CONTRATISTA emplee, de cuyos salarios, prestaciones y aportes responde exclusivamente EL CONTRATISTA.

OCTAVA. CONFIDENCIALIDAD. EL CONTRATISTA no divulgará la información de EL CONTRATANTE a la que tenga acceso, durante la ejecución del contrato y después de su terminación.

NOVENA. PROPIEDAD INTELECTUAL. Los derechos patrimoniales sobre los entregables que se produzcan en ejecución de este contrato serán de EL CONTRATANTE, salvo pacto escrito en contrario, sin perjuicio de los derechos morales de su autor.

DÉCIMA. TERMINACIÓN. El contrato terminará por vencimiento del plazo, por mutuo acuerdo, por incumplimiento de cualquiera de las partes o por decisión de cualquiera de ellas avisada por escrito con {{preaviso_dias}} de anticipación.

DÉCIMA PRIMERA. SOLUCIÓN DE CONTROVERSIAS. Las diferencias se intentarán resolver primero por arreglo directo dentro de los quince (15) días siguientes a su notificación escrita; si no, se acudirá a la jurisdicción ordinaria de {{ciudad}}.

DÉCIMA SEGUNDA. NOTIFICACIONES. EL CONTRATANTE las recibirá en {{empresa_direccion}}; EL CONTRATISTA, en {{contraparte_direccion}} y en el correo {{contraparte_correo}}.
${SIGNATURES}`,
    legalNotes: [
      'Si en la práctica hay subordinación, horario y salario, el contrato puede declararse laboral (contrato realidad, CST arts. 23 y 24). Revisa la relación real con tu abogado.',
      'Las obligaciones de seguridad social del contratista independiente dependen de la norma vigente y de su ingreso: confírmalas con tu contador.',
      'Si el servicio maneja datos personales de tu empresa, agrega una cláusula de encargo del tratamiento (Ley 1581 de 2012).',
    ],
  },
  {
    key: 'confidencialidad',
    type: 'confidencialidad',
    name: 'Acuerdo de confidencialidad (NDA)',
    description:
      'Para compartir información con un cliente, proveedor o posible socio sin que la use para otra cosa ni la divulgue.',
    counterpartyKind: 'otro',
    counterpartyRole: 'LA PARTE RECEPTORA',
    defaults: { renewal: 'ninguna', noticeDays: null },
    fields: [
      ...COMPANY,
      ...party('de la otra parte'),
      {
        key: 'proposito',
        label: 'Para qué se comparte la información',
        kind: 'longtext',
        required: true,
        hint: 'p. ej. «evaluar una alianza comercial para la distribución de …»',
      },
      {
        key: 'duracion',
        label: 'Cuánto dura la obligación de reserva',
        kind: 'text',
        default: 'dos (2) años contados desde la terminación de la relación entre las partes',
      },
      CITY,
      TODAY,
    ],
    body: `ACUERDO DE CONFIDENCIALIDAD

Entre {{empresa_nombre}}, identificada con NIT {{empresa_nit}}, representada legalmente por {{empresa_representante}}, identificado con cédula de ciudadanía {{empresa_representante_id}}, y {{contraparte_nombre}}, identificado(a) con {{contraparte_id}}, con domicilio en {{contraparte_direccion}} (cada una, una PARTE), se celebra el presente acuerdo de confidencialidad:

PRIMERA. PROPÓSITO. Las PARTES se compartirán información con el único fin de {{proposito}} (el PROPÓSITO).

SEGUNDA. INFORMACIÓN CONFIDENCIAL. Es toda información técnica, comercial, financiera, de clientes, de personal o de cualquier otra naturaleza que una PARTE entregue a la otra, por cualquier medio, con ocasión del PROPÓSITO, esté o no marcada como confidencial.

TERCERA. OBLIGACIONES. La PARTE que recibe la información se obliga a: a) usarla sólo para el PROPÓSITO; b) no divulgarla a terceros sin autorización escrita previa; c) darla a conocer sólo a quienes la necesiten para el PROPÓSITO y estén obligados a la misma reserva; d) protegerla con al menos el cuidado con que protege su propia información reservada.

CUARTA. EXCEPCIONES. No es confidencial la información que: a) sea o llegue a ser de dominio público sin culpa de quien la recibe; b) ya estuviera legítimamente en su poder; c) reciba legítimamente de un tercero sin reserva; d) deba revelar por orden de autoridad competente, caso en el cual avisará de inmediato a la otra PARTE.

QUINTA. DURACIÓN. Las obligaciones de este acuerdo rigen desde su firma y por {{duracion}}.

SEXTA. DEVOLUCIÓN. Terminado el PROPÓSITO, o cuando la otra PARTE lo pida, quien recibió la información la devolverá o destruirá, y lo certificará por escrito.

SÉPTIMA. SIN LICENCIA. Este acuerdo no transfiere propiedad ni otorga licencia alguna sobre la información ni sobre los derechos de propiedad intelectual de las PARTES.

OCTAVA. INCUMPLIMIENTO. La PARTE que incumpla responderá por los perjuicios que cause, conforme a la ley.

NOVENA. LEY APLICABLE. Este acuerdo se rige por las leyes de la República de Colombia.
${SIGNATURES}`,
    legalNotes: [
      'Si la información incluye datos personales, la entrega y el uso deben cumplir la Ley 1581 de 2012 (autorización del titular, finalidad). Revisa si hace falta un contrato de transmisión o encargo.',
      'Una cláusula penal o una indemnización tasada no se incluyó a propósito: si la quieres, que la redacte tu abogado.',
    ],
  },
  {
    key: 'laboral_fijo',
    type: 'laboral_fijo',
    name: 'Contrato de trabajo a término fijo',
    description:
      'Contrato laboral escrito con fecha de terminación, período de prueba y aviso de no prórroga. Los salarios y aportes los liquida Nómina.',
    counterpartyKind: 'empleado',
    counterpartyRole: 'EL TRABAJADOR',
    defaults: { renewal: 'automatica', noticeDays: 30 },
    fields: [
      ...COMPANY,
      ...party('del trabajador'),
      { key: 'cargo', label: 'Cargo', kind: 'text', required: true },
      { key: 'funciones', label: 'Funciones principales', kind: 'longtext', required: true },
      {
        key: 'lugar_trabajo',
        label: 'Lugar donde presta el servicio',
        kind: 'text',
        required: true,
      },
      {
        key: 'salario',
        label: 'Salario mensual',
        kind: 'money',
        required: true,
        source: 'contrato.valor',
      },
      { key: 'periodo_pago', label: 'Período de pago', kind: 'text', default: 'mensual' },
      {
        key: 'jornada',
        label: 'Jornada de trabajo',
        kind: 'text',
        hint: 'La máxima legal vigente y su horario; confirma con tu abogado tras la reforma laboral.',
      },
      {
        key: 'fecha_inicio',
        label: 'Fecha de inicio',
        kind: 'date',
        required: true,
        source: 'contrato.inicio',
      },
      {
        key: 'fecha_fin',
        label: 'Fecha de terminación',
        kind: 'date',
        required: true,
        source: 'contrato.fin',
      },
      {
        key: 'periodo_prueba',
        label: 'Período de prueba',
        kind: 'text',
        hint: 'CST art. 78: no más de dos meses y, en contratos de menos de un año, no más de la quinta parte del término.',
      },
      CITY,
      TODAY,
    ],
    body: `CONTRATO INDIVIDUAL DE TRABAJO A TÉRMINO FIJO

EMPLEADOR: {{empresa_nombre}}, NIT {{empresa_nit}}, representado por {{empresa_representante}}, C.C. {{empresa_representante_id}}, con domicilio en {{empresa_direccion}}.
TRABAJADOR: {{contraparte_nombre}}, C.C. {{contraparte_id}}, con domicilio en {{contraparte_direccion}}, correo {{contraparte_correo}}.
CARGO: {{cargo}}.
LUGAR DE TRABAJO: {{lugar_trabajo}}.
SALARIO: {{salario}}, pagadero por períodos {{periodo_pago}}.
JORNADA: {{jornada}}.
FECHA DE INICIO: {{fecha_inicio}}. FECHA DE TERMINACIÓN: {{fecha_fin}}.

Entre EL EMPLEADOR y EL TRABAJADOR arriba identificados se celebra el presente contrato de trabajo a término fijo, regido por el Código Sustantivo del Trabajo y por las siguientes cláusulas:

PRIMERA. OBJETO. EL TRABAJADOR se obliga a poner al servicio de EL EMPLEADOR toda su capacidad normal de trabajo en el desempeño del cargo de {{cargo}}, con las siguientes funciones principales: {{funciones}}, y las conexas o complementarias que le asigne EL EMPLEADOR.

SEGUNDA. REMUNERACIÓN. EL EMPLEADOR pagará a EL TRABAJADOR el salario indicado. Dentro de este pago se entiende remunerado el descanso de los días dominicales y festivos, salvo lo que disponga la ley para el trabajo en esos días.

TERCERA. DURACIÓN. El término de este contrato es el comprendido entre la fecha de inicio y la de terminación indicadas. Si ninguna de las partes avisa por escrito a la otra su determinación de no prorrogarlo, con una antelación no inferior a treinta (30) días a su vencimiento, el contrato se entenderá renovado en los términos del artículo 46 del Código Sustantivo del Trabajo.

CUARTA. PERÍODO DE PRUEBA. Las partes acuerdan un período de prueba de {{periodo_prueba}}, dentro del cual cualquiera de ellas podrá terminar el contrato sin previo aviso (CST art. 78).

QUINTA. OBLIGACIONES. EL TRABAJADOR cumplirá las órdenes e instrucciones que le imparta EL EMPLEADOR, el reglamento interno de trabajo, las normas de seguridad y salud en el trabajo y guardará reserva sobre la información de EL EMPLEADOR.

SEXTA. TERMINACIÓN. Son justas causas para terminar este contrato las previstas en el artículo 62 del Código Sustantivo del Trabajo. La terminación sin justa causa dará lugar a la indemnización prevista en la ley.

SÉPTIMA. DATOS PERSONALES. EL TRABAJADOR autoriza el tratamiento de sus datos personales para los fines propios de la relación laboral, conforme a la política de tratamiento de datos de EL EMPLEADOR y a la Ley 1581 de 2012.
${SIGNATURES}`,
    legalNotes: [
      'La reforma laboral de 2025 (Ley 2466 de 2025) cambió reglas del contrato a término fijo, la jornada y los recargos: confirma con tu abogado la duración máxima, las prórrogas y la jornada vigentes antes de firmar.',
      'El contrato a término fijo debe constar por escrito (CST art. 46).',
      'Salario, prestaciones, aportes y novedades los liquida el módulo de Nómina; este documento no calcula nada de eso.',
    ],
  },
  {
    key: 'laboral_indefinido',
    type: 'laboral_indefinido',
    name: 'Contrato de trabajo a término indefinido',
    description:
      'Contrato laboral sin fecha de terminación, con cargo, funciones, salario, jornada y período de prueba.',
    counterpartyKind: 'empleado',
    counterpartyRole: 'EL TRABAJADOR',
    defaults: { renewal: 'ninguna', noticeDays: null },
    fields: [
      ...COMPANY,
      ...party('del trabajador'),
      { key: 'cargo', label: 'Cargo', kind: 'text', required: true },
      { key: 'funciones', label: 'Funciones principales', kind: 'longtext', required: true },
      {
        key: 'lugar_trabajo',
        label: 'Lugar donde presta el servicio',
        kind: 'text',
        required: true,
      },
      {
        key: 'salario',
        label: 'Salario mensual',
        kind: 'money',
        required: true,
        source: 'contrato.valor',
      },
      { key: 'periodo_pago', label: 'Período de pago', kind: 'text', default: 'mensual' },
      { key: 'jornada', label: 'Jornada de trabajo', kind: 'text' },
      {
        key: 'fecha_inicio',
        label: 'Fecha de inicio',
        kind: 'date',
        required: true,
        source: 'contrato.inicio',
      },
      {
        key: 'periodo_prueba',
        label: 'Período de prueba',
        kind: 'text',
        hint: 'CST art. 78: no más de dos meses.',
      },
      CITY,
      TODAY,
    ],
    body: `CONTRATO INDIVIDUAL DE TRABAJO A TÉRMINO INDEFINIDO

EMPLEADOR: {{empresa_nombre}}, NIT {{empresa_nit}}, representado por {{empresa_representante}}, C.C. {{empresa_representante_id}}, con domicilio en {{empresa_direccion}}.
TRABAJADOR: {{contraparte_nombre}}, C.C. {{contraparte_id}}, con domicilio en {{contraparte_direccion}}, correo {{contraparte_correo}}.
CARGO: {{cargo}}.
LUGAR DE TRABAJO: {{lugar_trabajo}}.
SALARIO: {{salario}}, pagadero por períodos {{periodo_pago}}.
JORNADA: {{jornada}}.
FECHA DE INICIO: {{fecha_inicio}}.

Entre EL EMPLEADOR y EL TRABAJADOR arriba identificados se celebra el presente contrato de trabajo a término indefinido, regido por el Código Sustantivo del Trabajo y por las siguientes cláusulas:

PRIMERA. OBJETO. EL TRABAJADOR se obliga a poner al servicio de EL EMPLEADOR toda su capacidad normal de trabajo en el desempeño del cargo de {{cargo}}, con las siguientes funciones principales: {{funciones}}, y las conexas o complementarias que le asigne EL EMPLEADOR.

SEGUNDA. REMUNERACIÓN. EL EMPLEADOR pagará a EL TRABAJADOR el salario indicado. Dentro de este pago se entiende remunerado el descanso de los días dominicales y festivos, salvo lo que disponga la ley para el trabajo en esos días.

TERCERA. DURACIÓN. Este contrato es a término indefinido (CST art. 47) y estará vigente mientras subsistan las causas que le dieron origen y la materia del trabajo.

CUARTA. PERÍODO DE PRUEBA. Las partes acuerdan un período de prueba de {{periodo_prueba}}, dentro del cual cualquiera de ellas podrá terminar el contrato sin previo aviso (CST art. 78).

QUINTA. OBLIGACIONES. EL TRABAJADOR cumplirá las órdenes e instrucciones que le imparta EL EMPLEADOR, el reglamento interno de trabajo, las normas de seguridad y salud en el trabajo y guardará reserva sobre la información de EL EMPLEADOR.

SEXTA. TERMINACIÓN. Son justas causas para terminar este contrato las previstas en el artículo 62 del Código Sustantivo del Trabajo. La terminación sin justa causa dará lugar a la indemnización prevista en el artículo 64 del mismo código.

SÉPTIMA. DATOS PERSONALES. EL TRABAJADOR autoriza el tratamiento de sus datos personales para los fines propios de la relación laboral, conforme a la política de tratamiento de datos de EL EMPLEADOR y a la Ley 1581 de 2012.
${SIGNATURES}`,
    legalNotes: [
      'La reforma laboral de 2025 (Ley 2466 de 2025) cambió la jornada, los recargos y reglas de contratación: confirma con tu abogado las cláusulas de jornada y remuneración.',
      'Salario, prestaciones, aportes y novedades los liquida el módulo de Nómina; este documento no calcula nada de eso.',
    ],
  },
  {
    key: 'compraventa',
    type: 'compraventa',
    name: 'Compraventa',
    description:
      'Venta de bienes muebles entre empresas: bienes, precio, forma de pago, entrega y garantía.',
    counterpartyKind: 'cliente',
    counterpartyRole: 'EL COMPRADOR',
    defaults: { renewal: 'ninguna', noticeDays: null },
    fields: [
      ...COMPANY,
      ...party('del comprador'),
      {
        key: 'bienes',
        label: 'Bienes que se venden (descripción, cantidad, referencia)',
        kind: 'longtext',
        required: true,
      },
      {
        key: 'precio',
        label: 'Precio total',
        kind: 'money',
        required: true,
        source: 'contrato.valor',
      },
      { key: 'forma_pago', label: 'Forma de pago', kind: 'longtext', required: true },
      { key: 'lugar_entrega', label: 'Lugar de entrega', kind: 'text', required: true },
      {
        key: 'fecha_entrega',
        label: 'Fecha de entrega',
        kind: 'date',
        required: true,
        source: 'contrato.inicio',
      },
      { key: 'garantia', label: 'Garantía que se ofrece', kind: 'longtext' },
      CITY,
      TODAY,
    ],
    body: `CONTRATO DE COMPRAVENTA

Entre {{empresa_nombre}}, identificada con NIT {{empresa_nit}}, representada legalmente por {{empresa_representante}}, identificado con cédula de ciudadanía {{empresa_representante_id}}, quien en adelante se denominará EL VENDEDOR, y {{contraparte_nombre}}, identificado(a) con {{contraparte_id}}, con domicilio en {{contraparte_direccion}}, quien en adelante se denominará EL COMPRADOR, se celebra el presente contrato de compraventa:

PRIMERA. OBJETO. EL VENDEDOR transfiere a EL COMPRADOR, a título de venta, los siguientes bienes: {{bienes}}

SEGUNDA. PRECIO Y FORMA DE PAGO. El precio es de {{precio}}, que EL COMPRADOR pagará así: {{forma_pago}}.

TERCERA. ENTREGA. EL VENDEDOR entregará los bienes en {{lugar_entrega}} a más tardar el {{fecha_entrega}}. Con la entrega se transfieren a EL COMPRADOR la propiedad y los riesgos de los bienes, salvo pacto en contrario.

CUARTA. ESTADO Y GARANTÍA. EL VENDEDOR declara que los bienes son de su propiedad, están libres de gravámenes y limitaciones de dominio, y responde por ellos así: {{garantia}}, sin perjuicio de la garantía legal que corresponda.

QUINTA. RECIBO. EL COMPRADOR revisará los bienes al recibirlos y comunicará por escrito cualquier inconformidad dentro de los cinco (5) días hábiles siguientes.

SEXTA. INCUMPLIMIENTO. La parte que incumpla responderá por los perjuicios que cause, conforme a la ley.

SÉPTIMA. NOTIFICACIONES. EL VENDEDOR las recibirá en {{empresa_direccion}}; EL COMPRADOR, en {{contraparte_direccion}} y en el correo {{contraparte_correo}}.
${SIGNATURES}`,
    legalNotes: [
      'La compraventa mercantil se rige por el Código de Comercio (art. 905 y siguientes). Si el comprador es consumidor final, aplica además el Estatuto del Consumidor (Ley 1480 de 2011) y su garantía legal.',
      'Para inmuebles o vehículos este texto NO sirve: requieren solemnidades y registro propios.',
    ],
  },
  {
    key: 'arrendamiento_comercial',
    type: 'arrendamiento_comercial',
    name: 'Arrendamiento de local comercial',
    description:
      'Arriendo de un inmueble para un establecimiento de comercio: canon, incrementos, duración, renovación y desahucio.',
    counterpartyKind: 'otro',
    counterpartyRole: 'EL ARRENDADOR',
    defaults: { renewal: 'automatica', noticeDays: 180 },
    fields: [
      ...COMPANY,
      ...party('del arrendador'),
      {
        key: 'inmueble',
        label: 'Dirección e identificación del inmueble',
        kind: 'longtext',
        required: true,
      },
      { key: 'matricula', label: 'Folio de matrícula inmobiliaria', kind: 'text' },
      {
        key: 'destinacion',
        label: 'Destinación (qué actividad comercial)',
        kind: 'text',
        required: true,
      },
      {
        key: 'canon',
        label: 'Canon mensual',
        kind: 'money',
        required: true,
        source: 'contrato.valor',
      },
      {
        key: 'dia_pago',
        label: 'Día de pago del canon',
        kind: 'text',
        required: true,
        hint: 'p. ej. «dentro de los cinco primeros días de cada mes»',
      },
      { key: 'incremento', label: 'Regla de incremento anual', kind: 'text', required: true },
      {
        key: 'fecha_inicio',
        label: 'Fecha de inicio',
        kind: 'date',
        required: true,
        source: 'contrato.inicio',
      },
      {
        key: 'duracion',
        label: 'Duración',
        kind: 'months',
        required: true,
        source: 'contrato.meses',
      },
      CITY,
      TODAY,
    ],
    body: `CONTRATO DE ARRENDAMIENTO DE LOCAL COMERCIAL

Entre {{contraparte_nombre}}, identificado(a) con {{contraparte_id}}, con domicilio en {{contraparte_direccion}}, quien en adelante se denominará EL ARRENDADOR, y {{empresa_nombre}}, identificada con NIT {{empresa_nit}}, representada legalmente por {{empresa_representante}}, identificado con cédula de ciudadanía {{empresa_representante_id}}, quien en adelante se denominará EL ARRENDATARIO, se celebra el presente contrato de arrendamiento:

PRIMERA. OBJETO. EL ARRENDADOR entrega a EL ARRENDATARIO, a título de arrendamiento, el inmueble ubicado en {{inmueble}}, identificado con folio de matrícula inmobiliaria {{matricula}}.

SEGUNDA. DESTINACIÓN. El inmueble se destinará exclusivamente a {{destinacion}}. EL ARRENDATARIO no podrá cambiar su destinación sin autorización escrita de EL ARRENDADOR.

TERCERA. CANON. El canon mensual es de {{canon}}, que EL ARRENDATARIO pagará {{dia_pago}}.

CUARTA. INCREMENTO. Cada año de ejecución, el canon se incrementará así: {{incremento}}.

QUINTA. DURACIÓN. El término del contrato es de {{duracion}}, contados desde el {{fecha_inicio}}.

SEXTA. RENOVACIÓN Y DESAHUCIO. EL ARRENDATARIO que haya ocupado el inmueble por dos años consecutivos con un mismo establecimiento de comercio tiene derecho a la renovación del contrato en los términos del artículo 518 del Código de Comercio. Cuando EL ARRENDADOR pretenda no renovar por las causas allí previstas, deberá desahuciar a EL ARRENDATARIO con no menos de seis (6) meses de anticipación a la fecha de terminación, conforme al artículo 520 del mismo código.

SÉPTIMA. SERVICIOS Y MANTENIMIENTO. Los servicios públicos del inmueble y las reparaciones locativas corren por cuenta de EL ARRENDATARIO; las reparaciones necesarias, por cuenta de EL ARRENDADOR.

OCTAVA. MEJORAS. EL ARRENDATARIO no hará mejoras sin autorización escrita de EL ARRENDADOR; las que haga quedarán en el inmueble salvo pacto en contrario.

NOVENA. CESIÓN Y SUBARRIENDO. EL ARRENDATARIO no podrá ceder el contrato ni subarrendar sin autorización escrita de EL ARRENDADOR, salvo los casos previstos en la ley.

DÉCIMA. RESTITUCIÓN. Terminado el contrato, EL ARRENDATARIO restituirá el inmueble en el estado en que lo recibió, salvo el deterioro natural.
${SIGNATURES}`,
    legalNotes: [
      'El texto está escrito con la empresa como ARRENDATARIA. Si la empresa es la arrendadora, invierte las partes.',
      'Desahucio: el aviso con no menos de seis meses (C.Co. art. 520) aplica cuando el arrendador invoca las causales del art. 518. El aviso de no renovación quedó en 180 días por defecto: ajústalo a lo que diga el contrato.',
      'Agrega las garantías (codeudor, póliza o depósito) que exija el arrendador y revisa con tu abogado las cláusulas de incremento y de terminación anticipada.',
    ],
  },
  {
    key: 'otrosi',
    type: 'otrosi',
    name: 'Otrosí',
    description: 'Modificación de un contrato vigente: qué cláusulas cambian y desde cuándo.',
    counterpartyKind: 'otro',
    counterpartyRole: 'LA CONTRAPARTE',
    defaults: { renewal: 'ninguna', noticeDays: null },
    fields: [
      ...COMPANY,
      ...party('de la otra parte'),
      {
        key: 'numero_otrosi',
        label: 'Número del otrosí',
        kind: 'text',
        required: true,
        default: '1',
      },
      {
        key: 'contrato_original',
        label: 'Contrato que se modifica (nombre o número)',
        kind: 'text',
        required: true,
      },
      {
        key: 'fecha_contrato_original',
        label: 'Fecha del contrato original',
        kind: 'date',
        required: true,
      },
      { key: 'consideraciones', label: 'Por qué se modifica', kind: 'longtext', required: true },
      {
        key: 'modificaciones',
        label: 'Cláusulas que cambian y su nuevo texto',
        kind: 'longtext',
        required: true,
      },
      {
        key: 'fecha_efectiva',
        label: 'Desde cuándo rige',
        kind: 'date',
        required: true,
        source: 'contrato.inicio',
      },
      CITY,
      TODAY,
    ],
    body: `OTROSÍ No. {{numero_otrosi}} AL CONTRATO {{contrato_original}}

Entre {{empresa_nombre}}, identificada con NIT {{empresa_nit}}, representada legalmente por {{empresa_representante}}, identificado con cédula de ciudadanía {{empresa_representante_id}}, y {{contraparte_nombre}}, identificado(a) con {{contraparte_id}}, partes del contrato {{contrato_original}} celebrado el {{fecha_contrato_original}} (el CONTRATO), se acuerda el presente otrosí, previas las siguientes

CONSIDERACIONES
{{consideraciones}}

CLÁUSULAS

PRIMERA. MODIFICACIÓN. Las partes modifican el CONTRATO así: {{modificaciones}}

SEGUNDA. VIGENCIA. Esta modificación rige a partir del {{fecha_efectiva}}.

TERCERA. VIGENCIA DE LO DEMÁS. Las cláusulas del CONTRATO que no se modifican expresamente en este documento continúan vigentes en su totalidad.
${SIGNATURES}`,
    legalNotes: [
      'Si el contrato original exige una formalidad para modificarlo (p. ej. firma de representantes o autorización de junta), cúmplela.',
      'En un contrato laboral, una modificación que desmejore condiciones del trabajador necesita su consentimiento libre y puede tener límites legales: revísala con tu abogado.',
    ],
  },
  {
    key: 'terminacion',
    type: 'terminacion',
    name: 'Carta de terminación o de no prórroga',
    description:
      'Aviso por escrito de que un contrato termina o no se renueva, con la fecha efectiva y el aviso previo.',
    counterpartyKind: 'otro',
    counterpartyRole: 'EL DESTINATARIO',
    defaults: { renewal: 'ninguna', noticeDays: null },
    fields: [
      ...COMPANY,
      {
        key: 'contraparte_nombre',
        label: 'A quién va dirigida',
        kind: 'text',
        required: true,
        source: 'contraparte.nombre',
      },
      {
        key: 'contraparte_direccion',
        label: 'Dirección del destinatario',
        kind: 'text',
        source: 'contraparte.direccion',
      },
      {
        key: 'contrato_referencia',
        label: 'Contrato que se termina (nombre o número y fecha)',
        kind: 'text',
        required: true,
      },
      {
        key: 'decision',
        label: 'Qué se decide',
        kind: 'longtext',
        required: true,
        default: 'no prorrogar el contrato a su vencimiento',
        hint: '«no prorrogar el contrato a su vencimiento», «darlo por terminado de mutuo acuerdo»…',
      },
      {
        key: 'fecha_terminacion',
        label: 'Fecha en que termina',
        kind: 'date',
        required: true,
        source: 'contrato.fin',
      },
      {
        key: 'preaviso_dias',
        label: 'Aviso previo que se da',
        kind: 'days',
        source: 'contrato.preaviso',
      },
      { key: 'pendientes', label: 'Lo que queda por liquidar o entregar', kind: 'longtext' },
      CITY,
      TODAY,
    ],
    body: `{{ciudad}}, {{fecha_firma}}

Señores
{{contraparte_nombre}}
{{contraparte_direccion}}

Asunto: Comunicación sobre el contrato {{contrato_referencia}}

Respetados señores:

Por medio de la presente, {{empresa_nombre}}, identificada con NIT {{empresa_nit}}, les comunica su decisión de {{decision}}, con efectos a partir del {{fecha_terminacion}}.

Esta comunicación se envía con {{preaviso_dias}} de antelación a esa fecha, conforme a lo pactado en el contrato.

Quedan pendientes por liquidar o entregar: {{pendientes}}. Les proponemos coordinar la liquidación y la entrega en los días siguientes.

Agradecemos la relación que hemos tenido.

Atentamente,


_____________________________
{{empresa_representante}}
Representante legal de {{empresa_nombre}}`,
    legalNotes: [
      'Antes de enviarla verifica el aviso previo y la forma de notificación que exige el contrato (correo certificado, correo electrónico, entrega personal) y guarda la prueba del envío.',
      'Si es un contrato laboral: la terminación con o sin justa causa tiene reglas y consecuencias propias (CST arts. 61, 62 y 64; en término fijo, el aviso de no prórroga del art. 46). No la envíes sin revisarla con tu abogado.',
    ],
  },
];

export function builtinTemplate(key: string): ContractTemplate | null {
  return BUILTIN_TEMPLATES.find((t) => t.key === key) ?? null;
}

// ---------------------------------------------------------------------------
// Llenar
// ---------------------------------------------------------------------------

/** Lo que se sabe sin preguntar: la ficha de la empresa, la contraparte, el contrato. */
export interface FillContext {
  today: string;
  company?: Partial<{
    nombre: string;
    nit: string;
    direccion: string;
    ciudad: string;
    representante: string;
    representante_id: string;
    correo: string;
  }>;
  counterparty?: Partial<{
    nombre: string;
    id: string;
    direccion: string;
    ciudad: string;
    correo: string;
    representante: string;
    representante_id: string;
  }>;
  contract?: Partial<{
    start_on: string | null;
    end_on: string | null;
    value_amount: number | null;
    currency: string;
    notice_days: number | null;
    months: number | null;
  }>;
}

export type FieldOrigin = 'persona' | 'registro' | 'plantilla';

export interface FilledField {
  key: string;
  label: string;
  value: string | null;
  origin: FieldOrigin | null;
}

export interface FillResult {
  /** El texto completo, con el aviso de borrador arriba. */
  text: string;
  /** Las etiquetas de lo que quedó como «[COMPLETAR: …]». */
  missing: string[];
  fields: FilledField[];
}

export function placeholderFor(label: string): string {
  return `[COMPLETAR: ${label}]`;
}

const PLACEHOLDER_RE = /\[COMPLETAR: ([^\]]+)\]/g;

/** Las etiquetas de los marcadores que todavía tiene un texto (sin repetir). */
export function remainingPlaceholders(text: string): string[] {
  return [...new Set([...text.matchAll(PLACEHOLDER_RE)].map((m) => m[1] as string))];
}

function fromSource(source: FieldSource, ctx: FillContext): string | number | null {
  const [scope, name] = source.split('.') as [string, string | undefined];
  if (scope === 'hoy') return ctx.today;
  if (scope === 'empresa') {
    const v = ctx.company?.[name as keyof NonNullable<FillContext['company']>];
    return v?.trim() ? v.trim() : null;
  }
  if (scope === 'contraparte') {
    const v = ctx.counterparty?.[name as keyof NonNullable<FillContext['counterparty']>];
    return v?.trim() ? v.trim() : null;
  }
  const c = ctx.contract ?? {};
  switch (name) {
    case 'inicio':
      return c.start_on ?? null;
    case 'fin':
      return c.end_on ?? null;
    case 'valor':
      return c.value_amount ?? null;
    case 'preaviso':
      return c.notice_days ?? null;
    case 'meses':
      return c.months ?? null;
    default:
      return null;
  }
}

/** Un valor ya escrito como va en el contrato, según su clase. */
export function formatFieldValue(
  kind: FieldKind,
  raw: string | number,
  currency = 'COP',
): string | null {
  const text = String(raw).trim();
  if (!text) return null;
  switch (kind) {
    case 'money': {
      const n =
        typeof raw === 'number'
          ? raw
          : Number(
              text
                .replace(/[^\d,.-]/g, '')
                .replace(/\./g, '')
                .replace(',', '.'),
            );
      return Number.isFinite(n) && n > 0 ? pesosInWords(n, currency) : text;
    }
    case 'date':
      return longSpanishDate(text);
    case 'days': {
      const n = typeof raw === 'number' ? raw : Number(text);
      return Number.isInteger(n) && n >= 0 ? countInWords(n, 'día', 'días') : text;
    }
    case 'months': {
      const n = typeof raw === 'number' ? raw : Number(text);
      return Number.isInteger(n) && n > 0 ? countInWords(n, 'mes', 'meses') : text;
    }
    default:
      return text;
  }
}

/**
 * Llena una plantilla. Gana lo que escribió la persona; luego el registro
 * (empresa, contraparte, contrato); luego el texto por defecto de la
 * plantilla. Lo que nadie sabe queda como «[COMPLETAR: etiqueta]» — nunca se
 * inventa un dato.
 */
export function fillTemplate(
  template: Pick<ContractTemplate, 'body' | 'fields'>,
  ctx: FillContext,
  values: Record<string, string | number | null | undefined> = {},
): FillResult {
  const currency = ctx.contract?.currency ?? 'COP';
  const resolved = new Map<string, FilledField>();
  for (const field of template.fields) {
    const given = values[field.key];
    let value: string | null = null;
    let origin: FieldOrigin | null = null;
    if (given !== undefined && given !== null && String(given).trim()) {
      value = formatFieldValue(field.kind, given, currency);
      origin = value ? 'persona' : null;
    }
    if (!value && field.source) {
      const raw = fromSource(field.source, ctx);
      if (raw !== null && raw !== undefined && String(raw).trim()) {
        value = formatFieldValue(field.kind, raw, currency);
        origin = value ? 'registro' : null;
      }
    }
    if (!value && field.default) {
      value = field.default;
      origin = 'plantilla';
    }
    resolved.set(field.key, { key: field.key, label: field.label, value, origin });
  }

  const body = template.body.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/g, (_m, key: string) => {
    const field = resolved.get(key);
    if (field?.value) return field.value;
    return placeholderFor(field?.label ?? key.replace(/_/g, ' '));
  });
  const text = `${DRAFT_NOTICE}\n\n${body.trim()}\n`;
  return { text, missing: remainingPlaceholders(text), fields: [...resolved.values()] };
}

/** Los campos de una plantilla que tienen que estar antes de pensar en firmar. */
export function missingRequired(
  template: Pick<ContractTemplate, 'fields'>,
  result: FillResult,
): string[] {
  const filled = new Map(result.fields.map((f) => [f.key, f.value]));
  return template.fields.filter((f) => f.required && !filled.get(f.key)).map((f) => f.label);
}
