'use client';

import {
  type AutomationView,
  type RunView,
  createFromTemplateAction,
  deleteAutomationAction,
  loadAutomationsAction,
  loadRunsAction,
  saveAutomationAction,
  testAutomationAction,
  toggleAutomationAction,
} from '@/lib/apps/automation-actions';
import { clsx } from 'clsx';
import { BellOff, History, Pause, Play, Plus, Trash2, Zap } from 'lucide-react';
import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  ErrorLine,
  INPUT,
} from './shared';

/**
 * LA PESTAÑA «AUTOMATIZACIONES» DEL EDITOR (0210).
 *
 * Cada regla se lee como una frase: CUANDO pasa algo, SI se cumple esto,
 * ENTONCES haz aquello. Se crea desde una plantilla o en blanco, se prueba con
 * una fila de ejemplo (simulación: dice qué haría y no hace NADA), se pausa sin
 * perder el historial y su historial muestra cada corrida con sus errores.
 *
 * Los datos de las reglas se piden al servidor al abrir la pestaña (no viajan en
 * la página del editor) y todo cambio es una acción de servidor que valida la
 * regla contra la app y las tablas reales. Aquí sólo se dibuja el formulario.
 */

type Row = AppEditorData['trackers'][number];

interface Cond {
  kind: 'filter' | 'changed';
  field: string;
  op: string;
  value: string;
  from: string;
  to: string;
}

interface Act {
  type: string;
  field: string;
  value: string;
  tracker: string;
  pairs: Array<{ key: string; value: string }>;
  members: string[];
  roles: string[];
  admins: boolean;
  title: string;
  body: string;
  toKind: 'creator' | 'role';
  role: string;
  screen: string;
  emails: string;
  subject: string;
  url: string;
  instruction: string;
}

interface Draft {
  name: string;
  trigger: {
    type: string;
    tracker: string;
    field: string;
    to: string;
    screen: string;
    block: string;
    decision: string;
    cadence: string;
    hour: number;
    weekday: number;
    id: string;
    label: string;
  };
  conditions: Cond[];
  actions: Act[];
}

const TRIGGERS: Array<{ type: string; label: string }> = [
  { type: 'row_created', label: 'Se crea una fila' },
  { type: 'row_updated', label: 'Cambia una fila' },
  { type: 'row_flagged_duplicate', label: 'Una fila queda marcada como duplicada' },
  { type: 'form_submitted', label: 'Se envía un formulario' },
  { type: 'approval_decided', label: 'Se aprueba o se rechaza' },
  { type: 'schedule', label: 'A una hora (diaria o semanal)' },
  { type: 'button', label: 'Alguien toca un botón en una pantalla' },
];
const HOURS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
];
const ROWLESS = new Set(['schedule', 'button']);

const ACTIONS: Array<{ type: string; label: string }> = [
  { type: 'notify_app_user', label: 'Avisar a usuarios de la app (push o correo)' },
  { type: 'notify_member', label: 'Avisar al equipo (campana y push)' },
  { type: 'email', label: 'Mandar un correo' },
  { type: 'set_field', label: 'Cambiar un campo de la fila' },
  { type: 'create_row', label: 'Crear una fila en otra tabla' },
  { type: 'webhook', label: 'Llamar a otro sistema (webhook firmado)' },
  { type: 'ask_cortex', label: 'Pedirle algo a Cortex' },
];

const OPS: Array<{ op: string; label: string; needsValue: boolean }> = [
  { op: 'eq', label: 'es igual a', needsValue: true },
  { op: 'neq', label: 'es distinto de', needsValue: true },
  { op: 'contains', label: 'contiene', needsValue: true },
  { op: 'gt', label: 'es mayor que', needsValue: true },
  { op: 'gte', label: 'es mayor o igual que', needsValue: true },
  { op: 'lt', label: 'es menor que', needsValue: true },
  { op: 'lte', label: 'es menor o igual que', needsValue: true },
  { op: 'empty', label: 'está vacío', needsValue: false },
  { op: 'not_empty', label: 'tiene valor', needsValue: false },
];

const TEMPLATES = [
  {
    id: 'duplicate_to_supervisor',
    name: 'Avisar al supervisor cuando haya un duplicado',
    needs: ['tracker', 'role'],
  },
  { id: 'rejected_to_operator', name: 'Avisar al operario si le rechazan', needs: ['tracker'] },
  { id: 'daily_summary', name: 'Resumen diario a gerencia', needs: ['role'] },
  {
    id: 'approved_to_dispatched',
    name: 'Pasar a «Despachada» cuando se apruebe',
    needs: ['tracker', 'field', 'value'],
  },
] as const;

