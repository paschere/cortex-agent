import { z } from 'zod';
import { managementPlaybookSchema } from './shape';
export const manualFields = [
  ['purpose', 'Para qué sirve', 'El resultado que buscamos'],
  ['trigger', 'Cuándo empieza', 'La señal que pone el proceso en marcha'],
  ['inputs', 'Qué necesitamos', 'Datos, documentos y herramientas'],
  ['steps', 'Cómo se hace', 'La secuencia y quién interviene'],
  [
    'successCriteria',
    'Cómo comprobamos el resultado',
    'La evidencia que permite darlo por terminado',
  ],
  ['exceptions', 'Si algo no sale como esperábamos', 'Excepciones, bloqueos y a quién acudir'],
  ['authority', 'Permisos y decisiones', 'Qué puede hacerse y qué requiere aprobación'],
] as const;
const shape = managementPlaybookSchema.shape;
export const manualDraftSchema = managementPlaybookSchema.extend({
  name: shape.name.or(z.literal('')),
  purpose: shape.purpose.or(z.literal('')),
  trigger: shape.trigger.or(z.literal('')),
  inputs: shape.inputs.or(z.literal('')),
  steps: shape.steps.or(z.literal('')),
  successCriteria: shape.successCriteria.or(z.literal('')),
  exceptions: shape.exceptions.or(z.literal('')),
  authority: shape.authority.or(z.literal('')),
});
export const manualAnalysisSchema = z.object({
  manual: manualDraftSchema,
  questions: z.array(z.string().trim().min(1).max(300)).max(4),
});
export const manualNarrationSchema = z.string().trim().min(30).max(18000);
export function missingManualFields(manual: z.infer<typeof manualDraftSchema>) {
  return [
    ...(!manual.name.trim() ? ['Nombre del proceso'] : []),
    ...manualFields.filter(([key]) => !manual[key].trim()).map(([, label]) => label),
  ];
}
export function manualNarration(manual: z.infer<typeof manualDraftSchema>) {
  return [
    `Nombre: ${manual.name}`,
    ...manualFields.map(([key, label]) => `${label}:\n${manual[key]}`),
    ...(manual.browserUrl ? [`Trámite: ${manual.browserUrl}`] : []),
  ].join('\n\n');
}
