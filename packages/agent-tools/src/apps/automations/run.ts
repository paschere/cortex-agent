import { createHmac } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendRequest } from '../../custom-tools/http';
import { orgAdmins } from '../../directory/store';
import { getTrackerBySlug, upsertRow } from '../../trackers/store';
import type { CatalogTracker } from '../../views/spec';
import type { CustomAppRow } from '../store';
import { type EmitInput, queueRuns, withAutomationOrigin } from './emit';
import {
  APP_DAILY_ASK_CORTEX_CAP,
  APP_DAILY_RUN_CAP,
  MAX_ATTEMPTS,
  type TemplateContext,
  TransientActionError,
  backoffMs,
  evaluateConditions,
  isTransient,
  renderTemplate,
  renderValues,
} from './engine';
import type { AutomationEvent, Values } from './match';
import type { AutomationAction } from './spec';
import {
  AUTOMATION_COLUMNS,
  AUTOMATION_RUN_COLUMNS,
  type AutomationRow,
  type AutomationRunRow,
  adaptAutomation,
  adaptAutomationRun,
  runsToday,
} from './store';

/**
 * LA CORRIDA DE UNA AUTOMATIZACIÓN (migración 0210).
 *
 * `executeRun` reclama una corrida `queued` (un UPDATE condicionado: dos
 * trabajadores no la corren a la vez), la juzga (¿sigue encendida la regla?,
 * ¿está publicada la app?, ¿hay tope?, ¿se cumplen las condiciones?) y ejecuta
 * sus acciones en orden, guardando el resultado de CADA una apenas termina.
 * Eso es lo que hace seguros los reintentos: ante un error transitorio la
 * corrida vuelve a `queued` con espera, y al reintentar se SALTAN las acciones
 * que ya salieron bien (un correo no sale dos veces porque falló el webhook
 * que venía después).
 *
 * Los efectos que dependen de la app web (correo, campana, push, Cortex) llegan
 * por `AutomationDeps`: este paquete no puede importar Resend ni web-push. Así
 * también se prueba entero con dependencias falsas.
 *
 * AISLAMIENTO. Todo lee y escribe con el handle de la empresa de la corrida; los
 * usuarios de la app se buscan siempre con `app_id` de la regla, de modo que
 * `notify_app_user` nunca alcanza a alguien de otra app.
 */

export interface AskCortexArgs {
  organizationId: string;
  app: CustomAppRow;
  automation: AutomationRow;
  run: AutomationRunRow;
  instruction: string;
  tracker: { id: string; slug: string } | null;
  rowId: string | null;
  /** A quién se le piden las aprobaciones: quien creó la regla. */
  requesterId: string | null;
}

export interface AutomationDeps {
  now?: () => Date;
  /** https://… de la app, sin barra final. */
  baseUrl: string;
  /** Llave maestra para las firmas HMAC de los webhooks. */
  signingSecret: string;
  sendEmail(input: { to: string; subject: string; text: string }): Promise<{
    sent: boolean;
    reason?: string;
  }>;
  notifyMembers(
    db: SupabaseClient,
    userIds: string[],
    note: { appId: string; title: string; body?: string; href: string; dedupeKey: string },
  ): Promise<number>;
  /** Devuelve los ids de usuario de app a quienes les llegó un push. */
  pushAppUsers(
    db: SupabaseClient,
    appId: string,
    userIds: string[],
    payload: { title: string; body?: string; url: string; tag: string },
  ): Promise<string[]>;
  askCortex(db: SupabaseClient, args: AskCortexArgs): Promise<{ summary: string; staged: number }>;
}

interface ActionResult {
  index: number;
  type: string;
  ok: boolean;
  detail: string;
}

export type RunOutcome =
  | { status: 'not_claimable' }
  | { status: 'skipped'; reason: string }
  | { status: 'retry'; at: string }
  | { status: 'succeeded' | 'failed'; results: ActionResult[] };