const emptyAct = (type: string): Act => ({
  type,
  field: '',
  value: '',
  tracker: '',
  pairs: [{ key: '', value: '' }],
  members: [],
  roles: [],
  admins: false,
  title: '',
  body: '',
  toKind: 'role',
  role: '',
  screen: '',
  emails: '',
  subject: '',
  url: '',
  instruction: '',
});

const emptyDraft = (): Draft => ({
  name: '',
  trigger: {
    type: 'row_created',
    tracker: '',
    field: '',
    to: '',
    screen: '',
    block: '',
    decision: 'any',
    cadence: 'daily',
    hour: 7,
    weekday: 1,
    id: '',
    label: '',
  },
  conditions: [],
  actions: [emptyAct('notify_app_user')],
});

function slugOf(label: string): string {
  const base = label
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 31);
  return /^[a-z]/.test(base) ? base : `b_${base}`.slice(0, 31);
}

/** Del formulario a lo que el servidor valida. */
function toInput(d: Draft): unknown {
  const t = d.trigger;
  const trigger =
    t.type === 'row_updated'
      ? {
          type: t.type,
          tracker: t.tracker,
          ...(t.field ? { field: t.field } : {}),
          ...(t.to ? { to: t.to } : {}),
        }
      : t.type === 'form_submitted'
        ? {
            type: t.type,
            tracker: t.tracker,
            ...(t.screen ? { screen: t.screen } : {}),
            ...(t.block ? { block: t.block } : {}),
          }
        : t.type === 'approval_decided'
          ? { type: t.type, tracker: t.tracker, decision: t.decision }
          : t.type === 'schedule'
            ? {
                type: t.type,
                cadence: t.cadence,
                hour: Number(t.hour),
                ...(t.cadence === 'weekly' ? { weekday: Number(t.weekday) } : {}),
              }
            : t.type === 'button'
              ? { type: t.type, screen: t.screen, id: t.id || slugOf(t.label), label: t.label }
              : { type: t.type, tracker: t.tracker };
  const conditions = d.conditions.map((c) =>
    c.kind === 'changed'
      ? {
          type: 'changed',
          field: c.field,
          ...(c.from ? { from: c.from } : {}),
          ...(c.to ? { to: c.to } : {}),
        }
      : {
          field: c.field,
          op: c.op,
          ...(OPS.find((o) => o.op === c.op)?.needsValue
            ? {
                value:
                  Number.isFinite(Number(c.value)) &&
                  c.value.trim() !== '' &&
                  ['gt', 'gte', 'lt', 'lte'].includes(c.op)
                    ? Number(c.value)
                    : c.value,
              }
            : {}),
        },
  );
  const actions = d.actions.map((a) => {
    switch (a.type) {
      case 'set_field':
        return { type: a.type, field: a.field, value: a.value };
      case 'create_row':
        return {
          type: a.type,
          tracker: a.tracker,
          values: Object.fromEntries(a.pairs.filter((p) => p.key).map((p) => [p.key, p.value])),
        };
      case 'notify_member':
        return {
          type: a.type,
          members: a.members,
          roles: a.roles,
          admins: a.admins,
          title: a.title,
          ...(a.body ? { body: a.body } : {}),
        };
      case 'notify_app_user':
        return {
          type: a.type,
          to: a.toKind === 'creator' ? 'creator' : { role: a.role },
          title: a.title,
          ...(a.body ? { body: a.body } : {}),
          ...(a.screen ? { screen: a.screen } : {}),
        };
      case 'email':
        return {
          type: a.type,
          to: a.emails.split(/[\s,;]+/).filter(Boolean),
          roles: a.roles,
          subject: a.subject,
          body: a.body,
        };
      case 'webhook':
        return { type: a.type, url: a.url };
      default:
        return { type: a.type, instruction: a.instruction };
    }
  });
  return { name: d.name, enabled: true, trigger, conditions, actions };
}

