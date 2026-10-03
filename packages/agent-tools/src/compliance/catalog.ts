import {
  CONFIRM_OFFICER,
  pteeApplicability,
  rnbdApplicability,
  sagrilaftApplicability,
} from './applicability';
import { addBusinessDays } from './pqrs';
import {
  type Applies,
  COMMERCIAL_COMPANIES,
  type ComplianceArea,
  type ComplianceProfile,
  type ItemFrequency,
} from './shape';

/**
 * LA LISTA DE CUMPLIMIENTO QUE SALE DE UN PERFIL.
 *
 * Cada entrada dice QUÉ hay que hacer, POR QUÉ (su fundamento), CADA CUÁNTO,
 * PARA CUÁNDO (marcado si la fecha está por confirmar) y SI APLICA según el
 * perfil — «sí», «no» o «revisar con alguien» — con la razón en palabras.
 * Puro: la misma entrada da la misma lista, y `catalog.test.ts` lo fija.
 *
 * Las normas se citan sólo donde la cita es segura. Donde la fecha la fija una
 * circular que cambia (la SIC para el RNBD) o los estatutos de la empresa (la
 * asamblea de una S.A.S.), la fecha sale con `dueNeedsConfirmation`.
 *
 * Lo que NO está aquí y es de otros módulos: la renovación de la matrícula se
 * LLEVA en Impuestos (0180, aquí sólo se enlaza); la política de datos de
 * Cortex y los derechos de quien usa Cortex son de 0188; reglamento de
 * trabajo, SG-SST y nómina son de los módulos de personas (0194).
 */

export const CHECKLIST_RULE_VERSION = 'cumplimiento-2026.1';

export interface ChecklistSpec {
  key: string;
  period: string;
  area: ComplianceArea;
  title: string;
  description: string;
  frequency: ItemFrequency;
  dueOn: string | null;
  dueNeedsConfirmation: boolean;
  legalBasis: string;
  applies: Applies;
  applicabilityNote: string;
  linkedHref: string | null;
}

/** El n-ésimo día hábil de un mes (`YYYY-MM`), contando desde el 1. */
function nthBusinessDayOf(month: string, n: number): string {
  // addBusinessDays cuenta desde el día SIGUIENTE: se parte del último del mes anterior.
  const [y, m] = month.split('-').map(Number) as [number, number];
  const lastPrev = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
  return addBusinessDays(lastPrev, n);
}

