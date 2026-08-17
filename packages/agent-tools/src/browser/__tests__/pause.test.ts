import type { Logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Row, makeDb } from '../../whatsapp/__tests__/fake-db';
import { type Checkpoint, isLive, secondsLeft } from '../checkpoint';
import { resumeFlow, runFlow } from '../execute';
import { REDACTED } from '../redact';
import type { Step } from '../types';
import {
  ORG,
  USER,
  forbiddenRepairer,
  makeFlow,
  pausedAt,
  scriptedTransport,
  step,
  succeeded,
} from './fixtures';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EL ÚNICO MOMENTO EN QUE UN TRÁMITE LLAMA A UNA PERSONA
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Un portal que pide un código por SMS es, hoy, el final del camino para
 * cualquier automatización: la corrida falla, alguien lo hace a mano, y el
 * trámite queda marcado como algo que no sirve. Estas pruebas son sobre la
 * alternativa — el trámite se para, pregunta UNA cosa, y sigue.
 *
 * Lo que se afirma aquí no es que la pausa funcione: es que la pausa NO SE
 * PARECE A UNA FALLA en ninguno de los sitios donde el producto reacciona a
 * una falla. Un captcha que se leyera como «el sitio cambió» compraría una
 * reescritura del flujo por parte del modelo, contra una página que no tiene
 * nada malo, y así es como muere un trámite que funcionaba.
 */

const KEY = 'Ao9v3nQ0ZK7mXn2bR5tY8uI1oP4aS6dF9gH0jK2lM3Q=';

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.SUPABASE_DB_URL = 'postgres://localhost:54322/postgres';
});

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as Logger;

function baseStore(): Record<string, Row[]> {
  return {
    browser_flows: [],
    browser_flow_versions: [],
    browser_flow_grants: [],
    browser_flow_runs: [],
    browser_flow_run_steps: [],
    browser_flow_checkpoints: [],
    browser_credentials: [],
  };
}

const db = (store: Record<string, Row[]>): SupabaseClient => makeDb(store);

/** Un trámite bancario: entrar, pedir el código, teclearlo, bajar el extracto. */
const OTP_STEPS: Step[] = [
  step({ action: 'goto', label: 'Abrir el banco', targets: [], url: 'https://banco.test/entrar' }),
  step({ action: 'click', label: 'Entrar' }),
  step({
    action: 'pause',
    label: 'Dime el código de 6 dígitos que te acaba de llegar al celular',
    targets: [],
    extractAs: 'codigo',
  }),
  step({
    action: 'fill',
    label: 'Código de verificación',
    value: { kind: 'template', text: '{{codigo}}' },
  }),
  step({ action: 'download', label: 'Bajar el extracto' }),
];

function otpFlow() {
  return makeFlow({
    slug: 'extracto-banco',
    name: 'Extracto del banco',
    steps: OTP_STEPS,
    variables: [
      { name: 'codigo', label: 'el código que te llega al celular', example: '483920', required: true, type: 'code' },
    ],
  });
}

const checkpointRow = (store: Record<string, Row[]>) =>
  (store.browser_flow_checkpoints as Row[])[0] as Row;

