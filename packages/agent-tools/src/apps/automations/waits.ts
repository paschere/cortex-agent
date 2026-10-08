import type { SupabaseClient } from '@supabase/supabase-js';
import { closeCheckpoint, getCheckpoint, isLive } from '../../browser/checkpoint';
import { getFlow, getFlowBySlug } from '../../browser/store';

/**
 * AUTOMATIZACIONES QUE ESPERAN A UNA PERSONA (migración 0214).
 *
 * Una automatización corre sin nadie delante. Cuando «Pedirle algo a Cortex»
 * ejecuta un trámite aprendido (browser.run_flow) y el portal se detiene —el
 * código que llegó al celular, un captcha, o la sesión del perfil venció— no
 * hay a quién preguntarle en el momento. Lo que se hace, igual para CUALQUIER
 * trámite:
 *
 *   1. la corrida pasa a `waiting_person` (no falla, no se reintenta a ciegas);
 *   2. se le avisa a la persona que puede resolverlo (campana, push y correo)
 *      con un enlace a la pantalla donde se resuelve;
 *   3. cuando se resuelve, la corrida vuelve a la cola y la automatización
 *      CONTINÚA: el modelo recibe lo que devolvió el trámite (`result`) y
 *      escribe en la fila según su instrucción;
 *   4. si nadie lo atiende a tiempo (2 h por defecto), la corrida queda
 *      `unresolved` («sin resolver») y se avisa.
 *
 * LO QUE NUNCA SE AUTOMATIZA: el captcha. Lo resuelve la persona en la pestaña
 * viva; aquí sólo se espera a que el trámite retomado termine.
 *
 * IDEMPOTENTE. Una sola espera abierta por (corrida × acción); resolver o vencer
 * es un UPDATE condicionado a `state = 'waiting'`, de modo que dos barridos (o
 * un barrido y la persona) producen UNA reanudación.
 *
 * QUIÉN PUEDE RESOLVER. La pestaña del navegador pertenece a quien corrió el
 * trámite (la persona que creó la regla): sólo ella puede teclear el código o
 * hacer el clic. Si hay que volver a iniciar sesión, el aviso va al dueño del
 * perfil (o, si no se sabe, a quien creó la regla).
 */

export const WAIT_TTL_MS = 2 * 60 * 60_000;
/** Cuántas pausas seguidas admite una misma acción antes de rendirse. */
export const MAX_WAITS_PER_ACTION = 3;
/** Cuánto se espera a que un trámite ya retomado termine antes de darlo por perdido. */
const RESUME_GRACE_MS = 8 * 60_000;

export type WaitKind = 'checkpoint' | 'login';
export type WaitState = 'waiting' | 'resolved' | 'unresolved';

/** Lo que se sabe de la pausa al detectarla (sin tocar la base de datos de las esperas). */
export interface WaitInfo {
  kind: WaitKind;
  flowSlug: string;
  flowName: string;
  checkpointId: string | null;
  /** La pregunta del trámite, en sus palabras. */
  ask: string;
  /** Dueño del perfil del trámite, para el aviso de volver a iniciar sesión. */
  profileOwnerId: string | null;
}

/** La señal con que una acción cuenta que quedó esperando a una persona. */
export class WaitingForPersonError extends Error {
  constructor(readonly info: WaitInfo) {
    super(`Esperando a una persona: ${info.ask || info.flowName}`);
    this.name = 'WaitingForPersonError';
  }
}

export interface WaitRow {
  id: string;
  organization_id: string;
  app_id: string;
  automation_id: string;
  run_id: string;
  action_index: number;
  kind: WaitKind;
  checkpoint_id: string | null;
  flow_slug: string;
  flow_name: string;
  ask: string;
  notify_user_id: string | null;
  state: WaitState;
  expires_at: string;
  created_at: string;
  resolved_at: string | null;
  outcome: WaitOutcome | null;
  reason: string | null;
}

/** Lo que devolvió el trámite al resolverse la espera. */
export interface WaitOutcome {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
  note?: string;
}

const WAIT_COLUMNS =
  'id, organization_id, app_id, automation_id, run_id, action_index, kind, checkpoint_id, flow_slug, flow_name, ask, notify_user_id, state, expires_at, created_at, resolved_at, outcome, reason';

