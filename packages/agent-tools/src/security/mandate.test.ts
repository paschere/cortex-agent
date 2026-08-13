import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type MandateGrant,
  applyMandate,
  isDelegatable,
  mandateMiss,
  mandatePatternMatches,
  surfaceCovered,
  typedAmount,
} from './mandate';
import {
  type Classification,
  DEFAULT_POLICY,
  type Decision,
  type SecurityPolicy,
  type Surface,
  classify,
  decide,
} from './policy';

/**
 * LA PRUEBA QUE IMPORTA ES LA DE PROPIEDAD, Y ESTÁ ABAJO DEL TODO.
 *
 * Los casos con nombre de este archivo explican el mecanismo. Lo que de verdad
 * sostiene la invariante es `describe('propiedades sobre TODA la matriz')`: no
 * comprueba ejemplos elegidos por quien escribió el código —que son siempre los
 * que el código ya resuelve— sino el producto cartesiano entero de familias,
 * cuerpos, superficies, relojes y políticas, contra mandatos deliberadamente
 * omnipotentes. Un `block` que se cuele por una celda que nadie pensó en probar
 * es exactamente el fallo que este cambio no puede tener.
 */

const INTERNAL = 'acme.test';
const NOON = new Date('2026-03-10T19:00:00.000Z'); // 14:00 en Bogotá
const MIDNIGHT = new Date('2026-03-10T06:00:00.000Z'); // 01:00 en Bogotá

beforeEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = INTERNAL;
});

afterEach(() => {
  process.env.INTERNAL_EMAIL_DOMAINS = '';
});

/**
 * Una concesión que lo permite todo lo que un mandato puede permitir.
 *
 * Si no se le dan patrones, se los inventa a partir de la instantánea — nunca
 * un comodín. Un `'*'` de conveniencia en el helper haría que media docena de
 * pruebas de exclusión pasaran por el motivo equivocado (el patrón no
 * emparejaba) en vez de por el que dicen probar.
 */
function omnipotent(over: Partial<MandateGrant> = {}): MandateGrant {
  const coveredToolIds = over.coveredToolIds ?? [];
  return {
    id: 'm-omni',
    label: 'todo lo delegable',
    maxRiskLevel: 'high',
    amountCeiling: null,
    currency: null,
    appliesUnattended: true,
    maxUsesPerDay: null,
    usesToday: 0,
    ...over,
    coveredToolIds,
    toolPatterns: over.toolPatterns ?? coveredToolIds,
  };
}

function run(toolId: string, input: unknown, surface: Surface = 'web', now = NOON): Classification {
  return classify({ tool: { id: toolId }, input, ctx: { now }, surface });
}

// ---------------------------------------------------------------------------
// La transición, y la que no existe
// ---------------------------------------------------------------------------