/** La firma de un webhook: HMAC-SHA256 de «marca de tiempo.cuerpo» con una llave por regla. */
export function webhookSecretFor(masterSecret: string, automationId: string): string {
  return createHmac('sha256', masterSecret).update(`webhook:${automationId}`).digest('base64url');
}

export function signWebhook(secret: string, timestamp: string, body: string): string {
  return `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

const STALE_RUNNING_MS = 10 * 60_000;

/** Corridas que quedaron «running» (el proceso murió) vuelven a la cola. */
export async function releaseStaleRuns(db: SupabaseClient, now: Date): Promise<number> {
  const { data, error } = await db
    .from('custom_app_automation_runs')
    .update({ status: 'queued', next_attempt_at: now.toISOString() })
    .eq('status', 'running')
    .lt('started_at', new Date(now.getTime() - STALE_RUNNING_MS).toISOString())
    .select('id');
  if (error) return 0;
  return (data ?? []).length;
}

async function finish(
  db: SupabaseClient,
  run: AutomationRunRow,
  automationId: string,
  patch: {
    status: 'succeeded' | 'failed' | 'skipped';
    error?: string | null;
    result?: ActionResult[];
    askCalls?: number;
  },
  now: Date,
) {
  await db
    .from('custom_app_automation_runs')
    .update({
      status: patch.status,
      error: patch.error ?? null,
      ...(patch.result ? { result: patch.result } : {}),
      ...(patch.askCalls !== undefined ? { ask_cortex_calls: patch.askCalls } : {}),
      finished_at: now.toISOString(),
      next_attempt_at: null,
    })
    .eq('id', run.id);
  await db
    .from('custom_app_automations')
    .update({ last_run_at: now.toISOString(), last_status: patch.status })
    .eq('id', automationId);
}

export async function executeRun(
  db: SupabaseClient,
  runId: string,
  organizationId: string,
  deps: AutomationDeps,
): Promise<RunOutcome> {
  const now = (deps.now ?? (() => new Date()))();

  // 1. Reclamar. Sólo una corrida en cola y ya vencida su espera.
  const { data: claimedRows, error: claimError } = await db
    .from('custom_app_automation_runs')
    .update({ status: 'running', started_at: now.toISOString() })
    .eq('id', runId)
    .eq('status', 'queued')
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${now.toISOString()}`)
    .select(`${AUTOMATION_RUN_COLUMNS}, event, idempotency_key`);
  if (claimError) throw claimError;
  const claimedRaw = (claimedRows ?? [])[0] as Record<string, unknown> | undefined;
  if (!claimedRaw) return { status: 'not_claimable' };
  const run = adaptAutomationRun(claimedRaw);
  const event = claimedRaw.event as AutomationEvent;
  const idempotencyKeyOfRun = String(claimedRaw.idempotency_key);
  const attempt = run.attempts + 1;
  await db.from('custom_app_automation_runs').update({ attempts: attempt }).eq('id', run.id);

  // 2. ¿Sigue vigente la regla?
  const { data: autoRow } = await db
    .from('custom_app_automations')
    .select(AUTOMATION_COLUMNS)
    .eq('id', run.automation_id)
    .maybeSingle();
  if (!autoRow) {
    await finish(
      db,
      run,
      run.automation_id,
      { status: 'skipped', error: 'La regla ya no existe.' },
      now,
    );
    return { status: 'skipped', reason: 'La regla ya no existe.' };
  }
  const automation = adaptAutomation(autoRow as Record<string, unknown>);
  if (!automation.enabled) {
    await finish(
      db,
      run,
      automation.id,
      { status: 'skipped', error: 'La regla está pausada.' },
      now,
    );
    return { status: 'skipped', reason: 'pausada' };
  }
  const { data: appRow } = await db
    .from('custom_apps')
    .select('id, slug, name, icon, status, archived_at')
    .eq('id', automation.app_id)
    .maybeSingle();
  const app = appRow as {
    id: string;
    slug: string;
    name: string;
    status: string;
    archived_at: string | null;
  } | null;
  if (!app || app.archived_at || app.status !== 'published') {
    const reason = 'La app no está publicada.';
    await finish(db, run, automation.id, { status: 'skipped', error: reason }, now);
    return { status: 'skipped', reason };
  }

  // 3. Topes por app y por día (contados en el plan: una corrida = una fila).
  const used = await runsToday(db, app.id, now);
  if (used.runs > APP_DAILY_RUN_CAP) {
    const reason = `La app llegó al tope de ${APP_DAILY_RUN_CAP} corridas por día.`;
    await finish(db, run, automation.id, { status: 'skipped', error: reason }, now);
    return { status: 'skipped', reason };
  }

  // 4. La tabla, la fila y las condiciones.
  const trackerSlug = 'tracker' in automation.trigger ? automation.trigger.tracker : null;
  const trackerRow = trackerSlug ? await getTrackerBySlug(db, trackerSlug) : null;
  const tracker: CatalogTracker | null = trackerRow
    ? { slug: trackerRow.slug, name: trackerRow.name, fields: trackerRow.fields }
    : null;
  const conditions = evaluateConditions(automation.conditions, event, tracker, now);
  if (!conditions.ok) {
    const reason = `No se cumplió: ${conditions.failed}.`;
    await finish(db, run, automation.id, { status: 'skipped', error: reason }, now);
    return { status: 'skipped', reason };
  }

  const screenForLink =
    event.screen ??
    ('screen' in automation.trigger
      ? (automation.trigger.screen as string | undefined)
      : undefined);
  const link = `${deps.baseUrl}/a/${app.id}${screenForLink ? `/${screenForLink}` : ''}`;
  const ctx: TemplateContext = {
    after: (event.after ?? {}) as Values,
    before: event.before ?? null,
    label: event.label,
    appName: app.name,
    link,
    reason: event.reason,
    labels: trackerRow ? Object.fromEntries(trackerRow.fields.map((f) => [f.key, f.label])) : {},
  };

  // 5. Las acciones, una a una, con su resultado guardado.
  const results: ActionResult[] = Array.isArray(run.result) ? [...run.result] : [];
  let askCalls = run.ask_cortex_calls;
  let transientFailure: string | null = null;
  const origin = { chain: [...(event.chain ?? []), automation.id], depth: (event.depth ?? 0) + 1 };

  for (let index = 0; index < automation.actions.length; index++) {
    if (results.some((r) => r.index === index && r.ok)) continue;
    const action = automation.actions[index] as AutomationAction;
    try {
      const detail = await withAutomationOrigin(origin, () =>
        runAction({
          db,
          organizationId,
          deps,
          app: app as unknown as CustomAppRow,
          automation,
          run,
          runKey: idempotencyKeyOfRun,
          event,
          ctx,
          action,
          index,
          trackerRow,
          askAllowed: used.askCortex + askCalls < APP_DAILY_ASK_CORTEX_CAP,
          onAsk: () => {
            askCalls += 1;
          },
        }),
      );
      upsertResult(results, { index, type: action.type, ok: true, detail });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isTransient(err) && attempt < MAX_ATTEMPTS) {
        transientFailure = message;
        upsertResult(results, {
          index,
          type: action.type,
          ok: false,
          detail: `Reintentando: ${message}`,
        });
        break;
      }
      upsertResult(results, { index, type: action.type, ok: false, detail: message });
    }
  }

  if (transientFailure) {
    const at = new Date(now.getTime() + backoffMs(attempt)).toISOString();
    await db
      .from('custom_app_automation_runs')
      .update({
        status: 'queued',
        next_attempt_at: at,
        error: transientFailure,
        result: results,
        ask_cortex_calls: askCalls,
      })
      .eq('id', run.id);
    return { status: 'retry', at };
  }

  const failed = results.filter((r) => !r.ok);
  const status = failed.length ? 'failed' : 'succeeded';
  await finish(
    db,
    run,
    automation.id,
    {
      status,
      error: failed.length
        ? failed
            .map((f) => `${f.type}: ${f.detail}`)
            .join(' · ')
            .slice(0, 800)
        : null,
      result: results,
      askCalls,
    },
    now,
  );
  return { status, results };
}

