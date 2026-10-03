import { describe, expect, it } from 'vitest';
import {
  SAGRILAFT_GENERAL_SMLMV,
  pteeApplicability,
  rnbdApplicability,
  sagrilaftApplicability,
  smlmvFor,
} from '../applicability';
import { collectComplianceDue, collectPqrsDeadlines } from '../autopilot';
import { parseRadicado } from '../cases';
import { buildChecklist } from '../catalog';
import { progressByArea } from '../ops';
import {
  addBusinessDays,
  businessDaysLeft,
  deadlinePhrase,
  fillResponse,
  formatRadicado,
  isBusinessDayCo,
  legalDeadline,
  maxExtensionDate,
} from '../pqrs';
import type { ComplianceProfile, ItemRow } from '../shape';

const SMLMV_2025 = 1_423_500;

function profile(p: Partial<ComplianceProfile> = {}): ComplianceProfile {
  return {
    id: 'p',
    entityType: 'sas',
    size: 'pequena',
    revenueCop: 3_000_000_000,
    assetsCop: 2_000_000_000,
    figuresYear: 2025,
    internationalCop: 0,
    stateContractsCop: 0,
    supervisor: 'ninguna',
    supervisionLevel: 'ninguna',
    sectors: [],
    handlesPersonalData: true,
    consumerFacing: false,
    employees: 25,
    hasBoard: false,
    complianceOfficer: null,
    ownerUserId: null,
    privacyPolicyUrl: null,
    pqrsEnabled: false,
    pqrsToken: null,
    pqrsOwnerUserId: null,
    pqrsDeadlines: {},
    updatedAt: null,
    ...p,
  };
}

describe('días hábiles colombianos y el plazo de una PQRS', () => {
  it('sábados, domingos y festivos no son hábiles', () => {
    expect(isBusinessDayCo('2026-10-03')).toBe(false); // sábado
    expect(isBusinessDayCo('2026-10-12')).toBe(false); // Día de la Raza, lunes
    expect(isBusinessDayCo('2026-07-13')).toBe(false); // Ley 2578 de 2026
    expect(isBusinessDayCo('2026-07-20')).toBe(false); // Independencia
    expect(isBusinessDayCo('2026-10-13')).toBe(true);
  });

  it('cuenta desde el día siguiente y salta el festivo', () => {
    // Jueves 1 de octubre + 15 hábiles, con el festivo del 12 en medio.
    expect(addBusinessDays('2026-10-01', 15)).toBe('2026-10-23');
    // Lo que llega un sábado empieza a contar el lunes.
    expect(addBusinessDays('2026-10-03', 1)).toBe('2026-10-05');
    // El festivo nuevo de julio de 2026.
    expect(addBusinessDays('2026-07-08', 3)).toBe('2026-07-14');
  });

  it('lo que queda, en hábiles', () => {
    expect(businessDaysLeft('2026-10-21', '2026-10-23')).toBe(2);
    expect(businessDaysLeft('2026-10-23', '2026-10-23')).toBe(0);
    expect(businessDaysLeft('2026-10-26', '2026-10-23')).toBe(-1);
    expect(deadlinePhrase(-1).text).toBe('vencida hace 1 día hábil');
    expect(deadlinePhrase(0)).toEqual({ text: 'vence hoy', tone: 'rose' });
    expect(deadlinePhrase(2).tone).toBe('amber');
  });

  it('el plazo legal por clase y materia', () => {
    expect(legalDeadline('peticion', 'general').days).toBe(15);
    expect(legalDeadline('peticion', 'informacion').days).toBe(10);
    expect(legalDeadline('peticion', 'consulta').days).toBe(30);
    expect(legalDeadline('peticion', 'datos_personales').days).toBe(10);
    expect(legalDeadline('reclamo', 'datos_personales').days).toBe(15);
    const consumo = legalDeadline('reclamo', 'consumo');
    expect(consumo.days).toBe(15);
    expect(consumo.needsConfirmation).toBe(true);
    expect(legalDeadline('felicitacion', 'general').basis).toMatch(/no fija plazo/);
  });

  it('la empresa puede acortar el plazo, nunca alargarlo', () => {
    expect(legalDeadline('reclamo', 'general', { reclamo: 8 })).toMatchObject({
      days: 8,
      custom: true,
    });
    expect(legalDeadline('reclamo', 'general', { reclamo: 25 })).toMatchObject({
      days: 15,
      custom: false,
    });
  });

  it('la ampliación no pasa del doble', () => {
    expect(maxExtensionDate('2026-10-01', 15)).toBe(addBusinessDays('2026-10-01', 30));
  });

  it('radicado y plantillas de respuesta', () => {
    expect(formatRadicado(2026, 12)).toBe('PQRS-2026-000012');
    expect(
      fillResponse('Hola, {nombre}: {radicado} vence el {plazo}. {empresa}', {
        nombre: 'Ana',
        radicado: 'PQRS-2026-000012',
        fecha: '1 de octubre',
        empresa: 'Andinos',
        asunto: 'x',
        plazo: '23 de octubre',
      }),
    ).toBe('Hola, Ana: PQRS-2026-000012 vence el 23 de octubre. Andinos');
  });
});

