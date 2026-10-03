/**
 * LOS ESTÁNDARES MÍNIMOS DEL SG-SST (Resolución 0312 de 2019) — datos puros.
 *
 * Qué estándares le aplican a una empresa depende de su tamaño y del riesgo
 * más alto de sus trabajadores:
 *
 *   ≤ 10 trabajadores, riesgo I, II o III   7 estándares (art. 3)
 *   11 a 50 trabajadores, riesgo I, II o III 21 estándares (art. 9)
 *   más de 50, o riesgo IV o V (cualquier tamaño)  60 estándares (art. 16)
 *
 * La calificación (art. 27 y 28) suma el peso de lo que cumple (y de lo que
 * justificadamente no aplica) sobre 100:
 *
 *   menos de 60 %   crítico — plan de mejoramiento inmediato, reporte a la ARL
 *                   y seguimiento anual de MinTrabajo
 *   60 % a 85 %     moderadamente aceptable — plan de mejoramiento
 *   más de 85 %     aceptable — mantener y mejorar
 *
 * Para los grupos de 7 y 21, Cortex reparte el 100 % en proporción a los
 * pesos de la tabla de 60 (la resolución no publica pesos propios para ellos):
 * eso hay que validarlo con el responsable del SG-SST o la ARL.
 */

export type SstCycle = 'planear' | 'hacer' | 'verificar' | 'actuar';

export interface SstStandard {
  code: string;
  title: string;
  cycle: SstCycle;
  /** Peso en la tabla de 60 estándares (suman 100). */
  weight: number;
  /** El grupo de la tabla («Recursos», «Gestión de la salud»…). */
  group: string;
}

const S = (
  code: string,
  title: string,
  cycle: SstCycle,
  weight: number,
  group: string,
): SstStandard => ({
  code,
  title,
  cycle,
  weight,
  group,
});