describe('applyMandate — la única transición implementada', () => {
  it('convierte un confirm en allow cuando la concesión cubre la herramienta', () => {
    const c = run('gmail.send_draft', { to: 'cfo@cliente.example', body: 'la propuesta adjunta' });
    expect(decide(c)).toBe('confirm');

    const out = applyMandate({
      classification: c,
      decision: 'confirm',
      tool: { id: 'gmail.send_draft', requiresConfirmation: true },
      input: {},
      surface: 'web',
      mandates: [omnipotent({ toolPatterns: ['gmail.*'], coveredToolIds: ['gmail.send_draft'] })],
    });

    expect(out.decision).toBe('allow');
    expect(out.mandate?.id).toBe('m-omni');
  });

  it('no toca la clasificación: el riesgo que se audita sigue siendo el real', () => {
    const c = run('gmail.send_draft', { to: 'cfo@cliente.example', body: 'la propuesta' });
    const before = JSON.parse(JSON.stringify(c));
    applyMandate({
      classification: c,
      decision: 'confirm',
      tool: { id: 'gmail.send_draft' },
      input: {},
      surface: 'web',
      mandates: [omnipotent({ coveredToolIds: ['gmail.send_draft'] })],
    });
    expect(c).toEqual(before);
    expect(c.riskLevel).toBe('high');
  });

  it('sin concesión no cambia nada: se queda en confirm', () => {
    const c = run('gmail.send_draft', { to: 'cfo@cliente.example', body: 'la propuesta' });
    const out = applyMandate({
      classification: c,
      decision: 'confirm',
      tool: { id: 'gmail.send_draft' },
      input: {},
      surface: 'web',
      mandates: [],
    });
    expect(out.decision).toBe('confirm');
    expect(out.mandate).toBeNull();
  });

  it('un allow sigue siendo allow — el mandato nunca restringe', () => {
    const c = run('kb.search', { query: 'contrato coltrans' });
    expect(decide(c)).toBe('allow');
    const out = applyMandate({
      classification: c,
      decision: 'allow',
      tool: { id: 'kb.search' },
      input: {},
      surface: 'web',
      mandates: [],
    });
    expect(out.decision).toBe('allow');
    expect(out.mandate).toBeNull();
  });

  it('levanta también la puerta propia de la herramienta sobre un allow', () => {
    // gmail.send_draft a un colega: seguridad dice `allow`, pero la herramienta
    // lleva requiresConfirmation puesto. Sin esto, «puedes mandar correos» no
    // haría absolutamente nada visible.
    const c = run('gmail.send_draft', { to: `jefe@${INTERNAL}`, body: 'el acta de ayer' });
    expect(decide(c)).toBe('allow');

    const out = applyMandate({
      classification: c,
      decision: 'allow',
      tool: { id: 'gmail.send_draft', requiresConfirmation: true },
      input: {},
      surface: 'web',
      mandates: [omnipotent({ coveredToolIds: ['gmail.send_draft'] })],
    });
    expect(out.decision).toBe('allow');
    // Lo que cambia no es el veredicto sino que ahora hay concesión, y es eso lo
    // que registry.ts lee para no pararse en la segunda puerta.
    expect(out.mandate).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Exclusiones duras
// ---------------------------------------------------------------------------

describe('exclusiones que ninguna concesión levanta', () => {
  const cases: Array<[string, string, unknown, Surface]> = [
    [
      'nómina saliendo de la empresa',
      'gmail.send_draft',
      { to: 'x@fuera.example', body: 'salary breakdown' },
      'web',
    ],
    [
      'una cédula en el cuerpo',
      'gmail.send_draft',
      { to: `jefe@${INTERNAL}`, body: 'cédula 1020304050' },
      'web',
    ],
    ['exportación masiva de nómina', 'payroll.expenses_report', { limit: 5000 }, 'web'],
    ['exportación masiva de datos personales', 'people.search', { limit: 900 }, 'web'],
    ['la propia capa de seguridad', 'security.recent_events', { limit: 10 }, 'web'],
    ['una herramienta del cliente', 'custom.consultar_saldo', { id: 'x' }, 'web'],
    ['administrar mandatos', 'mandates.grant', { label: 'x' }, 'web'],
  ];

  for (const [name, toolId, input, surface] of cases) {
    it(`no delega ${name}`, () => {
      const c = run(toolId, input, surface);
      const doctrine = decide(c);
      const out = applyMandate({
        classification: c,
        decision: doctrine,
        tool: { id: toolId, requiresConfirmation: true },
        input,
        surface,
        mandates: [omnipotent({ coveredToolIds: [toolId] })],
      });
      expect(out.mandate).toBeNull();
      expect(out.decision).toBe(doctrine);
    });
  }

  it('un critical se queda bloqueado aunque la política no bloquee críticos', () => {
    const c = run('gmail.send_draft', { to: 'x@fuera.example', body: 'salary breakdown' });
    expect(c.riskLevel).toBe('critical');

    const permissive: SecurityPolicy = { ...DEFAULT_POLICY, blockCritical: false };
    expect(decide(c, permissive)).toBe('confirm');

    // Con blockCritical apagado un crítico solo pregunta — y es exactamente ahí
    // donde un mandato podría convertirlo en `allow` si no existiera la
    // exclusión. Esta es la celda peligrosa del diseño entero.
    const out = applyMandate({
      classification: c,
      decision: 'confirm',
      tool: { id: 'gmail.send_draft' },
      input: {},
      surface: 'web',
      mandates: [omnipotent({ coveredToolIds: ['gmail.send_draft'] })],
    });
    expect(out.decision).toBe('confirm');
    expect(out.mandate).toBeNull();
    expect(isDelegatable(c, 'gmail.send_draft')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cobertura
// ---------------------------------------------------------------------------

describe('cobertura: patrón, instantánea, riesgo, superficie y presupuesto', () => {
  const c = () => run('gmail.send_draft', { to: 'cfo@cliente.example', body: 'la propuesta' });
  const base = { tool: { id: 'gmail.send_draft' }, input: {}, surface: 'web' as Surface };

  it('rechaza el comodín a secas, aquí y en el emparejador', () => {
    expect(mandatePatternMatches('*', 'gmail.send_draft')).toBe(false);
    expect(mandatePatternMatches('gmail.*', 'gmail.send_draft')).toBe(true);
    expect(mandatePatternMatches('gmail.send_draft', 'gmail.send_draft')).toBe(true);
    expect(mandatePatternMatches('gmail.*', 'outlook.send_draft')).toBe(false);

    const m = omnipotent({ toolPatterns: ['*'], coveredToolIds: ['gmail.send_draft'] });
    expect(mandateMiss(m, { classification: c(), ...base })).toBe('pattern');
  });

  it('el patrón sin instantánea detrás no delega: la herramienta nueva queda fuera', () => {
    const m = omnipotent({
      toolPatterns: ['gmail.*'],
      // La instantánea se tomó cuando `gmail.send_draft` era lo único que había.
      coveredToolIds: ['gmail.draft'],
    });
    expect(mandateMiss(m, { classification: c(), ...base })).toBe('snapshot');
  });

  it('el techo de riesgo corta por debajo del nivel de la llamada', () => {
    const m = omnipotent({
      toolPatterns: ['gmail.*'],
      coveredToolIds: ['gmail.send_draft'],
      maxRiskLevel: 'medium',
    });
    expect(c().riskLevel).toBe('high');
    expect(mandateMiss(m, { classification: c(), ...base })).toBe('risk');
  });

  it('la superficie desatendida está fuera salvo que la concesión la nombre', () => {
    const attended = omnipotent({ appliesUnattended: false });
    expect(surfaceCovered(attended, 'web')).toBe(true);
    expect(surfaceCovered(attended, 'mcp')).toBe(true);
    expect(surfaceCovered(attended, 'schedule')).toBe(false);
    expect(surfaceCovered(omnipotent({ appliesUnattended: true }), 'schedule')).toBe(true);
  });

  it('el presupuesto del día se agota y no se renueva solo', () => {
    const spent = omnipotent({
      toolPatterns: ['gmail.*'],
      coveredToolIds: ['gmail.send_draft'],
      maxUsesPerDay: 3,
      usesToday: 3,
    });
    expect(mandateMiss(spent, { classification: c(), ...base })).toBe('budget');

    const left = { ...spent, usesToday: 2 };
    expect(mandateMiss(left, { classification: c(), ...base })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// El techo monetario y su herramienta sintética
// ---------------------------------------------------------------------------

describe('techo monetario — la herramienta tiene que declarar el importe', () => {
  // La herramienta sintética. Hoy casi ninguna real declara importe: las
  // columnas existen desde el día uno y el camino se prueba aquí.
  const payTool = {
    id: 'payments.approve',
    requiresConfirmation: true,
    declaredAmount: { amountKey: 'amount', currencyKey: 'currency' },
  };
  const undeclared = { id: 'payments.approve', requiresConfirmation: true };

  const ceiling = () =>
    omnipotent({
      toolPatterns: ['payments.*'],
      coveredToolIds: ['payments.approve'],
      amountCeiling: 500_000,
      currency: 'COP',
    });

  function attempt(tool: typeof payTool | typeof undeclared, input: unknown): Decision {
    const c = run('payments.approve', input);
    return applyMandate({
      classification: c,
      decision: 'confirm',
      tool,
      input,
      surface: 'web',
      mandates: [ceiling()],
    }).decision;
  }

  it('lee un importe tipado y nada más', () => {
    const d = { amountKey: 'amount', currencyKey: 'currency' };
    expect(typedAmount({ amount: 100, currency: 'COP' }, d)).toEqual({
      amount: 100,
      currency: 'COP',
    });
    expect(typedAmount({ amount: 100, currency: 'cop' }, d)).toEqual({
      amount: 100,
      currency: 'COP',
    });
    // Una cadena con separadores tiene tres lecturas según quién la escribió.
    expect(typedAmount({ amount: '1.200.000', currency: 'COP' }, d)).toBeNull();
    expect(typedAmount({ amount: 100 }, d)).toBeNull();
    expect(typedAmount({ amount: 100, currency: 'pesos' }, d)).toBeNull();
    expect(typedAmount({ amount: Number.NaN, currency: 'COP' }, d)).toBeNull();
    expect(typedAmount({ amount: 100, currency: 'COP' }, undefined)).toBeNull();
  });

  it('deja pasar lo que cabe bajo el techo, en la moneda de la concesión', () => {
    expect(attempt(payTool, { amount: 400_000, currency: 'COP' })).toBe('allow');
    expect(attempt(payTool, { amount: 500_000, currency: 'COP' })).toBe('allow');
  });

  it('para lo que se pasa del techo', () => {
    expect(attempt(payTool, { amount: 500_001, currency: 'COP' })).toBe('confirm');
  });

  it('NUNCA asume la moneda: 400.000 USD no son 400.000 COP', () => {
    expect(attempt(payTool, { amount: 400_000, currency: 'USD' })).toBe('confirm');
    expect(attempt(payTool, { amount: 400_000 })).toBe('confirm');
  });

  it('una herramienta que no declara importe no se delega bajo un techo', () => {
    // La dirección segura: sin cifra tipada no hay nada que comparar, y comparar
    // contra nada es autorizar.
    expect(attempt(undeclared, { amount: 1, currency: 'COP' })).toBe('confirm');
  });

  it('sin techo, la misma herramienta sí se delega', () => {
    const c = run('payments.approve', { amount: 9_999_999, currency: 'COP' });
    const out = applyMandate({
      classification: c,
      decision: 'confirm',
      tool: undeclared,
      input: {},
      surface: 'web',
      mandates: [
        omnipotent({ toolPatterns: ['payments.*'], coveredToolIds: ['payments.approve'] }),
      ],
    });
    expect(out.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// Lo desatendido
// ---------------------------------------------------------------------------

describe('lo desatendido', () => {
  it('el mandato NO puede mandar un correo a un cliente a las 3am', () => {
    const c = run(
      'gmail.send_draft',
      { to: 'cfo@cliente.example', body: 'el informe mensual' },
      'schedule',
      MIDNIGHT,
    );
    expect(c.signals).toContain('unattended');
    expect(c.riskLevel).toBe('critical');
    expect(decide(c)).toBe('block');

    const out = applyMandate({
      classification: c,
      decision: 'block',
      tool: { id: 'gmail.send_draft', requiresConfirmation: true },
      input: {},
      surface: 'schedule',
      mandates: [omnipotent({ coveredToolIds: ['gmail.send_draft'], appliesUnattended: true })],
    });
    expect(out.decision).toBe('block');
    expect(out.mandate).toBeNull();
  });
});

// ===========================================================================
// LA PRUEBA DE PROPIEDAD
// ===========================================================================

/** Familias, sobreescrituras y una desconocida: la matriz de sensibilidad entera. */
const TOOL_IDS = [
  'payroll.employee_profile',
  'payroll.team_assignments',
  'payroll.expenses_report',
  'people.search',
  'gmail.send_draft',
  'gmail.draft',
  'outlook.send_draft',
  'presentations.create_pdf',
  'hubspot.search_companies',
  'gdrive.list_files',
  'gsheets.append_row',
  'kb.search',
  'linear.create_issue',
  'slack.post_message',
  'browser.submit_flow',
  'browser.run_flow',
  'gcal.create_event',
  'vehicles.register',
  'web.search',
  'security.recent_events',
  'custom.consultar_saldo',
  'mandates.grant',
  'clients.update',
  'quienesesta.do_thing',
];

/** Cuerpos que disparan cada señal, sola y combinada. */
const PAYLOADS: Array<[string, unknown]> = [
  ['vacío', {}],
  ['destinatario interno', { to: `jefe@${INTERNAL}` }],
  ['destinatario externo', { to: 'cfo@cliente.example' }],
  ['masivo por limit', { limit: 5000 }],
  ['masivo por bandera', { all: true }],
  ['compensación', { body: 'hourly rate y bonus del equipo' }],
  ['documento de identidad', { body: 'la cédula es 1020304050' }],
  ['compensación hacia afuera', { to: 'cfo@cliente.example', body: 'salary breakdown' }],
  ['identidad hacia afuera', { to: 'cfo@cliente.example', body: 'passport number' }],
  ['masivo hacia afuera', { to: 'cfo@cliente.example', limit: 5000 }],
  ['importe tipado', { amount: 250_000, currency: 'COP' }],
  ['importe enorme', { amount: 90_000_000, currency: 'COP' }],
];

const SURFACES: Surface[] = ['web', 'mcp', 'schedule'];
const CLOCKS = [NOON, MIDNIGHT];
const POLICIES: Array<[string, SecurityPolicy]> = [
  ['por defecto', DEFAULT_POLICY],
  ['crítico sin bloquear', { ...DEFAULT_POLICY, blockCritical: false }],
  ['sin confirmar salidas', { ...DEFAULT_POLICY, externalSendRequiresConfirmation: false }],
];

interface Cell {
  toolId: string;
  payloadName: string;
  input: unknown;
  surface: Surface;
  policyName: string;
  requiresConfirmation: boolean;
  classification: Classification;
  doctrine: Decision;
}

/** El producto cartesiano entero, clasificado de verdad por `classify()`. */
function matrix(): Cell[] {
  const cells: Cell[] = [];
  for (const toolId of TOOL_IDS) {
    for (const [payloadName, input] of PAYLOADS) {
      for (const surface of SURFACES) {
        for (const now of CLOCKS) {
          for (const [policyName, policy] of POLICIES) {
            for (const requiresConfirmation of [false, true]) {
              const classification = classify({
                tool: { id: toolId, requiresConfirmation },
                input,
                ctx: { now },
                surface,
              });
              cells.push({
                toolId,
                payloadName,
                input,
                surface,
                policyName,
                requiresConfirmation,
                classification,
                doctrine: decide(classification, policy),
              });
            }
          }
        }
      }
    }
  }
  return cells;
}

/**
 * Mandatos deliberadamente omnipotentes: cubren todo lo que hay en la matriz,
 * al nivel más alto que un mandato puede tener, en todas las superficies, sin
 * techo y sin presupuesto. Si aun así no rompen ninguna invariante, ninguna
 * concesión más pequeña puede romperla.
 */
function omnipotentFor(toolId: string): MandateGrant[] {
  return [
    omnipotent({ toolPatterns: [`${toolId.split('.')[0]}.*`], coveredToolIds: [toolId] }),
    omnipotent({ id: 'm-exact', toolPatterns: [toolId], coveredToolIds: TOOL_IDS }),
    omnipotent({
      id: 'm-money',
      toolPatterns: [toolId],
      coveredToolIds: TOOL_IDS,
      amountCeiling: 999_999_999,
      currency: 'COP',
    }),
  ];
}

describe('propiedades sobre TODA la matriz de classify', () => {
  const cells = matrix();

  it('la matriz es grande y contiene las cuatro esquinas', () => {
    expect(cells.length).toBeGreaterThan(3000);
    const levels = new Set(cells.map((c) => c.classification.riskLevel));
    expect([...levels].sort()).toEqual(['critical', 'high', 'low', 'medium']);
    const decisions = new Set(cells.map((c) => c.doctrine));
    expect([...decisions].sort()).toEqual(['allow', 'block', 'confirm']);
  });

  it('NINGÚN mandato convierte un block en otra cosa', () => {
    const escaped: string[] = [];
    for (const cell of cells) {
      if (cell.doctrine !== 'block') continue;
      for (const m of omnipotentFor(cell.toolId)) {
        const out = applyMandate({
          classification: cell.classification,
          decision: 'block',
          tool: {
            id: cell.toolId,
            requiresConfirmation: cell.requiresConfirmation,
            declaredAmount: { amountKey: 'amount', currencyKey: 'currency' },
          },
          input: cell.input,
          surface: cell.surface,
          mandates: [m],
        });
        if (out.decision !== 'block' || out.mandate !== null) {
          escaped.push(`${cell.toolId} · ${cell.payloadName} · ${cell.surface} · ${m.id}`);
        }
      }
    }
    expect(escaped, 'Un block salió de applyMandate como otra cosa.').toEqual([]);
  });

  it('NINGUNA combinación produce allow sobre un critical', () => {
    const escaped: string[] = [];
    for (const cell of cells) {
      if (cell.classification.riskLevel !== 'critical') continue;
      for (const m of omnipotentFor(cell.toolId)) {
        // Se le entrega el veredicto de la doctrina tal cual, y también un
        // `confirm` forzado — que es lo que devuelve decide() cuando
        // blockCritical está apagado, y la puerta por la que un crítico podría
        // colarse si la exclusión no existiera.
        for (const decision of [cell.doctrine, 'confirm' as Decision]) {
          const out = applyMandate({
            classification: cell.classification,
            decision,
            tool: {
              id: cell.toolId,
              requiresConfirmation: cell.requiresConfirmation,
              declaredAmount: { amountKey: 'amount', currencyKey: 'currency' },
            },
            input: cell.input,
            surface: cell.surface,
            mandates: [m],
          });
          if (out.decision === 'allow' || out.mandate !== null) {
            escaped.push(
              `${cell.toolId} · ${cell.payloadName} · ${cell.surface} · ${cell.policyName} · ${m.id}`,
            );
          }
        }
      }
    }
    expect(escaped, 'Un critical acabó delegado.').toEqual([]);
  });

  it('el mandato nunca restringe: un allow sigue siendo allow', () => {
    const restricted: string[] = [];
    for (const cell of cells) {
      if (cell.doctrine !== 'allow') continue;
      for (const m of omnipotentFor(cell.toolId)) {
        const out = applyMandate({
          classification: cell.classification,
          decision: 'allow',
          tool: { id: cell.toolId, requiresConfirmation: cell.requiresConfirmation },
          input: cell.input,
          surface: cell.surface,
          mandates: [m],
        });
        if (out.decision !== 'allow') {
          restricted.push(`${cell.toolId} · ${cell.payloadName} · ${m.id}`);
        }
      }
    }
    expect(restricted, 'applyMandate restringió algo. Esa dirección no se implementa.').toEqual([]);
  });

  it('sin concesiones, el veredicto es exactamente el de la doctrina', () => {
    const changed: string[] = [];
    for (const cell of cells) {
      const out = applyMandate({
        classification: cell.classification,
        decision: cell.doctrine,
        tool: { id: cell.toolId, requiresConfirmation: cell.requiresConfirmation },
        input: cell.input,
        surface: cell.surface,
        mandates: [],
      });
      if (out.decision !== cell.doctrine || out.mandate !== null) {
        changed.push(`${cell.toolId} · ${cell.payloadName} · ${cell.surface}`);
      }
    }
    expect(
      changed,
      'Con la lista vacía —que es lo que devuelve una lectura caída— algo cambió.',
    ).toEqual([]);
  });

  it('toda delegación pasa por isDelegatable, y ninguna toca las familias prohibidas', () => {
    const bad: string[] = [];
    for (const cell of cells) {
      for (const m of omnipotentFor(cell.toolId)) {
        const out = applyMandate({
          classification: cell.classification,
          decision: cell.doctrine,
          tool: {
            id: cell.toolId,
            requiresConfirmation: cell.requiresConfirmation,
            declaredAmount: { amountKey: 'amount', currencyKey: 'currency' },
          },
          input: cell.input,
          surface: cell.surface,
          mandates: [m],
        });
        if (!out.mandate) continue;

        const c = cell.classification;
        const family = cell.toolId.split('.')[0];
        if (
          !isDelegatable(c, cell.toolId) ||
          c.riskLevel === 'critical' ||
          (c.blastRadius === 'bulk' &&
            (c.sensitivity === 'financial' || c.sensitivity === 'pii')) ||
          c.signals.includes('compensation-in-payload') ||
          c.signals.includes('personal-id-in-payload') ||
          ['security', 'mandates', 'custom'].includes(family ?? '') ||
          (cell.surface === 'schedule' && !m.appliesUnattended)
        ) {
          bad.push(`${cell.toolId} · ${cell.payloadName} · ${cell.surface} · ${m.id}`);
        }
      }
    }
    expect(bad, 'Se delegó algo que las exclusiones duras prohíben.').toEqual([]);
  });
});