/** De lo guardado al formulario. */
function toDraft(v: AutomationView): Draft {
  const d = emptyDraft();
  const inp = v.input as {
    name: string;
    trigger: Record<string, unknown>;
    conditions: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
  };
  d.name = inp.name;
  const t = inp.trigger;
  d.trigger = {
    ...d.trigger,
    type: String(t.type),
    tracker: String(t.tracker ?? ''),
    field: String(t.field ?? ''),
    to: t.to === undefined ? '' : String(t.to),
    screen: String(t.screen ?? ''),
    block: String(t.block ?? ''),
    decision: String(t.decision ?? 'any'),
    cadence: String(t.cadence ?? 'daily'),
    hour: Number(t.hour ?? 7),
    weekday: Number(t.weekday ?? 1),
    id: String(t.id ?? ''),
    label: String(t.label ?? ''),
  };
  d.conditions = inp.conditions.map((c) =>
    c.type === 'changed'
      ? {
          kind: 'changed',
          field: String(c.field),
          op: 'eq',
          value: '',
          from: String(c.from ?? ''),
          to: String(c.to ?? ''),
        }
      : {
          kind: 'filter',
          field: String(c.field),
          op: String(c.op),
          value: c.value === undefined ? '' : String(c.value),
          from: '',
          to: '',
        },
  );
  d.actions = inp.actions.map((a) => {
    const x = emptyAct(String(a.type));
    x.field = String(a.field ?? '');
    x.value = a.value === undefined ? '' : String(a.value);
    x.tracker = String(a.tracker ?? '');
    if (a.values && typeof a.values === 'object')
      x.pairs = Object.entries(a.values as Record<string, unknown>).map(([key, value]) => ({
        key,
        value: String(value),
      }));
    x.members = (a.members as string[] | undefined) ?? [];
    x.roles = (a.roles as string[] | undefined) ?? [];
    x.admins = a.admins === true;
    x.title = String(a.title ?? '');
    x.body = String(a.body ?? '');
    if (a.to === 'creator') x.toKind = 'creator';
    else if (a.to && typeof a.to === 'object' && !Array.isArray(a.to))
      x.role = String((a.to as { role: string }).role);
    if (a.type === 'email') x.emails = ((a.to as string[] | undefined) ?? []).join(', ');
    x.screen = String(a.screen ?? '');
    x.subject = String(a.subject ?? '');
    x.url = String(a.url ?? '');
    x.instruction = String(a.instruction ?? '');
    return x;
  });
  return d;
}

function ago(iso: string | null): string {
  if (!iso) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 90) return 'hace un momento';
  if (s < 5400) return `hace ${Math.round(s / 60)} min`;
  if (s < 129600) return `hace ${Math.round(s / 3600)} h`;
  return `hace ${Math.round(s / 86400)} días`;
}

const STATUS_LABEL: Record<string, { text: string; tone: string }> = {
  succeeded: { text: 'Salió bien', tone: 'bg-emerald-soft text-emerald' },
  failed: { text: 'Falló', tone: 'bg-rose-soft text-rose' },
  skipped: { text: 'No aplicó', tone: 'bg-surface-2 text-ink-muted' },
  queued: { text: 'En cola', tone: 'bg-amber-soft text-amber' },
  running: { text: 'Corriendo', tone: 'bg-amber-soft text-amber' },
};

function Pill({ status }: { status: string | null }) {
  if (!status) return <span className="text-micro text-ink-faint">Sin corridas</span>;
  const s = STATUS_LABEL[status] ?? { text: status, tone: 'bg-surface-2 text-ink-muted' };
  return (
    <span className={clsx('rounded-pill px-2 py-0.5 text-micro font-semibold', s.tone)}>
      {s.text}
    </span>
  );
}

