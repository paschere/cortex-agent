import { describe, expect, it } from 'vitest';
import { addBusinessDays, incidentAlerts, incidentDeadlines } from './deadlines';
import { SST_STANDARDS_60, applicableStandards, sstCompliance, standardsGroup } from './standards';

describe('estándares mínimos (Resolución 0312 de 2019)', () => {
  it('la tabla de 60 suma 100 y tiene 60 estándares', () => {
    expect(SST_STANDARDS_60).toHaveLength(60);
    expect(Math.round(SST_STANDARDS_60.reduce((s, x) => s + x.weight, 0) * 100) / 100).toBe(100);
    const byCycle = (c: string) =>
      SST_STANDARDS_60.filter((s) => s.cycle === c).reduce((t, s) => t + s.weight, 0);
    expect(byCycle('planear')).toBe(25);
    expect(byCycle('hacer')).toBe(60);
    expect(byCycle('verificar')).toBe(5);
    expect(byCycle('actuar')).toBe(10);
  });

  it('el grupo depende del tamaño y del riesgo', () => {
    expect(standardsGroup(8, 1)).toBe(7);
    expect(standardsGroup(10, 3)).toBe(7);
    expect(standardsGroup(11, 2)).toBe(21);
    expect(standardsGroup(50, 3)).toBe(21);
    expect(standardsGroup(51, 1)).toBe(60);
    expect(standardsGroup(5, 4)).toBe(60);
  });

  it('los grupos de 7 y 21 reparten el 100 %', () => {
    for (const g of [7, 21] as const) {
      const list = applicableStandards(g);
      expect(list).toHaveLength(g);
      expect(Math.round(list.reduce((s, x) => s + x.weight, 0))).toBe(100);
    }
  });
});

describe('calificación del SG-SST', () => {
  const sixty = applicableStandards(60);

  it('todo cumplido = 100 %, aceptable', () => {
    const c = sstCompliance(
      sixty.map((s) => ({ code: s.code, weight: s.weight, status: 'cumple', hasEvidence: true })),
    );
    expect(c.score).toBe(100);
    expect(c.rating).toBe('aceptable');
  });

  it('lo pendiente cuenta como no cumplido; un «no aplica» sin justificar no suma', () => {
    const items = sixty.map((s) => ({
      code: s.code,
      weight: s.weight,
      status: s.cycle === 'hacer' ? ('pendiente' as const) : ('cumple' as const),
    }));
    const c = sstCompliance(items);
    expect(c.score).toBe(40);
    expect(c.rating).toBe('critico');
    expect(c.pending).toBe(30);
    expect(c.withoutEvidence).toBe(30);
    const na = sstCompliance([
      { code: '1.1.5', weight: 50, status: 'no_aplica' },
      {
        code: '1.1.1',
        weight: 50,
        status: 'no_aplica',
        justification: 'No hay tareas de alto riesgo',
      },
    ]);
    expect(na.score).toBe(50);
  });

  it('entre 60 y 85 es moderadamente aceptable', () => {
    const c = sstCompliance([
      { code: 'a', weight: 70, status: 'cumple', hasEvidence: true },
      { code: 'b', weight: 30, status: 'no_cumple' },
    ]);
    expect(c.rating).toBe('moderado');
    expect(c.action).toMatch(/plan de mejoramiento/);
  });
});

describe('plazos de un accidente', () => {
  it('FURAT en 2 días hábiles, investigación en 15 días', () => {
    // Viernes 9 de octubre de 2026; el lunes 12 es festivo.
    const d = incidentDeadlines({ kind: 'accidente', severity: 'leve', occurredOn: '2026-10-09' });
    expect(d.furatDue).toBe('2026-10-14');
    expect(d.investigationDue).toBe('2026-10-24');
    expect(d.ministryDue).toBeNull();
  });

  it('un incidente sin lesión no lleva FURAT, pero sí investigación', () => {
    const d = incidentDeadlines({ kind: 'incidente', severity: 'leve', occurredOn: '2026-10-01' });
    expect(d.furatDue).toBeNull();
    expect(d.investigationDue).toBe('2026-10-16');
  });

  it('mortal: también MinTrabajo', () => {
    const d = incidentDeadlines({
      kind: 'accidente',
      severity: 'mortal',
      occurredOn: '2026-10-01',
    });
    expect(d.ministryDue).toBe(addBusinessDays('2026-10-01', 2));
    expect(d.notes.join(' ')).toMatch(/MinTrabajo/);
  });

  it('las alertas dicen qué está vencido', () => {
    const a = incidentAlerts(
      {
        furatDue: '2026-10-05',
        furatReportedOn: null,
        investigationDue: '2026-10-16',
        investigationDoneOn: null,
      },
      '2026-10-06',
    );
    expect(a).toEqual([
      { what: 'furat', due: '2026-10-05', overdue: true },
      { what: 'investigacion', due: '2026-10-16', overdue: false },
    ]);
  });
});