function upsertResult(list: ActionResult[], r: ActionResult) {
  const i = list.findIndex((x) => x.index === r.index);
  if (i >= 0) list[i] = r;
  else list.push(r);
}

interface ActionRun {
  db: SupabaseClient;
  organizationId: string;
  deps: AutomationDeps;
  app: CustomAppRow;
  automation: AutomationRow;
  run: AutomationRunRow;
  runKey: string;
  event: AutomationEvent;
  ctx: TemplateContext;
  action: AutomationAction;
  index: number;
  trackerRow: Awaited<ReturnType<typeof getTrackerBySlug>>;
  askAllowed: boolean;
  onAsk: () => void;
}

interface AppUserLite {
  id: string;
  name: string;
  email: string;
  role_key: string;
}

async function appUsers(
  db: SupabaseClient,
  appId: string,
  filter: { ids?: string[]; role?: string },
): Promise<AppUserLite[]> {
  // SIEMPRE con app_id: un usuario de otra app no es destinatario posible.
  let q = db
    .from('custom_app_users')
    .select('id, name, email, role_key')
    .eq('app_id', appId)
    .neq('status', 'disabled');
  if (filter.ids) q = q.in('id', filter.ids);
  if (filter.role) q = q.eq('role_key', filter.role);
  const { data, error } = await q.limit(200);
  if (error) throw error;
  return (data ?? []) as AppUserLite[];
}