describe('un trámite que se para a pedir un código', () => {
  it('no lo cuenta como falla del flujo, y no deja que el modelo lo toque', async () => {
    // LA AFIRMACIÓN CENTRAL. `forbiddenRepairer` lanza si algo lo llama: si una
    // pausa cayera por la rama de clasificación, «ningún selector coincide» se
    // leería como un rediseño y compraría una reparación pagada de un flujo
    // que está perfecto.
    const store = baseStore();
    const flow = otpFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];
    const transport = scriptedTransport([pausedAt(flow.steps, 2, 'Dime el código', 'codigo')]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: {},
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.pendingQuestion).toBe('input');
    expect(outcome.message).toContain('código');

    // El flujo no se degrada. `broken` significa «alguien tiene que volver a
    // enseñar esto», y un portal que pide un código todos los meses está
    // funcionando como fue diseñado.
    const flowRow = (store.browser_flows as Row[])[0] as Row;
    expect(flowRow.status).toBeUndefined();
    expect(flowRow.last_run_status).toBe('needs-human');
    expect(flowRow.last_error).toBeNull();
  });

  it('no le pide al que llama el dato que va a dictar una persona', async () => {
    // `codigo` es requerido y nadie lo pasó, y aun así la corrida arranca. Si
    // se exigiera de antemano, habría que pedir un código que el banco todavía
    // no ha enviado.
    const store = baseStore();
    const flow = otpFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];
    const transport = scriptedTransport([pausedAt(flow.steps, 2, 'Dime el código', 'codigo')]);

    await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: {},
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });

    expect(transport.calls.length).toBe(1);
  });

  it('escribe dónde quedó, con el paso siguiente y no el de la pausa', async () => {
    const store = baseStore();
    const flow = otpFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];
    const transport = scriptedTransport([pausedAt(flow.steps, 2, 'Dime el código', 'codigo')]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: {},
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });

    const row = checkpointRow(store);
    expect(row.reason).toBe('input-needed');
    expect(row.fills).toBe('codigo');
    // Reanudar en el paso de la pausa la volvería a disparar sobre la misma
    // respuesta que se acaba de recibir.
    expect(row.from_index).toBe(3);
    expect(row.state).toBe('open');
    expect(outcome.checkpoint?.id).toBe(row.id);
  });

  it('dice honestamente que no hay a dónde volver cuando el navegador estaba lleno', async () => {
    // El servicio se niega a sostener una pestaña cuando no le queda cupo. Una
    // pregunta que nadie puede contestar es peor que un «no pude».
    const store = baseStore();
    const flow = otpFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];
    const paused = pausedAt(flow.steps, 2, 'Dime el código', 'codigo');
    const { handoff: _dropped, ...withoutTab } = paused.data;
    const transport = scriptedTransport([{ ok: true, data: withoutTab }]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: {},
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });

    expect(outcome.checkpoint).toBeUndefined();
    expect(outcome.message).toContain('volver a arrancar');
    expect((store.browser_flow_checkpoints as Row[]).length).toBe(0);
  });
});

describe('el código nunca queda escrito en ninguna fila', () => {
  it('lo guarda como *** en los datos de la corrida y del checkpoint', async () => {
    const store = baseStore();
    const flow = otpFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];
    const transport = scriptedTransport([pausedAt(flow.steps, 2, 'Dime el código', 'codigo')]);

    await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      // Aunque alguien lo pase de entrada — un reintento, por ejemplo.
      inputs: { codigo: '483920' },
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });

    const run = (store.browser_flow_runs as Row[])[0] as Row;
    expect(run.inputs).toEqual({ codigo: REDACTED });
    expect(checkpointRow(store).inputs).toEqual({ codigo: REDACTED });

    // Y el valor de verdad sí llegó al navegador, que es donde tiene que estar.
    expect(transport.calls[0]?.inputs).toEqual({ codigo: '483920' });
  });
});