/* ---------------------------------------------------------------------------
 * 1. Detectar la pausa en lo que devolvió browser.run_flow
 * -------------------------------------------------------------------------*/

interface RunFlowOutput {
  ok?: boolean;
  flow?: string;
  pausedAt?: string | null;
  asks?: string | null;
  failureKind?: string | null;
  message?: string;
}

async function profileOwnerOf(
  db: SupabaseClient,
  profileId: string | null | undefined,
): Promise<string | null> {
  if (!profileId) return null;
  const { data } = await db
    .from('browser_profiles')
    .select('owner_id')
    .eq('id', profileId)
    .maybeSingle();
  return ((data as { owner_id?: string } | null)?.owner_id as string | undefined) ?? null;
}

/**
 * ¿Lo que devolvió browser.run_flow es «me detuve a esperar a una persona»?
 * Devuelve la información de la espera, o null si el trámite corrió normal o
 * falló por otra causa (esas siguen su camino de siempre).
 */
export async function waitFromRunFlow(
  db: SupabaseClient,
  output: unknown,
): Promise<WaitInfo | null> {
  if (!output || typeof output !== 'object') return null;
  const out = output as RunFlowOutput;
  if (out.ok) return null;

  if (typeof out.pausedAt === 'string' && out.pausedAt) {
    const checkpoint = await getCheckpoint(db, out.pausedAt).catch(() => null);
    if (!checkpoint) return null;
    const flow = await getFlow(db, checkpoint.flowId).catch(() => null);
    return {
      kind: 'checkpoint',
      flowSlug: flow?.slug ?? out.flow ?? '',
      flowName: flow?.name ?? out.flow ?? 'trámite',
      checkpointId: checkpoint.id,
      ask: (out.asks ?? checkpoint.ask ?? '').slice(0, 600),
      profileOwnerId: await profileOwnerOf(db, flow?.profileId),
    };
  }

  if (out.failureKind === 'needs-login' && out.flow) {
    const flow = await getFlowBySlug(db, out.flow).catch(() => null);
    if (!flow) return null;
    return {
      kind: 'login',
      flowSlug: flow.slug,
      flowName: flow.name,
      checkpointId: null,
      ask: `El portal de «${flow.name}» pide iniciar sesión otra vez. Abre el perfil del trámite, entra al portal y avisa cuando esté lista la sesión.`,
      profileOwnerId: await profileOwnerOf(db, flow.profileId),
    };
  }
  return null;
}

/* ---------------------------------------------------------------------------
 * 2. Abrir la espera
 * -------------------------------------------------------------------------*/

export interface OpenWaitInput {
  organizationId: string;
  appId: string;
  automationId: string;
  runId: string;
  actionIndex: number;
  info: WaitInfo;
  /** A quién se le avisa y quién puede resolverla. */
  recipientId: string | null;
  now: Date;
}

export async function openWait(
  db: SupabaseClient,
  input: OpenWaitInput,
): Promise<{ wait: WaitRow; created: boolean }> {
  const { count } = await db
    .from('custom_app_automation_waits')
    .select('id', { count: 'exact', head: true })
    .eq('run_id', input.runId)
    .eq('action_index', input.actionIndex);
  const { data: open } = await db
    .from('custom_app_automation_waits')
    .select(WAIT_COLUMNS)
    .eq('run_id', input.runId)
    .eq('action_index', input.actionIndex)
    .eq('state', 'waiting')
    .maybeSingle();
  if (open) return { wait: open as unknown as WaitRow, created: false };
  if ((count ?? 0) >= MAX_WAITS_PER_ACTION)
    throw new Error(
      `El trámite «${input.info.flowName}» se detuvo ${MAX_WAITS_PER_ACTION} veces seguidas esperando a una persona; la corrida no insiste más.`,
    );

  const { data, error } = await db
    .from('custom_app_automation_waits')
    .insert({
      app_id: input.appId,
      automation_id: input.automationId,
      run_id: input.runId,
      action_index: input.actionIndex,
      kind: input.info.kind,
      checkpoint_id: input.info.checkpointId,
      flow_slug: input.info.flowSlug.slice(0, 120),
      flow_name: input.info.flowName.slice(0, 200),
      ask: input.info.ask,
      notify_user_id: input.recipientId,
      state: 'waiting',
      expires_at: new Date(input.now.getTime() + WAIT_TTL_MS).toISOString(),
    })
    .select(WAIT_COLUMNS)
    .single();
  if (error || !data) {
    // Otra corrida del barrido la abrió justo antes: vale la que ya está.
    const { data: again } = await db
      .from('custom_app_automation_waits')
      .select(WAIT_COLUMNS)
      .eq('run_id', input.runId)
      .eq('action_index', input.actionIndex)
      .eq('state', 'waiting')
      .maybeSingle();
    if (again) return { wait: again as unknown as WaitRow, created: false };
    throw new Error('No se pudo dejar la corrida esperando a una persona.');
  }
  return { wait: data as unknown as WaitRow, created: true };
}