async function currentRow(
  db: SupabaseClient,
  trackerId: string,
  rowId: string,
): Promise<{
  id: string;
  label: string;
  values: Values;
  created_by: string | null;
  created_by_app_user: string | null;
} | null> {
  const { data, error } = await db
    .from('tracker_rows')
    .select('id, label, values, created_by, created_by_app_user')
    .eq('id', rowId)
    .eq('tracker_id', trackerId)
    .maybeSingle();
  if (error) throw error;
  return data as never;
}

async function runAction(a: ActionRun): Promise<string> {
  const { db, deps, app, automation, ctx, action, event } = a;
  const base = `${deps.baseUrl}/apps/${app.slug}`;
  switch (action.type) {
    case 'set_field': {
      if (!a.trackerRow || !event.rowId) throw new Error('Sin fila donde cambiar el campo.');
      const row = await currentRow(db, a.trackerRow.id, event.rowId);
      if (!row) throw new Error('La fila ya no existe.');
      const value =
        typeof action.value === 'number' ? action.value : renderTemplate(action.value, ctx);
      if (String(row.values[action.field] ?? '') === String(value))
        return `«${action.field}» ya estaba en «${value}».`;
      await upsertRow(db, {
        tracker: a.trackerRow,
        rowId: row.id,
        values: { ...row.values, [action.field]: value },
        userId: automation.created_by,
        only: new Set([action.field]),
      });
      return `«${action.field}» quedó en «${value}».`;
    }
    case 'create_row': {
      const target = await getTrackerBySlug(db, action.tracker);
      if (!target) throw new Error(`La tabla «${action.tracker}» ya no existe.`);
      const values = renderValues(action.values, ctx);
      const row = await upsertRow(db, {
        tracker: target,
        values,
        userId: automation.created_by,
      });
      return `Fila creada en «${target.name}» (${row.label}).`;
    }
    case 'notify_member': {
      const ids = new Set<string>(action.members);
      if (action.roles.length) {
        const { data, error } = await db
          .from('custom_app_members')
          .select('user_id')
          .eq('app_id', app.id)
          .in('role_key', action.roles);
        if (error) throw error;
        for (const m of (data ?? []) as Array<{ user_id: string }>) ids.add(m.user_id);
      }
      if (action.admins) for (const id of await orgAdmins(db, 20)) ids.add(id);
      if (!ids.size) return 'No había a quién avisar.';
      // Sólo miembros de ESTA empresa: el handle ya está acotado, y `users` es tenant.
      const { data: people, error } = await db
        .from('users')
        .select('id')
        .in('id', [...ids]);
      if (error) throw error;
      const valid = ((people ?? []) as Array<{ id: string }>).map((p) => p.id);
      const n = await deps.notifyMembers(db, valid, {
        appId: app.id,
        title: renderTemplate(action.title, ctx),
        body: action.body ? renderTemplate(action.body, ctx) : undefined,
        href: base,
        dedupeKey: `appauto:${a.runKey}:${a.index}`.slice(0, 190),
      });
      return `Campana a ${n} persona${n === 1 ? '' : 's'}.`;
    }
    case 'notify_app_user': {
      let recipients: AppUserLite[] = [];
      let memberCreator: string | null = null;
      if (action.to === 'creator') {
        if (!a.trackerRow || !event.rowId) throw new Error('Sin fila de donde sacar al creador.');
        const row = await currentRow(db, a.trackerRow.id, event.rowId);
        if (row?.created_by_app_user)
          recipients = await appUsers(db, app.id, { ids: [row.created_by_app_user] });
        else if (row?.created_by) memberCreator = row.created_by;
      } else {
        recipients = await appUsers(db, app.id, { role: action.to.role });
      }
      const title = renderTemplate(action.title, ctx);
      const body = action.body ? renderTemplate(action.body, ctx) : undefined;
      const url = `/a/${app.id}${action.screen ? `/${action.screen}` : ''}`;
      const pushed = recipients.length
        ? await deps.pushAppUsers(
            db,
            app.id,
            recipients.map((r) => r.id),
            {
              title,
              body,
              url,
              tag: `appauto:${automation.id}`,
            },
          )
        : [];
      const pushedSet = new Set(pushed);
      let mailed = 0;
      for (const r of recipients) {
        if (pushedSet.has(r.id)) continue;
        const out = await deps.sendEmail({
          to: r.email,
          subject: title,
          text: `${body ? `${body}\n\n` : ''}Ábrelo aquí: ${deps.baseUrl}${url}\n\nAviso automático de «${app.name}».`,
        });
        if (out.sent) mailed += 1;
        else if (out.reason && /429|5\d\d|timeout/i.test(out.reason))
          throw new TransientActionError(out.reason);
      }
      let belled = 0;
      if (memberCreator)
        belled = await deps.notifyMembers(db, [memberCreator], {
          appId: app.id,
          title,
          body,
          href: base,
          dedupeKey: `appauto:${a.runKey}:${a.index}`.slice(0, 190),
        });
      return `Push a ${pushed.length}, correo a ${mailed}${belled ? `, campana a ${belled}` : ''}${
        recipients.length - pushed.length - mailed > 0
          ? `; ${recipients.length - pushed.length - mailed} sin canal`
          : ''
      }.`;
    }
    case 'email': {
      const targets = new Set(action.to);
      if (action.roles.length)
        for (const role of action.roles)
          for (const u of await appUsers(db, app.id, { role })) targets.add(u.email.toLowerCase());
      const list = [...targets].slice(0, 50);
      if (!list.length) return 'No había a quién escribirle.';
      const subject = renderTemplate(action.subject, ctx);
      const text = `${renderTemplate(action.body, ctx)}\n\n—\nAviso automático de «${app.name}».`;
      let sent = 0;
      let lastReason = '';
      for (const to of list) {
        const out = await deps.sendEmail({ to, subject, text });
        if (out.sent) sent += 1;
        else lastReason = out.reason ?? 'no se envió';
      }
      if (!sent) throw new Error(`Ningún correo salió (${lastReason}).`);
      return `Correo a ${sent} de ${list.length}.`;
    }
    case 'webhook': {
      const body = JSON.stringify({
        automation: { id: automation.id, name: automation.name },
        app: { id: app.id, slug: app.slug, name: app.name },
        event: { kind: event.kind, at: event.version, id: a.runKey },
        row: event.rowId
          ? {
              id: event.rowId,
              label: event.label ?? '',
              values: event.after ?? {},
              before: event.before ?? null,
            }
          : null,
      });
      const ts = String(Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000));
      const secret = webhookSecretFor(deps.signingSecret, automation.id);
      const out = await sendRequest(
        {
          method: 'POST',
          url: action.url,
          headers: {
            'content-type': 'application/json',
            'x-cortex-timestamp': ts,
            'x-cortex-signature': signWebhook(secret, ts, body),
            'x-cortex-event-id': a.runKey,
          },
          body,
        },
        // Sólo https, nada de redirecciones, y cada destino se resuelve y se
        // compara contra rangos privados (las protecciones de las herramientas
        // personalizadas: custom-tools/guard.ts).
        { timeoutMs: 8000, maxBytes: 32_000, allowInsecureHttp: false, followRedirects: false },
      );
      if (!out.ok) {
        if (out.cause === 'timeout' || out.cause === 'network')
          throw new TransientActionError(out.error);
        if (out.cause === 'blocked')
          throw new Error(
            'Destino no permitido: el webhook sólo acepta https hacia direcciones públicas (nunca direcciones internas ni redirecciones).',
          );
        throw new Error(out.error);
      }
      const status = out.response.status;
      if (status === 429 || status >= 500)
        throw new TransientActionError(`El destino contestó ${status}.`);
      if (status >= 400) throw new Error(`El destino rechazó el aviso (${status}).`);
      return `POST firmado a ${new URL(action.url).host}: ${status}.`;
    }
    case 'ask_cortex': {
      if (!a.askAllowed)
        throw new Error(
          `La app llegó al tope de ${APP_DAILY_ASK_CORTEX_CAP} pedidos a Cortex por día.`,
        );
      a.onAsk();
      const out = await deps.askCortex(db, {
        organizationId: a.organizationId,
        app,
        automation,
        run: a.run,
        instruction: renderTemplate(action.instruction, ctx),
        tracker: a.trackerRow ? { id: a.trackerRow.id, slug: a.trackerRow.slug } : null,
        rowId: event.rowId ?? null,
        requesterId: automation.created_by,
      });
      return `${out.summary}${out.staged ? ` (${out.staged} pendiente${out.staged === 1 ? '' : 's'} de aprobación)` : ''}`;
    }
  }
}