describe('retomar donde iba', () => {
  async function pause(store: Record<string, Row[]>) {
    const flow = otpFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG, ...flowRowOf(flow) }];
    const transport = scriptedTransport([
      pausedAt(flow.steps, 2, 'Dime el código', 'codigo'),
      succeeded(flow.steps.slice(3), { download: { filename: 'extracto.pdf' } }),
    ]);
    await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: {},
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });
    return { flow, transport };
  }

  it('le pasa el código al navegador ya normalizado por su tipo', async () => {
    // El celular muestra «483 920». La casilla toma seis dígitos. Nadie está
    // mirando el rótulo para arreglarlo.
    const store = baseStore();
    const { transport } = await pause(store);

    const outcome = await resumeFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      checkpointId: checkpointRow(store).id as string,
      answer: '483 920',
      transport,
      logger: silent,
    });

    expect(outcome.ok).toBe(true);
    expect(transport.resumes[0]?.inputs).toEqual({ codigo: '483920' });
    expect(transport.resumes[0]?.fromIndex).toBe(3);
    expect(transport.resumes[0]?.sessionId).toBe('s_test_1');
  });

  it('cierra el punto de espera antes de tocar la pestaña, así que dos respuestas producen una corrida', async () => {
    // Un encargo bloqueado pregunta por el chat Y por la campana, así que dos
    // personas contestando lo mismo no es raro. La segunda tiene que rebotar
    // aquí y no en un 404 del servicio sobre un trámite que sí terminó.
    const store = baseStore();
    const { transport } = await pause(store);
    const id = checkpointRow(store).id as string;

    const first = await resumeFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      checkpointId: id,
      answer: '483920',
      transport,
      logger: silent,
    });
    const second = await resumeFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      checkpointId: id,
      answer: '483920',
      transport,
      logger: silent,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(transport.resumes.length).toBe(1);
    expect(checkpointRow(store).state).toBe('resumed');
  });

  it('se niega, y lo explica, cuando la pestaña ya se venció', async () => {
    const store = baseStore();
    const { transport } = await pause(store);
    const row = checkpointRow(store);
    row.expires_at = new Date(Date.now() - 1_000).toISOString();

    const outcome = await resumeFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      checkpointId: row.id as string,
      answer: '483920',
      transport,
      logger: silent,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('venció');
    // Y queda marcada como vencida, no como abierta para siempre.
    expect(checkpointRow(store).state).toBe('expired');
    expect(transport.resumes.length).toBe(0);
  });

  it('no pierde nada: reanudar no vuelve a correr los pasos ya hechos', async () => {
    const store = baseStore();
    const { transport } = await pause(store);
    await resumeFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      checkpointId: checkpointRow(store).id as string,
      answer: '483920',
      transport,
      logger: silent,
    });
    // Una sola llamada a /replay en toda la historia. El resto fue /continue.
    expect(transport.calls.length).toBe(1);
    expect(transport.resumes.length).toBe(1);
  });
});

describe('la ventana de una pausa', () => {
  const at = (ms: number): Checkpoint => ({
    id: 'c',
    flowId: 'f',
    runId: 'r',
    sessionId: 's',
    reason: 'input-needed',
    ask: '',
    fills: 'codigo',
    fromIndex: 1,
    inputs: {},
    errandId: null,
    errandQuestionId: null,
    state: 'open',
    expiresAt: new Date(Date.now() + ms).toISOString(),
    createdAt: new Date().toISOString(),
  });

  it('deja de servir un poco ANTES de la hora, no justo en ella', () => {
    // Entre leer la fila y llegar al servicio hay una petición HTTP. Sin el
    // margen, la persona recibe «esa sesión ya no existe» un segundo después
    // de que la pantalla le ofreciera el botón.
    expect(isLive(at(60_000))).toBe(true);
    expect(isLive(at(2_000))).toBe(false);
    expect(isLive(at(-1))).toBe(false);
  });

  it('una pausa ya cerrada no revive por tener hora de sobra', () => {
    expect(isLive({ ...at(60_000), state: 'resumed' })).toBe(false);
  });

  it('cuenta lo que queda para poder decirlo, y nunca en negativo', () => {
    expect(secondsLeft(at(120_000))).toBeGreaterThan(110);
    expect(secondsLeft(at(-50_000))).toBe(0);
  });
});

/** Las columnas que `getFlow` vuelve a leer cuando se retoma una pausa. */
function flowRowOf(flow: ReturnType<typeof makeFlow>): Row {
  return {
    slug: flow.slug,
    name: flow.name,
    description: flow.description,
    start_url: flow.startUrl,
    host: flow.host,
    effect: flow.effect,
    status: flow.status,
    source: flow.source,
    credential_id: null,
    login_required: false,
    errand_allowed: false,
    variables: flow.variables,
    steps: flow.steps,
    version: flow.version,
    verified_at: flow.verifiedAt,
    repairs_in_window: 0,
    repair_window_started_at: null,
    last_run_at: null,
    last_run_status: null,
    last_error: null,
    recording_frames: 0,
    extraction_cost_usd: 0,
    created_by: USER,
    created_at: flow.createdAt,
    updated_at: flow.updatedAt,
  };
}