/** La última espera ya resuelta de esta acción (o null): lo que la reanudación debe usar. */
export async function latestResolvedWait(
  db: SupabaseClient,
  runId: string,
  actionIndex: number,
): Promise<WaitRow | null> {
  const { data } = await db
    .from('custom_app_automation_waits')
    .select(WAIT_COLUMNS)
    .eq('run_id', runId)
    .eq('action_index', actionIndex)
    .eq('state', 'resolved')
    .order('resolved_at', { ascending: false })
    .limit(1);
  const row = ((data as unknown[]) ?? [])[0];
  return row ? (row as WaitRow) : null;
}

/** El párrafo que se le agrega al pedido cuando la acción se reanuda tras una espera resuelta. */
export function resumedPromptBlock(wait: WaitRow | null): string | null {
  if (!wait?.outcome) return null;
  const o = wait.outcome;
  if (wait.kind === 'login')
    return `REANUDACIÓN: el trámite «${wait.flow_name}» (${wait.flow_slug}) pidió volver a iniciar sesión y la persona ya lo hizo. Vuelve a correrlo UNA vez con browser_run_flow y sigue la instrucción con lo que devuelva.`;
  if (!o.ok)
    return `REANUDACIÓN: el trámite «${wait.flow_name}» (${wait.flow_slug}) se detuvo a esperar a una persona, ella lo atendió, pero el trámite no pudo terminar: ${o.error ?? 'sin detalle'}. NO lo vuelvas a correr; dilo en el informe y no escribas datos que dependan de él.`;
  return `REANUDACIÓN: el trámite «${wait.flow_name}» (${wait.flow_slug}) se detuvo a esperar a una persona, ella lo resolvió y terminó. NO lo vuelvas a correr. Su resultado (result) es:\n${JSON.stringify(o.result ?? {}).slice(0, 4000)}\nUsa estos valores para cumplir la instrucción de arriba.`;
}

/* ---------------------------------------------------------------------------
 * 3. Avisar
 * -------------------------------------------------------------------------*/

/** Lo que el aviso necesita de la app web; es el mismo subconjunto de `AutomationDeps`. */
export interface WaitNotifier {
  baseUrl: string;
  sendEmail(input: { to: string; subject: string; text: string }): Promise<{
    sent: boolean;
    reason?: string;
  }>;
  notifyMembers(
    db: SupabaseClient,
    userIds: string[],
    note: { appId: string; title: string; body?: string; href: string; dedupeKey: string },
  ): Promise<number>;
}

export function waitPath(waitId: string): string {
  return `/browser/espera/${waitId}`;
}

async function emailOf(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await db.from('users').select('email').eq('id', userId).maybeSingle();
  return ((data as { email?: string } | null)?.email as string | undefined) ?? null;
}

async function tell(
  db: SupabaseClient,
  deps: WaitNotifier,
  wait: WaitRow,
  note: { title: string; body: string; key: string; subject?: string },
  appName: string,
): Promise<void> {
  if (!wait.notify_user_id) return;
  const path = waitPath(wait.id);
  await deps
    .notifyMembers(db, [wait.notify_user_id], {
      appId: wait.app_id,
      title: note.title,
      body: note.body,
      href: path,
      dedupeKey: `appwait:${wait.id}:${note.key}`,
    })
    .catch(() => 0);
  const to = await emailOf(db, wait.notify_user_id).catch(() => null);
  if (to)
    await deps
      .sendEmail({
        to,
        subject: note.subject ?? note.title,
        text: `${note.body}\n\nÁbrelo aquí: ${deps.baseUrl}${path}\n\nAviso automático de «${appName}».`,
      })
      .catch(() => ({ sent: false }));
}