describe('¿le aplica SAGRILAFT?', () => {
  it('por encima del umbral general, sí — y siempre por confirmar', () => {
    const big = profile({ revenueCop: SAGRILAFT_GENERAL_SMLMV * SMLMV_2025 + 1 });
    const r = sagrilaftApplicability(big);
    expect(r.applies).toBe('si');
    expect(r.needsConfirmation).toBe(true);
  });

  it('un sector de mayor riesgo usa el umbral de 30.000', () => {
    const r = sagrilaftApplicability(
      profile({ assetsCop: 31_000 * SMLMV_2025, sectors: ['inmobiliario'] }),
    );
    expect(r.applies).toBe('si');
    expect(sagrilaftApplicability(profile({ assetsCop: 31_000 * SMLMV_2025 })).applies).toBe(
      'revisar',
    );
  });

  it('pequeña: no; sin cifras: revisar', () => {
    expect(sagrilaftApplicability(profile()).applies).toBe('no');
    expect(sagrilaftApplicability(profile({ revenueCop: null, assetsCop: null })).applies).toBe(
      'revisar',
    );
  });

  it('si la vigila otra superintendencia, es el sistema de esa', () => {
    const r = sagrilaftApplicability(profile({ supervisor: 'superfinanciera' }));
    expect(r.applies).toBe('revisar');
    expect(r.regime).toMatch(/SARLAFT/);
    expect(sagrilaftApplicability(profile({ entityType: 'esal' })).applies).toBe('no');
  });

  it('usa el SMLMV más cercano y lo dice', () => {
    expect(smlmvFor(2025)).toEqual({ value: SMLMV_2025, exact: true, year: 2025 });
    expect(smlmvFor(2026).exact).toBe(false);
  });

  it('PTEE: tamaño más negocios internacionales, contratos con el Estado o sector', () => {
    const size = 31_000 * SMLMV_2025;
    expect(
      pteeApplicability(profile({ revenueCop: size, internationalCop: 200 * SMLMV_2025 })).applies,
    ).toBe('si');
    expect(
      pteeApplicability(profile({ revenueCop: size, stateContractsCop: 600 * SMLMV_2025 })).applies,
    ).toBe('si');
    expect(pteeApplicability(profile({ revenueCop: size, sectors: ['tic'] })).applies).toBe('si');
    expect(pteeApplicability(profile({ revenueCop: size })).applies).toBe('no');
    expect(pteeApplicability(profile({ revenueCop: size, internationalCop: null })).applies).toBe(
      'revisar',
    );
    expect(pteeApplicability(profile()).applies).toBe('no');
  });

  it('RNBD: activos sobre 100.000 UVT', () => {
    expect(rnbdApplicability(profile({ assetsCop: 2_000_000_000 })).applies).toBe('no');
    expect(rnbdApplicability(profile({ assetsCop: 6_000_000_000 })).applies).toBe('si');
    expect(rnbdApplicability(profile({ assetsCop: null })).applies).toBe('revisar');
    expect(rnbdApplicability(profile({ entityType: 'persona_natural' })).applies).toBe('no');
  });
});

