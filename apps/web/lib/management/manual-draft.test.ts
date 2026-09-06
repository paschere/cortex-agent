import { describe, expect, it } from 'vitest';
import {
  manualAnalysisSchema,
  manualDraftSchema,
  manualNarration,
  manualNarrationSchema,
  missingManualFields,
} from './manual-draft';
import { managementPlaybookSchema } from './shape';
const incomplete = {
  name: 'Cobrar cartera',
  purpose: 'Recuperar saldos',
  trigger: 'Los lunes',
  inputs: 'Hoja de cartera',
  steps: 'Ana consulta el saldo.\nPrepara un correo.',
  successCriteria: '',
  exceptions: '',
  authority: '',
  browserUrl: null,
};
describe('manual review contract', () => {
  it('keeps missing information visible instead of making it saveable', () => {
    const draft = manualDraftSchema.parse(incomplete);
    expect(missingManualFields(draft)).toEqual([
      'Cómo comprobamos el resultado',
      'Si algo no sale como esperábamos',
      'Permisos y decisiones',
    ]);
    expect(managementPlaybookSchema.safeParse(draft).success).toBe(false);
  });
  it('accepts a completed human-reviewed manual', () => {
    const complete = {
      ...incomplete,
      successCriteria: 'Pago conciliado',
      exceptions: 'Escalar a contabilidad',
      authority: 'Enviar solo con mi aprobación',
    };
    expect(missingManualFields(complete)).toEqual([]);
    expect(managementPlaybookSchema.safeParse(complete).success).toBe(true);
  });
  it('keeps branches and names when returning to the explanation', () =>
    expect(
      manualNarration({
        ...incomplete,
        steps: 'Si hay disputa, Ana escala.\nSi no, prepara el correo.',
      }),
    ).toContain('Si hay disputa, Ana escala.\nSi no, prepara el correo.'));
  it('rejects unsafe URLs in model output', () =>
    expect(
      manualAnalysisSchema.safeParse({
        manual: { ...incomplete, browserUrl: 'javascript:alert(1)' },
        questions: [],
      }).success,
    ).toBe(false));
  it('bounds source length and follow-up questions', () => {
    expect(manualNarrationSchema.safeParse('a'.repeat(18001)).success).toBe(false);
    expect(manualNarrationSchema.safeParse('pago').success).toBe(false);
    expect(
      manualAnalysisSchema.safeParse({
        manual: incomplete,
        questions: Array(5).fill('¿Quién aprueba?'),
      }).success,
    ).toBe(false);
  });
});