export async function notifyWaitOpened(
  db: SupabaseClient,
  deps: WaitNotifier,
  wait: WaitRow,
  appName: string,
): Promise<void> {
  const what =
    wait.kind === 'login'
      ? 'hay que volver a iniciar sesión en el portal'
      : wait.ask || 'necesita que lo atiendas (un código o una verificación)';
  await tell(
    db,
    deps,
    wait,
    {
      key: 'abierta',
      title: `«${wait.flow_name}» necesita una persona`,
      body: `Una automatización de «${appName}» consultaba un portal y se detuvo: ${what} Tienes hasta ${expiresText(wait.expires_at)} para resolverlo; después la corrida queda sin resolver.`,
    },
    appName,
  );
}

function expiresText(iso: string): string {
  const d = new Date(Date.parse(iso) - 5 * 3_600_000);
  return `las ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} (hora de Bogotá)`;
}

/* ---------------------------------------------------------------------------
 * 4. Resolver, vencer y barrer
 * -------------------------------------------------------------------------*/

/**
 * Cierra la espera y devuelve la corrida a la cola, UNA sola vez. Lo llaman el
 * barrido (trámite retomado) y la persona (volvió a iniciar sesión).
 */
export async function resolveWait(
  db: SupabaseClient,
  wait: WaitRow,
  outcome: WaitOutcome,
  now: Date,
): Promise<boolean> {
  const { data } = await db
    .from('custom_app_automation_waits')
    .update({ state: 'resolved', outcome, resolved_at: now.toISOString() })
    .eq('id', wait.id)
    .eq('state', 'waiting')
    .select('id');
  if (!((data as unknown[]) ?? []).length) return false;
  await db
    .from('custom_app_automation_runs')
    .update({ status: 'queued', next_attempt_at: now.toISOString(), error: null })
    .eq('id', wait.run_id)
    .eq('status', 'waiting_person');
  return true;
}

/** La espera no se resolvió: la corrida queda «sin resolver» y se avisa. */
export async function expireWait(
  db: SupabaseClient,
  deps: WaitNotifier,
  wait: WaitRow,
  reason: string,
  now: Date,
  appName = 'la aplicación',
): Promise<boolean> {
  const { data } = await db
    .from('custom_app_automation_waits')
    .update({ state: 'unresolved', reason, resolved_at: now.toISOString() })
    .eq('id', wait.id)
    .eq('state', 'waiting')
    .select('id');
  if (!((data as unknown[]) ?? []).length) return false;
  if (wait.checkpoint_id)
    await closeCheckpoint(db, wait.checkpoint_id, 'expired').catch(() => false);
  const message = `Sin resolver: ${reason}`.slice(0, 800);
  await db
    .from('custom_app_automation_runs')
    .update({
      status: 'unresolved',
      error: message,
      finished_at: now.toISOString(),
      next_attempt_at: null,
    })
    .eq('id', wait.run_id)
    .eq('status', 'waiting_person');
  await db
    .from('custom_app_automations')
    .update({ last_run_at: now.toISOString(), last_status: 'unresolved' })
    .eq('id', wait.automation_id);
  await tell(
    db,
    deps,
    wait,
    {
      key: 'vencida',
      title: `«${wait.flow_name}» quedó sin resolver`,
      body: `La automatización de «${appName}» no pudo seguir: ${reason}`,
    },
    appName,
  );
  return true;
}

interface FlowRunLite {
  status: string;
  failure_kind: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
}

/** ¿Qué hay que hacer con esta espera ahora? Pura dadas las lecturas. */
export type WaitVerdict =
  | { kind: 'keep' }
  | { kind: 'resolve'; outcome: WaitOutcome }
  | { kind: 'expire'; reason: string };