describe('del perfil a la lista', () => {
  it('una S.A.S. pequeña sin consumidores', () => {
    const list = buildChecklist(profile(), 2026);
    const by = new Map(list.map((i) => [`${i.key}#${i.period}`, i]));
    const asamblea = by.get('asamblea_ordinaria#2026');
    expect(asamblea?.applies).toBe('si');
    expect(asamblea?.dueOn).toBe('2026-03-31');
    expect(asamblea?.dueNeedsConfirmation).toBe(true); // en la S.A.S. mandan los estatutos
    expect(by.get('renovacion_matricula#2026')?.linkedHref).toBe('/impuestos');
    expect(by.get('rnbd_inscripcion#')?.applies).toBe('no');
    expect(by.get('politica_datos#')?.applies).toBe('si');
    expect(by.get('pqrs_canal#')?.applies).toBe('revisar');
    expect(by.get('sagrilaft#2026')?.applies).toBe('no');
    expect(by.get('ptee#2026')?.applies).toBe('no');
    // Los reportes semestrales del RNBD, con fecha por confirmar.
    const reclamos = list.filter((i) => i.key === 'rnbd_reclamos');
    expect(reclamos.map((r) => r.period)).toEqual(['2026-02', '2026-08']);
    expect(reclamos.every((r) => r.dueNeedsConfirmation)).toBe(true);
    // Toda aplicabilidad de umbral lleva «confirma con tu oficial».
    expect(by.get('sagrilaft#2026')?.applicabilityNote).toMatch(/oficial de cumplimiento/);
  });

  it('una persona natural no tiene asamblea ni libros de socios', () => {
    const list = buildChecklist(profile({ entityType: 'persona_natural' }), 2026);
    expect(list.find((i) => i.key === 'asamblea_ordinaria')?.applies).toBe('no');
    expect(list.find((i) => i.key === 'libro_accionistas')?.applies).toBe('no');
  });

  it('atiende consumidores: el canal de PQRS aplica', () => {
    const list = buildChecklist(profile({ consumerFacing: true }), 2026);
    expect(list.find((i) => i.key === 'pqrs_canal')?.applies).toBe('si');
  });

  it('vigilada por la Superfinanciera: su propio sistema', () => {
    const list = buildChecklist(profile({ supervisor: 'superfinanciera' }), 2026);
    expect(list.some((i) => i.key === 'sagrilaft')).toBe(false);
    expect(list.find((i) => i.key === 'laft_sectorial')?.title).toMatch(/SARLAFT/);
  });

  it('el avance por área no cuenta lo que no aplica', () => {
    const row = (p: Partial<ItemRow>): ItemRow =>
      ({
        id: Math.random().toString(),
        item_key: 'x',
        period: '',
        area: 'societario',
        title: 't',
        description: null,
        frequency: 'anual',
        due_on: null,
        due_needs_confirmation: false,
        legal_basis: null,
        applies: 'si',
        applicability_note: null,
        status: 'pendiente',
        evidence_document_id: null,
        evidence_url: null,
        evidence_note: null,
        completed_at: null,
        completed_by: null,
        owner_user_id: null,
        commitment_id: null,
        linked_href: null,
        source: 'catalogo',
        rule_version: null,
        created_at: '',
        updated_at: '',
        ...p,
      }) as ItemRow;
    const progress = progressByArea(
      [
        row({ status: 'cumplido' }),
        row({ status: 'pendiente', due_on: '2026-03-31' }),
        row({ status: 'no_aplica' }),
        row({ applies: 'no' }),
      ],
      '2026-10-03',
    );
    expect(progress).toEqual([
      { area: 'societario', total: 2, done: 1, percent: 50, overdue: 1, review: 0 },
    ]);
  });
});

describe('el radicado de un proceso', () => {
  it('23 dígitos con un año creíble', () => {
    const r = parseRadicado('05001-31-03-001-2024-00123-00', 2026);
    expect(r?.digits).toHaveLength(23);
    expect(r?.year).toBe(2024);
    expect(r?.pretty).toBe('05001-31-03-001-2024-00123-00');
    expect(parseRadicado('0500131030012024001230', 2026)).toBeNull();
    expect(parseRadicado('05001310300118990012300', 2026)).toBeNull();
  });
});

describe('el piloto y el cumplimiento', () => {
  it('una PQRS por vencer con responsable PREGUNTA (riesgo alto); sin responsable, cuenta', () => {
    const items = collectPqrsDeadlines({
      items: [],
      pqrs: [
        {
          id: 'p1',
          radicado: 'PQRS-2026-000001',
          kind: 'reclamo',
          subject: 'Cobro doble',
          requester: 'Ana Ruiz',
          due: '2026-10-06',
          left: 1,
          assignedUserId: 'u1',
          assignedName: 'Juan',
        },
        {
          id: 'p2',
          radicado: 'PQRS-2026-000002',
          kind: 'peticion',
          subject: 'Certificado',
          requester: 'Luis',
          due: '2026-10-02',
          left: -1,
          assignedUserId: null,
          assignedName: null,
        },
      ],
    });
    expect(items[0]?.dedupeKey).toBe('pqrs:p2:2026-10-02');
    expect(items[0]?.proposedAction).toBeNull();
    const asked = items.find((i) => i.dedupeKey === 'pqrs:p1:2026-10-06');
    expect(asked?.proposedAction?.toolId).toBe('autopilot.remind');
    expect(asked?.risk).toBe('high');
  });

  it('lo que vence de la lista sólo se cuenta', () => {
    const items = collectComplianceDue(
      {
        items: [
          {
            id: 'i1',
            title: 'Actualización anual del RNBD 2026',
            dueOn: '2026-10-10',
            dueNeedsConfirmation: true,
            overdue: false,
            href: '/cumplimiento',
          },
        ],
        pqrs: [],
      },
      '2026-10-03',
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.proposedAction).toBeNull();
    expect(items[0]?.why).toMatch(/fecha por confirmar/);
  });
});