export const SST_STANDARDS_60: readonly SstStandard[] = [
  // PLANEAR — I. Recursos (10 %)
  S('1.1.1', 'Responsable del SG-SST designado', 'planear', 0.5, 'Recursos'),
  S('1.1.2', 'Responsabilidades en el SG-SST asignadas', 'planear', 0.5, 'Recursos'),
  S('1.1.3', 'Asignación de recursos para el SG-SST', 'planear', 0.5, 'Recursos'),
  S('1.1.4', 'Afiliación al Sistema General de Riesgos Laborales', 'planear', 0.5, 'Recursos'),
  S('1.1.5', 'Pago de pensión de trabajadores de alto riesgo', 'planear', 0.5, 'Recursos'),
  S('1.1.6', 'Conformación del COPASST (o vigía)', 'planear', 0.5, 'Recursos'),
  S('1.1.7', 'Capacitación del COPASST (o vigía)', 'planear', 0.5, 'Recursos'),
  S('1.1.8', 'Conformación del Comité de Convivencia', 'planear', 0.5, 'Recursos'),
  S('1.2.1', 'Programa de capacitación en promoción y prevención', 'planear', 2, 'Recursos'),
  S('1.2.2', 'Inducción y reinducción en SST', 'planear', 2, 'Recursos'),
  S('1.2.3', 'Responsables del SG-SST con curso virtual de 50 horas', 'planear', 2, 'Recursos'),
  // PLANEAR — II. Gestión integral del SG-SST (15 %)
  S('2.1.1', 'Política del SG-SST firmada, fechada y comunicada', 'planear', 1, 'Gestión integral'),
  S('2.2.1', 'Objetivos del SG-SST definidos', 'planear', 1, 'Gestión integral'),
  S('2.3.1', 'Evaluación inicial del SG-SST', 'planear', 1, 'Gestión integral'),
  S('2.4.1', 'Plan anual de trabajo firmado', 'planear', 2, 'Gestión integral'),
  S('2.5.1', 'Archivo y retención documental del SG-SST', 'planear', 2, 'Gestión integral'),
  S('2.6.1', 'Rendición de cuentas sobre el desempeño', 'planear', 1, 'Gestión integral'),
  S('2.7.1', 'Matriz legal actualizada', 'planear', 2, 'Gestión integral'),
  S('2.8.1', 'Mecanismos de comunicación', 'planear', 1, 'Gestión integral'),
  S('2.9.1', 'SST en la adquisición de productos y servicios', 'planear', 1, 'Gestión integral'),
  S(
    '2.10.1',
    'Evaluación y selección de proveedores y contratistas',
    'planear',
    2,
    'Gestión integral',
  ),
  S('2.11.1', 'Gestión del cambio', 'planear', 1, 'Gestión integral'),
  // HACER — III. Gestión de la salud (20 %)
  S(
    '3.1.1',
    'Descripción sociodemográfica y diagnóstico de condiciones de salud',
    'hacer',
    1,
    'Gestión de la salud',
  ),
  S('3.1.2', 'Actividades de promoción y prevención en salud', 'hacer', 1, 'Gestión de la salud'),
  S('3.1.3', 'Información al médico de los perfiles de cargo', 'hacer', 1, 'Gestión de la salud'),
  S('3.1.4', 'Evaluaciones médicas ocupacionales', 'hacer', 1, 'Gestión de la salud'),
  S('3.1.5', 'Custodia de las historias clínicas', 'hacer', 1, 'Gestión de la salud'),
  S('3.1.6', 'Restricciones y recomendaciones médico-laborales', 'hacer', 1, 'Gestión de la salud'),
  S('3.1.7', 'Estilos de vida y entornos saludables', 'hacer', 1, 'Gestión de la salud'),
  S(
    '3.1.8',
    'Agua potable, servicios sanitarios y disposición de basuras',
    'hacer',
    1,
    'Gestión de la salud',
  ),
  S('3.1.9', 'Eliminación adecuada de residuos', 'hacer', 1, 'Gestión de la salud'),
  S(
    '3.2.1',
    'Reporte de accidentes y enfermedades laborales a la ARL, EPS y MinTrabajo',
    'hacer',
    2,
    'Gestión de la salud',
  ),
  S(
    '3.2.2',
    'Investigación de incidentes, accidentes y enfermedades laborales',
    'hacer',
    2,
    'Gestión de la salud',
  ),
  S(
    '3.2.3',
    'Registro y análisis estadístico de accidentes y enfermedades',
    'hacer',
    1,
    'Gestión de la salud',
  ),
  S('3.3.1', 'Medición de la severidad de los accidentes', 'hacer', 1, 'Gestión de la salud'),
  S('3.3.2', 'Medición de la frecuencia de los accidentes', 'hacer', 1, 'Gestión de la salud'),
  S('3.3.3', 'Medición de la mortalidad por accidentes', 'hacer', 1, 'Gestión de la salud'),
  S('3.3.4', 'Medición de la prevalencia de enfermedad laboral', 'hacer', 1, 'Gestión de la salud'),
  S('3.3.5', 'Medición de la incidencia de enfermedad laboral', 'hacer', 1, 'Gestión de la salud'),
  S('3.3.6', 'Medición del ausentismo por causa médica', 'hacer', 1, 'Gestión de la salud'),
  // HACER — IV. Gestión de peligros y riesgos (30 %)
  S(
    '4.1.1',
    'Metodología para identificar peligros y valorar riesgos',
    'hacer',
    4,
    'Peligros y riesgos',
  ),
  S(
    '4.1.2',
    'Identificación de peligros con participación de todos los niveles',
    'hacer',
    4,
    'Peligros y riesgos',
  ),
  S(
    '4.1.3',
    'Identificación de sustancias cancerígenas o de toxicidad aguda',
    'hacer',
    3,
    'Peligros y riesgos',
  ),
  S('4.1.4', 'Mediciones ambientales', 'hacer', 4, 'Peligros y riesgos'),
  S('4.2.1', 'Medidas de prevención y control implementadas', 'hacer', 2.5, 'Peligros y riesgos'),
  S('4.2.2', 'Verificación de la aplicación de las medidas', 'hacer', 2.5, 'Peligros y riesgos'),
  S(
    '4.2.3',
    'Procedimientos, instructivos y protocolos de trabajo seguro',
    'hacer',
    2.5,
    'Peligros y riesgos',
  ),
  S('4.2.4', 'Inspecciones a instalaciones con el COPASST', 'hacer', 2.5, 'Peligros y riesgos'),
  S(
    '4.2.5',
    'Mantenimiento periódico de instalaciones, equipos y herramientas',
    'hacer',
    2.5,
    'Peligros y riesgos',
  ),
  S(
    '4.2.6',
    'Entrega de elementos de protección personal y capacitación',
    'hacer',
    2.5,
    'Peligros y riesgos',
  ),
  // HACER — V. Gestión de amenazas (10 %)
  S(
    '5.1.1',
    'Plan de prevención, preparación y respuesta ante emergencias',
    'hacer',
    5,
    'Amenazas',
  ),
  S('5.1.2', 'Brigada de emergencias conformada, capacitada y dotada', 'hacer', 5, 'Amenazas'),
  // VERIFICAR — VI. Verificación del SG-SST (5 %)
  S('6.1.1', 'Indicadores de estructura, proceso y resultado', 'verificar', 1.25, 'Verificación'),
  S('6.1.2', 'Auditoría anual del SG-SST', 'verificar', 1.25, 'Verificación'),
  S('6.1.3', 'Revisión anual por la alta dirección', 'verificar', 1.25, 'Verificación'),
  S('6.1.4', 'Planificación de la auditoría con el COPASST', 'verificar', 1.25, 'Verificación'),
  // ACTUAR — VII. Mejoramiento (10 %)
  S('7.1.1', 'Acciones preventivas y correctivas según resultados', 'actuar', 2.5, 'Mejoramiento'),
  S(
    '7.1.2',
    'Acciones de mejora según la revisión de la alta dirección',
    'actuar',
    2.5,
    'Mejoramiento',
  ),
  S(
    '7.1.3',
    'Acciones de mejora según investigaciones de accidentes',
    'actuar',
    2.5,
    'Mejoramiento',
  ),
  S(
    '7.1.4',
    'Plan de mejoramiento por recomendaciones de la ARL o auditorías',
    'actuar',
    2.5,
    'Mejoramiento',
  ),
];