export function judgeWait(input: {
  wait: Pick<WaitRow, 'kind' | 'expires_at'>;
  now: Date;
  checkpoint: { state: string; live: boolean; resolvedAt: string | null } | null;
  flowRun: FlowRunLite | null;
}): WaitVerdict {
  const { wait, now, checkpoint, flowRun } = input;
  if (now.getTime() >= Date.parse(wait.expires_at))
    return { kind: 'expire', reason: 'nadie lo atendió a tiempo.' };
  // Volver a iniciar sesión sólo lo cierra la persona (o el vencimiento).
  if (wait.kind === 'login') return { kind: 'keep' };

  if (!checkpoint) return { kind: 'expire', reason: 'la pausa del trámite ya no existe.' };
  if (checkpoint.state === 'open')
    return checkpoint.live
      ? { kind: 'keep' }
      : {
          kind: 'expire',
          reason: 'la sesión del navegador venció antes de que alguien la atendiera.',
        };
  if (checkpoint.state !== 'resumed')
    return { kind: 'expire', reason: 'la pausa del trámite se canceló o venció.' };

  // Retomado: lo que importa es cómo terminó el trámite.
  if (!flowRun) return { kind: 'resolve', outcome: { ok: true, result: {}, note: 'sin registro' } };
  if (flowRun.status === 'succeeded')
    return { kind: 'resolve', outcome: { ok: true, result: flowRun.result ?? {} } };
  const inFlight = flowRun.status === 'failed' && flowRun.failure_kind === 'needs-human';
  if (inFlight) {
    const since = checkpoint.resolvedAt ? Date.parse(checkpoint.resolvedAt) : now.getTime();
    return now.getTime() - since > RESUME_GRACE_MS
      ? {
          kind: 'resolve',
          outcome: { ok: false, error: 'El trámite no terminó después de retomarlo.' },
        }
      : { kind: 'keep' };
  }
  if (flowRun.status === 'failed')
    return {
      kind: 'resolve',
      outcome: { ok: false, error: flowRun.error ?? 'El trámite falló después de retomarlo.' },
    };
  return { kind: 'keep' };
}

/**
 * El barrido de las esperas de UNA empresa: resuelve las que la persona ya
 * atendió, vence las que se acabaron. Lo llama el reloj de cada minuto.
 */
export async function sweepWaits(
  db: SupabaseClient,
  deps: WaitNotifier,
  now: Date,
): Promise<{ resolved: number; expired: number }> {
  const { data } = await db
    .from('custom_app_automation_waits')
    .select(WAIT_COLUMNS)
    .eq('state', 'waiting')
    .limit(200);
  let resolved = 0;
  let expired = 0;
  for (const wait of ((data as unknown[]) ?? []) as WaitRow[]) {
    let checkpoint: Parameters<typeof judgeWait>[0]['checkpoint'] = null;
    let flowRun: FlowRunLite | null = null;
    if (wait.kind === 'checkpoint' && wait.checkpoint_id) {
      const cp = await getCheckpoint(db, wait.checkpoint_id).catch(() => null);
      if (cp) {
        const { data: closed } = await db
          .from('browser_flow_checkpoints')
          .select('resolved_at')
          .eq('id', cp.id)
          .maybeSingle();
        checkpoint = {
          state: cp.state,
          live: isLive(cp, now.getTime()),
          resolvedAt: (closed as { resolved_at?: string } | null)?.resolved_at ?? null,
        };
        if (cp.state === 'resumed' && cp.runId) {
          const { data: row } = await db
            .from('browser_flow_runs')
            .select('status, failure_kind, error, result')
            .eq('id', cp.runId)
            .maybeSingle();
          flowRun = (row as FlowRunLite | null) ?? null;
        }
      }
    }
    const verdict = judgeWait({ wait, now, checkpoint, flowRun });
    if (verdict.kind === 'resolve') {
      if (await resolveWait(db, wait, verdict.outcome, now)) resolved += 1;
    } else if (verdict.kind === 'expire') {
      const { data: app } = await db
        .from('custom_apps')
        .select('name')
        .eq('id', wait.app_id)
        .maybeSingle();
      const appName = (app as { name?: string } | null)?.name ?? 'la aplicación';
      if (await expireWait(db, deps, wait, verdict.reason, now, appName)) expired += 1;
    }
  }
  return { resolved, expired };
}

/** Las empresas con esperas abiertas (con el cliente sin alcance, sólo ids). */
export async function orgsWithOpenWaits(raw: SupabaseClient): Promise<string[]> {
  const { data } = await raw
    .from('custom_app_automation_waits')
    .select('organization_id')
    .eq('state', 'waiting')
    .limit(1000);
  return [
    ...new Set(((data as Array<{ organization_id: string }>) ?? []).map((r) => r.organization_id)),
  ];
}

export async function getWait(db: SupabaseClient, id: string): Promise<WaitRow | null> {
  const { data } = await db
    .from('custom_app_automation_waits')
    .select(WAIT_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  return (data as WaitRow | null) ?? null;
}