/**
 * Un botón de acción manual: la persona lo toca en una pantalla y se encola una
 * corrida de la regla. El llamador (la capa web) ya comprobó que la pantalla es
 * de la app y que el rol la ve. Se deduplica por persona en ventanas de 30 s.
 */
export async function fireButton(
  db: SupabaseClient,
  input: {
    automation: AutomationRow;
    screen: string;
    actor: { kind: 'member' | 'app_user'; id: string };
    now?: Date;
  },
): Promise<{ queued: boolean }> {
  const t = input.automation.trigger;
  if (!input.automation.enabled || t.type !== 'button' || t.screen !== input.screen)
    return { queued: false };
  const now = input.now ?? new Date();
  const event: AutomationEvent = {
    kind: 'button',
    version: `${input.actor.id}:${Math.floor(now.getTime() / 30_000)}`,
    actor: input.actor,
    screen: input.screen,
    buttonId: t.id,
    chain: [],
    depth: 0,
  };
  const n = await queueRuns(
    db,
    [{ id: input.automation.id, app_id: input.automation.app_id }],
    event,
    `button:${t.id}`,
  );
  return { queued: n > 0 };
}

/** Una franja de horario: un evento por regla y franja (la clave lo hace único). */
export async function queueScheduled(
  db: SupabaseClient,
  automation: { id: string; app_id: string },
  slot: Date,
): Promise<number> {
  const event: AutomationEvent = {
    kind: 'schedule',
    version: slot.toISOString(),
    actor: { kind: 'system' },
    chain: [],
    depth: 0,
  };
  return queueRuns(db, [automation], event, `slot:${slot.toISOString()}`);
}

export type { EmitInput };