export function AutomationsTab({ data }: { data: AppEditorData }) {
  const appId = data.app.id;
  const [items, setItems] = useState<AutomationView[] | null>(null);
  const [pushOn, setPushOn] = useState(true);
  const [caps, setCaps] = useState({ runsPerDay: 500, askCortexPerDay: 20 });
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [templating, setTemplating] = useState(false);
  const [history, setHistory] = useState<{ id: string; runs: RunView[] } | null>(null);

  const load = useCallback(async () => {
    const res = await loadAutomationsAction(appId);
    if (!res.ok) return setError(res.error);
    setItems(res.automations);
    setPushOn(res.pushOn);
    setCaps(res.caps);
  }, [appId]);
  useEffect(() => {
    void load();
  }, [load]);

  function run(task: () => Promise<{ ok: boolean; error?: string }>, after?: () => void) {
    setError(null);
    start(async () => {
      const res = await task();
      if (!res.ok) return setError(res.error ?? 'No se pudo.');
      after?.();
      await load();
    });
  }

  return (
    <div className="space-y-4">
      <section className={clsx(CARD, 'space-y-2')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink">Automatizaciones</h2>
            <p className="text-xs text-ink-muted">
              Cuando pase algo en la app, que avise o mueva cosas solo. Los avisos van por
              notificación push y correo. Tope por app: {caps.runsPerDay} corridas y{' '}
              {caps.askCortexPerDay} pedidos a Cortex por día.
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" className={BTN_SECONDARY} onClick={() => setTemplating(true)}>
              <Zap className="h-3.5 w-3.5" aria-hidden /> Desde una plantilla
            </button>
            <button
              type="button"
              className={BTN_PRIMARY}
              onClick={() => setEditing({ id: null, draft: emptyDraft() })}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden /> Nueva
            </button>
          </div>
        </div>
        {!pushOn && (
          <p className="flex items-start gap-2 rounded-card bg-amber-soft px-3 py-2 text-xs text-ink">
            <BellOff className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Las notificaciones push están apagadas en este servidor (faltan las llaves
            VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY y VAPID_SUBJECT). Mientras tanto, los avisos a
            usuarios de la app salen por correo.
          </p>
        )}
        <ErrorLine error={error} />
      </section>

      {templating && (
        <TemplatePicker
          data={data}
          busy={pending}
          onCancel={() => setTemplating(false)}
          onCreate={(id, params) =>
            run(
              () => createFromTemplateAction(appId, id, params),
              () => setTemplating(false),
            )
          }
        />
      )}

      {editing && (
        <RuleEditor
          data={data}
          initial={editing.draft}
          onCancel={() => setEditing(null)}
          onSave={(draft) =>
            run(
              () => saveAutomationAction(appId, editing.id, toInput(draft)),
              () => setEditing(null),
            )
          }
          busy={pending}
          appId={appId}
        />
      )}

      {items === null && <p className="text-xs text-ink-muted">Cargando…</p>}
      {items && items.length === 0 && !editing && !templating && (
        <p className={clsx(CARD, 'text-sm text-ink-muted')}>
          Esta app todavía no tiene automatizaciones. Empieza por una plantilla: «Avisar al
          supervisor cuando haya un duplicado» o «Avisar al operario si le rechazan».
        </p>
      )}
      {items?.map((a) => (
        <section key={a.id} className={clsx(CARD, 'space-y-2', !a.enabled && 'opacity-70')}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink">
                {a.name}{' '}
                {!a.enabled && (
                  <span className="ml-1 rounded-pill bg-surface-2 px-2 py-0.5 text-micro text-ink-muted">
                    En pausa
                  </span>
                )}
              </p>
              <p className="text-xs text-ink-muted">{a.description}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() => setEditing({ id: a.id, draft: toDraft(a) })}
              >
                Editar
              </button>
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={pending}
                onClick={() => run(() => toggleAutomationAction(appId, a.id, !a.enabled))}
              >
                {a.enabled ? (
                  <>
                    <Pause className="h-3.5 w-3.5" aria-hidden /> Pausar
                  </>
                ) : (
                  <>
                    <Play className="h-3.5 w-3.5" aria-hidden /> Reanudar
                  </>
                )}
              </button>
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={async () => {
                  if (history?.id === a.id) return setHistory(null);
                  const res = await loadRunsAction(appId, a.id);
                  if (!res.ok) return setError(res.error);
                  setHistory({ id: a.id, runs: res.runs });
                }}
              >
                <History className="h-3.5 w-3.5" aria-hidden /> Historial
              </button>
              <button
                type="button"
                className={BTN_DANGER}
                disabled={pending}
                aria-label={`Borrar ${a.name}`}
                onClick={() => {
                  if (window.confirm(`¿Borrar «${a.name}»? Su historial también se borra.`))
                    run(() => deleteAutomationAction(appId, a.id));
                }}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>
          <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            Última corrida: <Pill status={a.lastStatus} /> {a.lastRunAt ? ago(a.lastRunAt) : ''}
            {a.lastError && <span className="text-rose">· {a.lastError}</span>}
          </p>
          {a.webhookKey && (
            <p className="text-micro text-ink-muted">
              Firma del webhook: cabecera <code>x-cortex-signature</code> = <code>v1=</code>
              HMAC-SHA256 de «<code>x-cortex-timestamp</code>.cuerpo» con la llave{' '}
              <code>{a.webhookKey}</code>.
            </p>
          )}
          {history?.id === a.id && (
            <div className="space-y-1.5 rounded-card bg-surface-2 p-3">
              {history.runs.length === 0 && (
                <p className="text-xs text-ink-muted">Todavía no ha corrido.</p>
              )}
              {history.runs.map((r) => (
                <div key={r.id} className="space-y-0.5 border-b border-border pb-1.5 last:border-0">
                  <p className="flex flex-wrap items-center gap-2 text-xs text-ink">
                    <Pill status={r.status} /> {ago(r.createdAt)} · {r.triggerRef}
                    {r.attempts > 1 && ` · ${r.attempts} intentos`}
                  </p>
                  {r.error && <p className="text-xs text-rose">{r.error}</p>}
                  {r.results.map((x) => (
                    <p key={`${r.id}-${x.index}`} className="text-micro text-ink-muted">
                      {x.ok ? '✓' : '✗'} {x.type}: {x.detail}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span className="mb-1 block text-micro font-semibold text-ink-muted">{children}</span>;
}

function TemplatePicker({
  data,
  busy,
  onCancel,
  onCreate,
}: {
  data: AppEditorData;
  busy: boolean;
  onCancel: () => void;
  onCreate: (id: string, params: Record<string, string>) => void;
}) {
  const [id, setId] = useState<string>(TEMPLATES[0].id);
  const [p, setP] = useState<Record<string, string>>({});
  const t = TEMPLATES.find((x) => x.id === id) ?? TEMPLATES[0];
  const needs: readonly string[] = t.needs;
  const tracker = data.trackers.find((x) => x.slug === p.tracker);
  return (
    <section className={clsx(CARD, 'space-y-3')}>
      <h3 className="text-sm font-semibold text-ink">Plantilla</h3>
      <select
        value={id}
        onChange={(e) => {
          setId(e.target.value);
          setP({});
        }}
        className={clsx(INPUT, 'w-full')}
      >
        {TEMPLATES.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name}
          </option>
        ))}
      </select>
      <div className="grid gap-3 sm:grid-cols-2">
        {needs.includes('tracker') && (
          <label>
            <Label>¿De qué tabla?</Label>
            <select
              value={p.tracker ?? ''}
              onChange={(e) => setP({ ...p, tracker: e.target.value, field: '' })}
              className={clsx(INPUT, 'w-full')}
            >
              <option value="">Elige…</option>
              {data.trackers.map((x) => (
                <option key={x.slug} value={x.slug}>
                  {x.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {needs.includes('role') && (
          <label>
            <Label>¿A qué rol?</Label>
            <select
              value={p.role ?? ''}
              onChange={(e) => setP({ ...p, role: e.target.value })}
              className={clsx(INPUT, 'w-full')}
            >
              <option value="">Elige…</option>
              {data.roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {needs.includes('field') && (
          <label>
            <Label>Campo de estado</Label>
            <select
              value={p.field ?? ''}
              onChange={(e) => setP({ ...p, field: e.target.value })}
              className={clsx(INPUT, 'w-full')}
            >
              <option value="">Elige…</option>
              {(tracker?.fields ?? []).map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {needs.includes('value') && (
          <label>
            <Label>Pasa a…</Label>
            <input
              value={p.value ?? 'Despachada'}
              onChange={(e) => setP({ ...p, value: e.target.value })}
              className={clsx(INPUT, 'w-full')}
            />
          </label>
        )}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={busy}
          onClick={() => onCreate(id, { value: 'Despachada', ...p })}
        >
          Crear
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </section>
  );
}

function RuleEditor({
  data,
  initial,
  onCancel,
  onSave,
  busy,
  appId,
}: {
  data: AppEditorData;
  initial: Draft;
  onCancel: () => void;
  onSave: (d: Draft) => void;
  busy: boolean;
  appId: string;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [sim, setSim] = useState<Awaited<ReturnType<typeof testAutomationAction>> | null>(null);
  const [testing, startTest] = useTransition();
  const t = d.trigger;
  const tracker: Row | undefined = data.trackers.find((x) => x.slug === t.tracker);
  const fields = tracker?.fields ?? [];
  const rowless = ROWLESS.has(t.type);
  const setT = (patch: Partial<Draft['trigger']>) => setD({ ...d, trigger: { ...t, ...patch } });
  const setA = (i: number, patch: Partial<Act>) =>
    setD({ ...d, actions: d.actions.map((a, j) => (j === i ? { ...a, ...patch } : a)) });
  const setC = (i: number, patch: Partial<Cond>) =>
    setD({ ...d, conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const FieldSelect = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={INPUT}>
      <option value="">Campo…</option>
      {fields.map((f) => (
        <option key={f.key} value={f.key}>
          {f.label}
        </option>
      ))}
    </select>
  );

  return (
    <section className={clsx(CARD, 'space-y-5')}>
      <label className="block">
        <Label>Nombre</Label>
        <input
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.target.value })}
          maxLength={120}
          placeholder="Avisar al supervisor cuando haya un duplicado"
          className={clsx(INPUT, 'w-full')}
        />
      </label>

      <div className="space-y-2">
        <h3 className="text-xs font-bold uppercase tracking-wide text-primary">Cuando</h3>
        <select
          value={t.type}
          onChange={(e) =>
            setD({
              ...d,
              trigger: { ...t, type: e.target.value },
              conditions: ROWLESS.has(e.target.value) ? [] : d.conditions,
            })
          }
          className={clsx(INPUT, 'w-full')}
        >
          {TRIGGERS.map((x) => (
            <option key={x.type} value={x.type}>
              {x.label}
            </option>
          ))}
        </select>
        {!rowless && (
          <select
            value={t.tracker}
            onChange={(e) => setT({ tracker: e.target.value, field: '' })}
            className={clsx(INPUT, 'w-full')}
          >
            <option value="">¿En qué tabla?</option>
            {data.trackers.map((x) => (
              <option key={x.slug} value={x.slug}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        {t.type === 'row_updated' && (
          <div className="flex flex-wrap gap-2">
            <FieldSelect value={t.field} onChange={(v) => setT({ field: v })} />
            <input
              value={t.to}
              onChange={(e) => setT({ to: e.target.value })}
              placeholder="y pasó a… (opcional)"
              className={INPUT}
            />
          </div>
        )}
        {t.type === 'form_submitted' && (
          <select
            value={t.screen}
            onChange={(e) => setT({ screen: e.target.value })}
            className={INPUT}
          >
            <option value="">En cualquier pantalla</option>
            {data.screens.map((s) => (
              <option key={s.slug} value={s.slug}>
                Sólo en «{s.title}»
              </option>
            ))}
          </select>
        )}
        {t.type === 'approval_decided' && (
          <select
            value={t.decision}
            onChange={(e) => setT({ decision: e.target.value })}
            className={INPUT}
          >
            <option value="any">Aprobada o rechazada</option>
            <option value="approved">Sólo si se aprueba</option>
            <option value="rejected">Sólo si se rechaza</option>
          </select>
        )}
        {t.type === 'schedule' && (
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink">
            <select
              value={t.cadence}
              onChange={(e) => setT({ cadence: e.target.value })}
              className={INPUT}
            >
              <option value="daily">Todos los días</option>
              <option value="weekly">Cada semana</option>
            </select>
            {t.cadence === 'weekly' && (
              <select
                value={t.weekday}
                onChange={(e) => setT({ weekday: Number(e.target.value) })}
                className={INPUT}
              >
                {['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'].map(
                  (n, i) => (
                    <option key={n} value={i + 1}>
                      {n}
                    </option>
                  ),
                )}
              </select>
            )}
            a las
            <select
              value={t.hour}
              onChange={(e) => setT({ hour: Number(e.target.value) })}
              className={INPUT}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
            (hora de Bogotá)
          </div>
        )}
        {t.type === 'button' && (
          <div className="flex flex-wrap gap-2">
            <select
              value={t.screen}
              onChange={(e) => setT({ screen: e.target.value })}
              className={INPUT}
            >
              <option value="">¿En qué pantalla?</option>
              {data.screens.map((s) => (
                <option key={s.slug} value={s.slug}>
                  {s.title}
                </option>
              ))}
            </select>
            <input
              value={t.label}
              onChange={(e) => setT({ label: e.target.value })}
              placeholder="Texto del botón"
              maxLength={40}
              className={INPUT}
            />
          </div>
        )}
      </div>

      {!rowless && (
        <div className="space-y-2">
          <h3 className="text-xs font-bold uppercase tracking-wide text-primary">Si</h3>
          {d.conditions.length === 0 && (
            <p className="text-xs text-ink-muted">Sin condiciones: corre siempre.</p>
          )}
          {d.conditions.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: filas de formulario sin id propio
            <div key={i} className="flex flex-wrap items-center gap-2">
              <FieldSelect value={c.field} onChange={(v) => setC(i, { field: v })} />
              {c.kind === 'filter' ? (
                <>
                  <select
                    value={c.op}
                    onChange={(e) => setC(i, { op: e.target.value })}
                    className={INPUT}
                  >
                    {OPS.map((o) => (
                      <option key={o.op} value={o.op}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  {OPS.find((o) => o.op === c.op)?.needsValue && (
                    <input
                      value={c.value}
                      onChange={(e) => setC(i, { value: e.target.value })}
                      className={INPUT}
                    />
                  )}
                </>
              ) : (
                <>
                  <span className="text-xs text-ink-muted">cambió de</span>
                  <input
                    value={c.from}
                    onChange={(e) => setC(i, { from: e.target.value })}
                    placeholder="(cualquiera)"
                    className={INPUT}
                  />
                  <span className="text-xs text-ink-muted">a</span>
                  <input
                    value={c.to}
                    onChange={(e) => setC(i, { to: e.target.value })}
                    placeholder="(cualquiera)"
                    className={INPUT}
                  />
                </>
              )}
              <button
                type="button"
                className={BTN_DANGER}
                aria-label="Quitar condición"
                onClick={() => setD({ ...d, conditions: d.conditions.filter((_, j) => j !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <button
              type="button"
              className={BTN_SECONDARY}
              onClick={() =>
                setD({
                  ...d,
                  conditions: [
                    ...d.conditions,
                    { kind: 'filter', field: '', op: 'eq', value: '', from: '', to: '' },
                  ],
                })
              }
            >
              + Condición
            </button>
            {(t.type === 'row_updated' || t.type === 'approval_decided') && (
              <button
                type="button"
                className={BTN_SECONDARY}
                onClick={() =>
                  setD({
                    ...d,
                    conditions: [
                      ...d.conditions,
                      { kind: 'changed', field: '', op: 'eq', value: '', from: '', to: '' },
                    ],
                  })
                }
              >
                + «Cambió de X a Y»
              </button>
            )}
          </div>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-xs font-bold uppercase tracking-wide text-primary">Entonces</h3>
        <p className="text-micro text-ink-muted">
          Puedes usar datos de la fila con llaves: {'{{nombre}}'}, {'{{campo}}'},{' '}
          {'{{antes.campo}}'}, {'{{app}}'}, {'{{enlace}}'}, {'{{motivo}}'}.
        </p>
        {d.actions.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: acciones de formulario sin id propio
          <div key={i} className="space-y-2 rounded-card border border-border p-3">
            <div className="flex items-center gap-2">
              <select
                value={a.type}
                onChange={(e) =>
                  setD({
                    ...d,
                    actions: d.actions.map((x, j) =>
                      j === i ? { ...emptyAct(e.target.value) } : x,
                    ),
                  })
                }
                className={clsx(INPUT, 'flex-1')}
              >
                {ACTIONS.filter((x) => !(rowless && x.type === 'set_field')).map((x) => (
                  <option key={x.type} value={x.type}>
                    {x.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={BTN_DANGER}
                aria-label="Quitar acción"
                disabled={d.actions.length === 1}
                onClick={() => setD({ ...d, actions: d.actions.filter((_, j) => j !== i) })}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            <ActionFields
              a={a}
              set={(p) => setA(i, p)}
              data={data}
              fields={fields}
              rowless={rowless}
            />
          </div>
        ))}
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={d.actions.length >= 8}
          onClick={() => setD({ ...d, actions: [...d.actions, emptyAct('notify_app_user')] })}
        >
          + Acción
        </button>
      </div>

      {sim && (
        <div className="space-y-1.5 rounded-card bg-surface-2 p-3 text-xs text-ink">
          {sim.ok ? (
            <>
              <p className="font-semibold">
                Simulación{sim.sample ? ` con «${sim.sample}»` : ''} — no se hizo nada.
              </p>
              <p>
                {sim.triggers
                  ? '✓ El disparador aplica.'
                  : '✗ El disparador no aplicaría a esta fila.'}{' '}
                {sim.conditionsOk
                  ? '✓ Se cumplen las condiciones.'
                  : `✗ No se cumple: ${sim.conditionsFailed}`}
              </p>
              {sim.actions.map((x, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: resultado de simulación
                <p key={i} className="text-ink-muted">
                  → {x.summary}
                </p>
              ))}
            </>
          ) : (
            <p className="text-rose">{sim.error}</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={BTN_PRIMARY}
          disabled={busy || !d.name.trim()}
          onClick={() => onSave(d)}
        >
          Guardar
        </button>
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={testing}
          onClick={() =>
            startTest(async () => setSim(await testAutomationAction(appId, toInput(d))))
          }
        >
          Probar con una fila de ejemplo
        </button>
        <button type="button" className={BTN_SECONDARY} onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </section>
  );
}

function ActionFields({
  a,
  set,
  data,
  fields,
  rowless,
}: {
  a: Act;
  set: (p: Partial<Act>) => void;
  data: AppEditorData;
  fields: Row['fields'];
  rowless: boolean;
}) {
  const text = (v: string, on: (s: string) => void, placeholder: string, rows = 0) =>
    rows ? (
      <textarea
        value={v}
        onChange={(e) => on(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full resize-y rounded-card border border-border bg-surface px-3 py-2 text-xs text-ink outline-none placeholder:text-ink-faint focus:border-primary"
      />
    ) : (
      <input
        value={v}
        onChange={(e) => on(e.target.value)}
        placeholder={placeholder}
        className={clsx(INPUT, 'w-full')}
      />
    );
  const rolePick = (value: string, on: (s: string) => void) => (
    <select value={value} onChange={(e) => on(e.target.value)} className={INPUT}>
      <option value="">Elige un rol…</option>
      {data.roles.map((r) => (
        <option key={r.key} value={r.key}>
          {r.name}
        </option>
      ))}
    </select>
  );
  const toggle = (list: string[], key: string) =>
    list.includes(key) ? list.filter((x) => x !== key) : [...list, key];
  switch (a.type) {
    case 'set_field':
      return (
        <div className="flex flex-wrap gap-2">
          <select
            value={a.field}
            onChange={(e) => set({ field: e.target.value })}
            className={INPUT}
          >
            <option value="">Campo…</option>
            {fields.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <input
            value={a.value}
            onChange={(e) => set({ value: e.target.value })}
            placeholder="queda en…"
            className={INPUT}
          />
        </div>
      );
    case 'create_row': {
      const target = data.trackers.find((x) => x.slug === a.tracker);
      return (
        <div className="space-y-2">
          <select
            value={a.tracker}
            onChange={(e) => set({ tracker: e.target.value, pairs: [{ key: '', value: '' }] })}
            className={clsx(INPUT, 'w-full')}
          >
            <option value="">¿En qué tabla?</option>
            {data.trackers.map((x) => (
              <option key={x.slug} value={x.slug}>
                {x.name}
              </option>
            ))}
          </select>
          {a.pairs.map((p, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: pares de formulario
            <div key={i} className="flex flex-wrap gap-2">
              <select
                value={p.key}
                onChange={(e) =>
                  set({
                    pairs: a.pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)),
                  })
                }
                className={INPUT}
              >
                <option value="">Campo…</option>
                {(target?.fields ?? []).map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <input
                value={p.value}
                onChange={(e) =>
                  set({
                    pairs: a.pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)),
                  })
                }
                placeholder="valor o {{campo}}"
                className={INPUT}
              />
            </div>
          ))}
          <button
            type="button"
            className={BTN_SECONDARY}
            onClick={() => set({ pairs: [...a.pairs, { key: '', value: '' }] })}
          >
            + Campo
          </button>
        </div>
      );
    }
    case 'notify_member':
      return (
        <div className="space-y-2">
          {text(a.title, (v) => set({ title: v }), 'Título del aviso')}
          {text(a.body, (v) => set({ body: v }), 'Detalle (opcional)', 2)}
          <label className="flex items-center gap-2 text-xs text-ink">
            <input
              type="checkbox"
              checked={a.admins}
              onChange={(e) => set({ admins: e.target.checked })}
            />{' '}
            A quienes administran la empresa
          </label>
          <div className="flex flex-wrap gap-1.5">
            {data.roles.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => set({ roles: toggle(a.roles, r.key) })}
                className={clsx(
                  'rounded-pill border px-2.5 py-1 text-micro font-semibold',
                  a.roles.includes(r.key)
                    ? 'border-primary bg-primary-soft text-primary-ink'
                    : 'border-border text-ink-muted',
                )}
              >
                Rol {r.name}
              </button>
            ))}
          </div>
          <select
            value=""
            onChange={(e) => e.target.value && set({ members: toggle(a.members, e.target.value) })}
            className={INPUT}
          >
            <option value="">Agregar una persona…</option>
            {data.directory.map((p) => (
              <option key={p.id} value={p.id}>
                {a.members.includes(p.id) ? '✓ ' : ''}
                {p.name}
              </option>
            ))}
          </select>
        </div>
      );
    case 'notify_app_user':
      return (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <select
              value={a.toKind}
              onChange={(e) => set({ toKind: e.target.value as 'creator' | 'role' })}
              className={INPUT}
            >
              {!rowless && <option value="creator">A quien creó la fila</option>}
              <option value="role">A los de un rol</option>
            </select>
            {a.toKind === 'role' && rolePick(a.role, (v) => set({ role: v }))}
            <select
              value={a.screen}
              onChange={(e) => set({ screen: e.target.value })}
              className={INPUT}
            >
              <option value="">Abre la app</option>
              {data.screens.map((s) => (
                <option key={s.slug} value={s.slug}>
                  Abre «{s.title}»
                </option>
              ))}
            </select>
          </div>
          {text(a.title, (v) => set({ title: v }), 'Título (p. ej. Te rechazaron «{{nombre}}»)')}
          {text(a.body, (v) => set({ body: v }), 'Detalle (opcional)', 2)}
          <p className="text-micro text-ink-muted">
            Llega por push; si la persona no lo tiene activo, le llega por correo.
          </p>
        </div>
      );
    case 'email':
      return (
        <div className="space-y-2">
          {text(a.emails, (v) => set({ emails: v }), 'Direcciones (separadas por coma)')}
          <div className="flex flex-wrap gap-1.5">
            {data.roles.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => set({ roles: toggle(a.roles, r.key) })}
                className={clsx(
                  'rounded-pill border px-2.5 py-1 text-micro font-semibold',
                  a.roles.includes(r.key)
                    ? 'border-primary bg-primary-soft text-primary-ink'
                    : 'border-border text-ink-muted',
                )}
              >
                Usuarios del rol {r.name}
              </button>
            ))}
          </div>
          {text(a.subject, (v) => set({ subject: v }), 'Asunto')}
          {text(a.body, (v) => set({ body: v }), 'Mensaje', 4)}
        </div>
      );
    case 'webhook':
      return (
        <div className="space-y-1">
          {text(
            a.url,
            (v) => set({ url: v }),
            'https://… (sólo https; nada de direcciones internas)',
          )}
          <p className="text-micro text-ink-muted">
            Se envía un POST con la fila en JSON, firmado con HMAC. Se reintenta si el otro sistema
            cae.
          </p>
        </div>
      );
    default:
      return (
        <div className="space-y-1">
          {text(a.instruction, (v) => set({ instruction: v }), 'Qué debe hacer Cortex', 4)}
          <p className="text-micro text-ink-muted">
            Cortex puede leer y escribir en la tabla de la regla. Todo lo demás (correos, otras
            tablas) queda pendiente de tu aprobación.
          </p>
        </div>
      );
  }
}