export function buildChecklist(profile: ComplianceProfile, year: number): ChecklistSpec[] {
  const out: ChecklistSpec[] = [];
  const y = String(year);
  const commercial = COMMERCIAL_COMPANIES.includes(profile.entityType);

  // --- Societario --------------------------------------------------------------
  const assemblyApplies: Applies = commercial
    ? 'si'
    : profile.entityType === 'esal' || profile.entityType === 'otra'
      ? 'revisar'
      : 'no';
  out.push({
    key: 'asamblea_ordinaria',
    period: y,
    area: 'societario',
    title: `Reunión ordinaria de la asamblea o junta de socios ${year}`,
    description:
      'Reunión anual del máximo órgano social para examinar la situación de la empresa, aprobar los estados financieros de fin de ejercicio, el informe de gestión y el proyecto de distribución de utilidades, y elegir a quien corresponda. Evidencia: el acta firmada.',
    frequency: 'anual',
    dueOn: `${y}-03-31`,
    dueNeedsConfirmation: profile.entityType !== 'sa',
    legalBasis:
      'Código de Comercio arts. 422 y 446 (dentro de los tres meses siguientes al vencimiento del ejercicio si los estatutos no dicen otra fecha). En la S.A.S. mandan sus estatutos (Ley 1258 de 2008).',
    applies: assemblyApplies,
    applicabilityNote: commercial
      ? profile.entityType === 'sa'
        ? 'Sociedad anónima: aplica la regla del Código de Comercio salvo fecha en los estatutos.'
        : 'Revisa en tus estatutos la fecha y la forma de convocatoria; el 31 de marzo es la regla supletoria.'
      : profile.entityType === 'persona_natural'
        ? 'Una persona natural comerciante no tiene asamblea.'
        : profile.entityType === 'sucursal_extranjera'
          ? 'La sucursal no tiene asamblea propia: la tiene su casa matriz.'
          : 'Depende de los estatutos de la entidad.',
    linkedHref: null,
  });
  out.push({
    key: 'libro_actas',
    period: y,
    area: 'societario',
    title: `Acta de la asamblea ${year} asentada en el libro de actas`,
    description:
      'Las decisiones del máximo órgano constan en actas aprobadas y firmadas, asentadas en el libro de actas de la sociedad. Si se nombró o cambió representante legal, junta o revisor fiscal, el acta se inscribe además en la Cámara de Comercio.',
    frequency: 'por_evento',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis: 'Código de Comercio arts. 28 y 189.',
    applies: assemblyApplies,
    applicabilityNote: commercial
      ? 'Toda sociedad lleva su libro de actas.'
      : 'Según el tipo de entidad.',
    linkedHref: null,
  });
  out.push({
    key: 'libro_accionistas',
    period: '',
    area: 'societario',
    title: 'Libro de registro de socios o accionistas al día',
    description:
      'Cada emisión, cesión o traspaso de acciones o cuotas queda inscrito en el libro de registro. Revísalo cuando cambie la composición del capital.',
    frequency: 'continua',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis: 'Código de Comercio (libros de registro de socios y de acciones).',
    applies: commercial ? 'si' : 'no',
    applicabilityNote: commercial
      ? 'Lo lleva toda sociedad comercial.'
      : 'No es una sociedad comercial.',
    linkedHref: null,
  });
  out.push({
    key: 'renovacion_matricula',
    period: y,
    area: 'societario',
    title: `Renovación de la matrícula mercantil ${year}`,
    description:
      'La matrícula mercantil se renueva cada año ante la Cámara de Comercio. Se lleva en Impuestos, con su recordatorio y su comprobante: aquí sólo se refleja.',
    frequency: 'anual',
    dueOn: `${y}-03-31`,
    dueNeedsConfirmation: false,
    legalBasis: 'Código de Comercio art. 33 (dentro de los tres primeros meses de cada año).',
    applies: profile.entityType === 'esal' ? 'revisar' : 'si',
    applicabilityNote:
      profile.entityType === 'esal'
        ? 'Las ESAL renuevan su inscripción en el registro de entidades sin ánimo de lucro: confirma la fecha con tu Cámara.'
        : 'Aplica a todo comerciante matriculado.',
    linkedHref: '/impuestos',
  });

  // --- Datos personales (SIC) ------------------------------------------------
  const rnbd = rnbdApplicability(profile);
  out.push({
    key: 'politica_datos',
    period: '',
    area: 'datos_personales',
    title: 'Política de tratamiento de datos personales publicada y autorizaciones',
    description:
      'Una política de tratamiento escrita y publicada (finalidades, derechos de los titulares, canal para consultas y reclamos, responsable), avisos de privacidad y la autorización de cada titular (empleados, clientes, proveedores) guardada como prueba. Evidencia: el enlace de la política.',
    frequency: 'continua',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis: 'Ley 1581 de 2012 y Decreto 1074 de 2015 (Capítulo 25).',
    applies: profile.handlesPersonalData ? 'si' : 'revisar',
    applicabilityNote: profile.handlesPersonalData
      ? profile.privacyPolicyUrl
        ? `La política está en ${profile.privacyPolicyUrl}: revisa que diga lo que hoy hace la empresa.`
        : 'Toda empresa que trata datos personales (de empleados, clientes o proveedores) la necesita. Puedes ver como referencia la de Cortex.'
      : 'El perfil dice que no trata datos personales; casi toda empresa trata al menos los de sus empleados.',
    linkedHref: '/tratamiento-de-datos',
  });
  out.push({
    key: 'rnbd_inscripcion',
    period: '',
    area: 'datos_personales',
    title: 'Bases de datos inscritas en el Registro Nacional de Bases de Datos (SIC)',
    description:
      'Inscribir ante la Superintendencia de Industria y Comercio cada base de datos con datos personales (empleados, clientes, proveedores…), con su finalidad, su forma de tratamiento y su política. Evidencia: la constancia de inscripción.',
    frequency: 'unica',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis:
      'Ley 1581 de 2012 art. 25; Decreto 1074 de 2015 (Sección 2.2.2.26), modificado por el Decreto 090 de 2018.',
    applies: rnbd.applies,
    applicabilityNote: `${rnbd.reasons.join(' ')} ${CONFIRM_OFFICER}`,
    linkedHref: null,
  });
  out.push({
    key: 'rnbd_actualizacion',
    period: y,
    area: 'datos_personales',
    title: `Actualización anual del RNBD ${year}`,
    description:
      'Actualizar cada año la información inscrita en el RNBD, y también cuando haya un cambio sustancial (nueva finalidad, nueva base, transferencia internacional), en el plazo que fija la SIC.',
    frequency: 'anual',
    dueOn: `${y}-03-31`,
    dueNeedsConfirmation: true,
    legalBasis:
      'Decreto 1074 de 2015 e instrucciones de la SIC (Circular Única, Título V). Fecha a confirmar.',
    applies: rnbd.applies,
    applicabilityNote: `Aplica a quien está obligado a inscribirse. La fecha la fija la SIC: confírmala. ${CONFIRM_OFFICER}`,
    linkedHref: null,
  });
  for (const month of ['02', '08']) {
    out.push({
      key: 'rnbd_reclamos',
      period: `${y}-${month}`,
      area: 'datos_personales',
      title: `Reporte de reclamos de titulares en el RNBD (${month === '02' ? 'segundo semestre anterior' : 'primer semestre'})`,
      description:
        'Reportar en el RNBD los reclamos que presentaron los titulares en el semestre, aunque no haya habido ninguno.',
      frequency: 'semestral',
      dueOn: nthBusinessDayOf(`${y}-${month}`, 15),
      dueNeedsConfirmation: true,
      legalBasis: 'Instrucciones de la SIC (Circular Única, Título V). Fecha a confirmar.',
      applies: rnbd.applies,
      applicabilityNote: `Aplica a quien está inscrito en el RNBD. ${CONFIRM_OFFICER}`,
      linkedHref: null,
    });
  }
  out.push({
    key: 'habeas_data',
    period: '',
    area: 'datos_personales',
    title: 'Atender consultas y reclamos de titulares de datos a tiempo',
    description:
      'Las consultas de un titular sobre sus datos se responden en 10 días hábiles y los reclamos (corrección, supresión, revocatoria) en 15. Llévalos como PQRS de materia «datos personales» para que el plazo se cuente solo.',
    frequency: 'continua',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis: 'Ley 1581 de 2012, arts. 14 y 15.',
    applies: profile.handlesPersonalData ? 'si' : 'revisar',
    applicabilityNote: 'Aplica a toda empresa que trata datos personales.',
    linkedHref: '/cumplimiento?tab=pqrs',
  });

  // --- Consumidor y PQRS -----------------------------------------------------
  out.push({
    key: 'pqrs_canal',
    period: '',
    area: 'consumidor',
    title: 'Canal de PQRS abierto y respuestas dentro del plazo legal',
    description:
      'Un canal para que clientes y consumidores radiquen peticiones, quejas, reclamos y sugerencias, con número de radicado y respuesta de fondo dentro del plazo. Cortex te da el formulario público, el radicado y el contador de días hábiles.',
    frequency: 'continua',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis:
      'Ley 1755 de 2015 (arts. 14 y 32, derecho de petición ante particulares); Ley 1480 de 2011 (Estatuto del Consumidor).',
    applies: profile.consumerFacing ? 'si' : 'revisar',
    applicabilityNote: profile.consumerFacing
      ? 'La empresa atiende consumidores: necesita un canal de PQRS.'
      : 'La empresa no atiende consumidores finales; el derecho de petición igual aplica ante particulares en ciertos casos.',
    linkedHref: '/cumplimiento?tab=pqrs',
  });

  // --- Lavado de activos y transparencia ----------------------------------------
  const laft = sagrilaftApplicability(profile);
  const otherSystem = laft.regime && laft.regime !== 'SAGRILAFT';
  out.push({
    key: otherSystem ? 'laft_sectorial' : 'sagrilaft',
    period: y,
    area: 'lavado_activos',
    title: otherSystem
      ? `Sistema de prevención de lavado de activos: ${laft.regime}`
      : `SAGRILAFT: sistema de autocontrol del riesgo de lavado de activos ${year}`,
    description: otherSystem
      ? 'Tu superintendencia exige su propio sistema de prevención del lavado de activos y la financiación del terrorismo. Lleva aquí la evidencia de su revisión anual.'
      : 'Política y manual SAGRILAFT aprobados por la junta o el máximo órgano, oficial de cumplimiento designado, debida diligencia de contrapartes, consulta en listas restrictivas, reportes a la UIAF y revisión periódica. Evidencia: el acta de aprobación o actualización y el informe del oficial.',
    frequency: 'anual',
    dueOn: null,
    dueNeedsConfirmation: true,
    legalBasis: otherSystem
      ? 'Instrucciones de tu superintendencia.'
      : 'Circular Básica Jurídica de la Superintendencia de Sociedades, Capítulo X. Umbrales a confirmar.',
    applies: laft.applies,
    applicabilityNote: `${laft.reasons.join(' ')} ${CONFIRM_OFFICER}`,
    linkedHref: null,
  });
  const ptee = pteeApplicability(profile);
  out.push({
    key: 'ptee',
    period: y,
    area: 'transparencia',
    title: `Programa de Transparencia y Ética Empresarial (PTEE) ${year}`,
    description:
      'Programa para prevenir el soborno transnacional y la corrupción: política aprobada, oficial de cumplimiento, evaluación de riesgos, debida diligencia, canal de denuncias y capacitación. Evidencia: el acta de aprobación o actualización.',
    frequency: 'anual',
    dueOn: null,
    dueNeedsConfirmation: true,
    legalBasis:
      'Circular Básica Jurídica de la Superintendencia de Sociedades, Capítulo XIII; Ley 1778 de 2016. Umbrales a confirmar.',
    applies: ptee.applies,
    applicabilityNote: `${ptee.reasons.join(' ')} ${CONFIRM_OFFICER}`,
    linkedHref: null,
  });

  // --- Procesos judiciales ---------------------------------------------------
  out.push({
    key: 'procesos_judiciales',
    period: '',
    area: 'litigios',
    title: 'Seguimiento de procesos judiciales',
    description:
      'Cada proceso donde la empresa es parte, con su radicado de 23 dígitos, el despacho, la última actuación y la próxima diligencia. La Consulta de Procesos de la Rama Judicial se puede revisar con un trámite aprendido; el CAPTCHA, si lo hay, lo resuelve una persona.',
    frequency: 'continua',
    dueOn: null,
    dueNeedsConfirmation: false,
    legalBasis:
      'Buena práctica de gestión; los términos de cada proceso los fija la ley procesal y el despacho.',
    applies: 'si',
    applicabilityNote:
      'Si la empresa no tiene procesos, márcalo como cumplido con la nota «sin procesos».',
    linkedHref: '/cumplimiento?tab=procesos',
  });

  return out;
}