/** Art. 3: empresas de hasta 10 trabajadores en riesgo I, II o III. */
export const SST_CODES_7 = ['1.1.1', '1.1.4', '1.2.1', '2.4.1', '3.1.4', '4.1.2', '4.2.1'] as const;

/** Art. 9: empresas de 11 a 50 trabajadores en riesgo I, II o III. */
export const SST_CODES_21 = [
  '1.1.1',
  '1.1.3',
  '1.1.4',
  '1.1.6',
  '1.1.8',
  '1.2.1',
  '2.1.1',
  '2.4.1',
  '2.5.1',
  '3.1.1',
  '3.1.2',
  '3.1.4',
  '3.1.6',
  '3.2.1',
  '3.2.2',
  '4.1.2',
  '4.2.5',
  '4.2.6',
  '5.1.1',
  '5.1.2',
  '6.1.3',
] as const;

export type SstGroupSize = 7 | 21 | 60;

/** Cuántos estándares le aplican a la empresa. */
export function standardsGroup(workers: number, maxRiskClass: number): SstGroupSize {
  if (maxRiskClass >= 4 || workers > 50) return 60;
  if (workers > 10) return 21;
  return 7;
}

/** Los estándares que le aplican, con el peso repartido sobre 100. */
export function applicableStandards(group: SstGroupSize): SstStandard[] {
  if (group === 60) return [...SST_STANDARDS_60];
  const codes = new Set<string>(group === 7 ? SST_CODES_7 : SST_CODES_21);
  const picked = SST_STANDARDS_60.filter((s) => codes.has(s.code));
  const sum = picked.reduce((t, s) => t + s.weight, 0);
  return picked.map((s) => ({ ...s, weight: Math.round((s.weight / sum) * 100 * 1000) / 1000 }));
}

export const SST_STATUSES = ['pendiente', 'cumple', 'no_cumple', 'no_aplica'] as const;
export type SstStatus = (typeof SST_STATUSES)[number];

export const SST_STATUS_LABEL: Record<SstStatus, string> = {
  pendiente: 'Sin evaluar',
  cumple: 'Cumple',
  no_cumple: 'No cumple',
  no_aplica: 'No aplica (justificado)',
};

export type SstRating = 'critico' | 'moderado' | 'aceptable';

export const SST_RATING_LABEL: Record<SstRating, string> = {
  critico: 'Crítico',
  moderado: 'Moderadamente aceptable',
  aceptable: 'Aceptable',
};

export interface SstComplianceItem {
  code: string;
  weight: number;
  status: SstStatus;
  /** Un «no aplica» sólo suma si está justificado (art. 27). */
  justification?: string | null;
  hasEvidence?: boolean;
}

export interface SstCompliance {
  score: number;
  rating: SstRating;
  met: number;
  notMet: number;
  pending: number;
  notApplicable: number;
  /** «cumple» sin evidencia: suma, pero una auditoría lo tumbaría. */
  withoutEvidence: number;
  action: string;
}

/**
 * La calificación (art. 27–28): suma el peso de lo que cumple y de lo que no
 * aplica CON justificación. Lo pendiente cuenta como no cumplido.
 */
export function sstCompliance(items: readonly SstComplianceItem[]): SstCompliance {
  let score = 0;
  let met = 0;
  let notMet = 0;
  let pending = 0;
  let notApplicable = 0;
  let withoutEvidence = 0;
  for (const i of items) {
    if (i.status === 'cumple') {
      score += i.weight;
      met++;
      if (!i.hasEvidence) withoutEvidence++;
    } else if (i.status === 'no_aplica' && i.justification?.trim()) {
      score += i.weight;
      notApplicable++;
    } else if (i.status === 'pendiente') pending++;
    else notMet++;
  }
  score = Math.round(score * 100) / 100;
  const rating: SstRating = score < 60 ? 'critico' : score <= 85 ? 'moderado' : 'aceptable';
  const action =
    rating === 'critico'
      ? 'Menos de 60 %: plan de mejoramiento inmediato, enviarlo a la ARL en máximo 3 meses y esperar seguimiento anual de MinTrabajo.'
      : rating === 'moderado'
        ? 'Entre 60 % y 85 %: plan de mejoramiento, disponible para MinTrabajo, con informe de avance a la ARL a los 6 meses.'
        : 'Más de 85 %: mantener la calificación y dejar las mejoras en el plan anual de trabajo.';
  return { score, rating, met, notMet, pending, notApplicable, withoutEvidence, action };
}
