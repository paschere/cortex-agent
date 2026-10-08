import { displayTrackerValue, parseFileValue } from '../trackers/schema';
import {
  type ComputeOptions,
  type ComputedBlock,
  type ComputedDetailItem,
  type ComputedRecordDetail,
  type ComputedTimelineEntry,
  type ViewRow,
  type ViewSource,
  formatValue,
  rowKit,
  viewShortDate,
} from './compute';
import {
  APPROVE_ACTION_ID,
  type CatalogTracker,
  REJECT_ACTION_ID,
  type TimelinePart,
  type ViewBlock,
  type ViewSpec,
  fieldType,
  isReadOnlySource,
} from './spec';

/**
 * EL DETALLE DE UN REGISTRO Y SU LÍNEA DE TIEMPO.
 *
 * `findDetailTarget` decide QUÉ detalle abre una fila (`?fila=<id>`) mirando
 * sólo las fuentes que `loadViewSources` ya leyó —o sea, ya filtradas por el
 * scope del rol—: una fila que el rol no ve no se encuentra, y el detalle dice
 * «no existe o no la ves» sin distinguir una cosa de la otra.
 *
 * `buildDetail` arma el bloque: cabecera, secciones, galería, listas
 * relacionadas (de las otras fuentes ya leídas, con el mismo scope) y la
 * línea de tiempo. Nada aquí lee la base; la historia (`RecordHistoryRaw`) la
 * trae `record-history.ts` y llega por `opts.record.history`.
 *
 * QUÉ ENTRA A LA LÍNEA DE TIEMPO. Cada cambio se filtra por los campos que el
 * detalle MUESTRA (su cabecera y sus secciones): la historia de un campo que
 * la pantalla no enseña no se cuenta, aunque exista en la base. Un evento
 * cuyos cambios quedan todos fuera se omite entero. Los nombres de quien hizo
 * cada cosa ya vienen resueltos (y, para un cliente externo o un enlace
 * público, ya vienen sin nombres internos): ver record-history.ts.
 */

/** Lo crudo que se lee de la base; nada de esto viaja al navegador tal cual. */
export interface RecordHistoryRaw {
  created: { at: string; by: string | null } | null;
  events: Array<{
    id: string;
    at: string;
    kind: 'edit' | 'move' | 'action';
    actionId: string | null;
    changes: Record<string, { from?: unknown; to?: unknown }>;
    by: string | null;
  }>;
  runs: Array<{ id: string; at: string; automation: string; ok: boolean }>;
}

type DetailBlock = Extract<ViewBlock, { type: 'detail' }>;

/** Qué detalle (y qué fila) abre `?fila=`; null si nadie la ve. */
export function findDetailTarget(
  spec: Pick<ViewSpec, 'blocks'>,
  sources: Map<string, ViewSource>,
  rowId: string,
  blockId: string | null | undefined,
  today: string,
): { block: DetailBlock; row: ViewRow } | null {
  for (const block of spec.blocks) {
    if (block.type !== 'detail' || (blockId && block.id !== blockId)) continue;
    const src = sources.get(block.tracker);
    if (!src || src.blocked) continue;
    const row = src.rows.find((r) => r.id === rowId);
    if (row && block.filters.every((f) => rowKit.matches(src.tracker, row, f, today))) {
      return { block, row };
    }
  }
  return null;
}

/** Los campos que el detalle muestra (y por lo tanto los únicos cuya historia se cuenta). */
export function detailFieldKeys(
  block: DetailBlock,
  tracker: CatalogTracker,
  audience: 'team' | 'public',
): string[] {
  if (block.sections.length) {
    return [
      ...new Set([
        block.titleField,
        ...(block.subtitleField ? [block.subtitleField] : []),
        ...(block.statusField ? [block.statusField] : []),
        ...block.sections.flatMap((s) => s.fields),
        ...block.gallery,
      ]),
    ].filter((k) => k !== 'label' && k !== 'created_at' && k !== 'updated_at');
  }
  const all = tracker.fields.map((f) => f.key);
  return audience === 'public'
    ? [block.titleField, block.subtitleField, block.statusField, ...block.gallery].filter(
        (k): k is string => Boolean(k) && k !== 'label',
      )
    : all.slice(0, 16);
}

const clip = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Un valor de un cambio, legible según el tipo del campo. */
function showChange(tracker: CatalogTracker, key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const type = fieldType(tracker, key);
  if (type === 'checkbox') return Number(v) === 1 || v === true ? 'Sí' : 'No';
  if (type === 'file' || type === 'relation') return clip(displayTrackerValue({ type }, v) || '—');
  if (type === 'money') return formatValue(Number(v), 'money');
  if (type === 'number') return formatValue(Number(v), 'number');
  if (type === 'date' && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
    return viewShortDate(v);
  return clip(String(v));
}

/** Nombres de archivo que aparecen en `to` y no estaban en `from`. */
function newFiles(from: unknown, to: unknown): string[] {
  const names = (v: unknown) =>
    v === null || v === undefined || v === '' ? [] : (parseFileValue(v)?.map((f) => f.name) ?? []);
  const before = new Set(names(from));
  return names(to).filter((n) => !before.has(n));
}

export function buildTimeline(
  history: RecordHistoryRaw,
  ctx: {
    tracker: CatalogTracker;
    visible: ReadonlySet<string>;
    show: ReadonlySet<TimelinePart>;
    limit: number;
    labels?: ReadonlyMap<string, string>;
  },
): ComputedTimelineEntry[] {
  const { tracker, visible, show } = ctx;
  const label = (k: string) => rowKit.fieldLabel(tracker, k);
  const out: ComputedTimelineEntry[] = [];

  if (show.has('created') && history.created)
    out.push({
      id: 'created',
      at: history.created.at,
      kind: 'created',
      actor: history.created.by,
      title: 'Registro creado',
    });

  for (const e of history.events) {
    const approval =
      e.actionId === APPROVE_ACTION_ID || e.actionId === REJECT_ACTION_ID ? e.actionId : null;
    const shown = Object.entries(e.changes ?? {}).filter(([k]) => visible.has(k));
    const fileKeys = shown.filter(([k]) => fieldType(tracker, k) === 'file').map(([k]) => k);
    const plain = shown.filter(([k]) => !fileKeys.includes(k));

    if (show.has('files')) {
      const files = fileKeys
        .map((k) => ({ label: label(k), names: newFiles(e.changes[k]?.from, e.changes[k]?.to) }))
        .filter((f) => f.names.length);
      if (files.length)
        out.push({
          id: `${e.id}:files`,
          at: e.at,
          kind: 'file',
          actor: e.by,
          title: `Subió ${files.reduce((n, f) => n + f.names.length, 0) === 1 ? 'un archivo' : 'archivos'}`,
          files,
        });
    }

    const changes = plain.map(([k, c]) => ({
      label: label(k),
      from: showChange(tracker, k, c.from),
      to: showChange(tracker, k, c.to),
    }));

    if (approval) {
      if (!show.has('approvals')) continue;
      out.push({
        id: e.id,
        at: e.at,
        kind: 'approval',
        actor: e.by,
        title: approval === APPROVE_ACTION_ID ? 'Aprobado' : 'Rechazado',
        ...(show.has('changes') && changes.length ? { changes } : {}),
      });
      continue;
    }
    if (!show.has('changes')) continue;
    if (e.kind === 'action') {
      // Un botón: aunque no cambie nada visible, es parte de la historia.
      const name = e.actionId ? ctx.labels?.get(e.actionId) : undefined;
      out.push({
        id: e.id,
        at: e.at,
        kind: 'action',
        actor: e.by,
        title: name ? `Usó el botón «${name}»` : 'Usó un botón',
        ...(changes.length ? { changes } : {}),
      });
      continue;
    }
    if (!changes.length) continue;
    out.push({
      id: e.id,
      at: e.at,
      kind: 'changed',
      actor: e.by,
      title:
        changes.length === 1
          ? `Cambió «${changes[0]?.label}»`
          : e.kind === 'move'
            ? 'Lo movió'
            : `Cambió ${changes.length} campos`,
      changes,
    });
  }

  if (show.has('automations'))
    for (const r of history.runs)
      out.push({
        id: `run:${r.id}`,
        at: r.at,
        kind: 'automation',
        actor: null,
        title: r.ok
          ? `Automatización «${r.automation}»`
          : `Falló la automatización «${r.automation}»`,
        ok: r.ok,
      });

  // Lo más nuevo primero; a igual instante, «creado» queda de último.
  return out
    .sort((a, b) => b.at.localeCompare(a.at) || (a.kind === 'created' ? 1 : -1))
    .slice(0, ctx.limit);
}

const idle = () => ({
  header: null,
  sections: [],
  gallery: [],
  related: [],
  actions: [],
  timeline: null,
  rowId: null,
});

export function buildDetail(
  block: DetailBlock,
  ctx: {
    src: ViewSource;
    rows: ViewRow[];
    sources: Map<string, ViewSource>;
    today: string;
    opts: ComputeOptions;
  },
): ComputedBlock {
  const { src, rows, sources, opts } = ctx;
  const { tracker } = src;
  const K = rowKit;
  const base = {
    type: 'detail' as const,
    id: block.id,
    width: block.width,
    title: block.title ?? 'Detalle',
    source: tracker.name,
  };
  const selected = opts.record && opts.record.blockId === block.id ? opts.record : null;
  if (!selected) return { ...base, ...idle(), state: 'idle' };
  const row = rows.find((r) => r.id === selected.rowId);
  if (!row) return { ...base, ...idle(), state: 'missing' };

  const readOnly = isReadOnlySource(tracker.slug);
  const writes = new Set(
    opts.writable && !readOnly
      ? (block.recordEditable ?? []).filter((k) => tracker.fields.some((f) => f.key === k))
      : [],
  );
  const keys = detailFieldKeys(block, tracker, opts.audience);
  const text = (key: string | undefined) => {
    if (!key) return null;
    const v = K.displayValue(tracker, row, key);
    return v === '—' ? null : v;
  };

  const statusOptions = block.statusField
    ? (tracker.fields.find((f) => f.key === block.statusField)?.options ?? [])
    : [];
  const status = block.statusField ? K.rawValue(row, block.statusField) : undefined;

  const item = (key: string): ComputedDetailItem => ({
    key,
    ...K.detailOf(tracker, row, key),
    ...(writes.has(key)
      ? { edit: K.editMeta(tracker, key), editRaw: K.rawValue(row, key) ?? null }
      : {}),
  });
  const sectionDefs = block.sections.length
    ? block.sections
    : keys.length
      ? [{ title: 'Datos', fields: keys.filter((k) => fieldType(tracker, k) !== 'file') }]
      : [];
  const sections = sectionDefs
    .map((s) => ({
      title: s.title,
      // Sólo lo que se puede leer o editar: un «—» de un campo vacío de sólo lectura es ruido.
      items: s.fields
        .filter((k) => fieldType(tracker, k))
        .map(item)
        .filter((i) => i.value !== '—' || i.edit),
    }))
    .filter((s) => s.items.length > 0);

  const gallery = block.gallery.flatMap((key) => {
    const raw = K.rawValue(row, key);
    return raw === undefined ? [] : [{ key, label: K.fieldLabel(tracker, key), raw: String(raw) }];
  });

  const related = block.related.map((rel): ComputedRecordDetail['related'][number] => {
    const blockKey = `${block.id}:${rel.id}`;
    const other = sources.get(rel.tracker);
    const empty = {
      blockKey,
      title: rel.title,
      source: other?.tracker.name ?? rel.tracker,
      columns: [],
      rows: [],
      total: 0,
      actions: [],
      opens: opts.details?.get(rel.tracker) ?? null,
    };
    if (!other)
      return { ...empty, problem: `La tabla «${rel.tracker}» ya no existe en este espacio.` };
    if (other.blocked) return { ...empty, problem: other.blocked };
    const t2 = other.tracker;
    if (
      ![rel.field, ...(rel.parentField ? [rel.parentField] : [])].every((k, i) =>
        fieldType(i === 0 ? t2 : tracker, k),
      )
    )
      return {
        ...empty,
        problem: 'Este bloque nombra un campo que ya no existe. Pídele a Cortex que lo ajuste.',
      };
    const parentValue = rel.parentField ? K.rawValue(row, rel.parentField) : undefined;
    const linked = other.rows.filter((r) => {
      if (rel.match === 'relation') {
        const v = r.values[rel.field];
        return v !== undefined && relationId(v) === row.id;
      }
      const v = K.rawValue(r, rel.field);
      return (
        parentValue !== undefined &&
        v !== undefined &&
        String(v).trim().toLowerCase() === String(parentValue).trim().toLowerCase()
      );
    });
    const shown = K.sortRows(t2, linked, rel.sort).slice(0, rel.limit);
    const columns = (
      rel.columns.length
        ? rel.columns
        : [
            'label',
            ...t2.fields
              .filter((f) => f.type !== 'relation')
              .slice(0, 2)
              .map((f) => f.key),
          ]
    ).filter((k) => fieldType(t2, k));
    return {
      ...empty,
      columns: columns.map((key) => ({ key, label: K.fieldLabel(t2, key) })),
      rows: shown.map((r) => ({
        id: r.id,
        cells: columns.map((k) => K.displayValue(t2, r, k)),
        ...(K.isAlertRow(t2, r) ? { alert: true } : {}),
      })),
      total: linked.length,
      actions: K.actionsFor(opts, rel.actions, t2, shown),
      problem: null,
    };
  });

  let timeline: ComputedTimelineEntry[] | null = null;
  if (block.timeline !== false) {
    const cfg = block.timeline ?? { show: undefined, limit: 30 };
    const show = new Set<TimelinePart>(
      cfg.show ?? ['created', 'changes', 'approvals', 'automations', 'files'],
    );
    timeline = buildTimeline(
      selected.history ?? {
        created: { at: row.created_at, by: null },
        events: [],
        runs: [],
      },
      {
        tracker,
        visible: new Set(keys),
        show,
        limit: cfg.limit,
        labels: opts.actionLabels,
      },
    );
  }

  return {
    ...base,
    state: 'ready',
    rowId: row.id,
    header: {
      title: text(block.titleField) ?? row.label,
      subtitle: text(block.subtitleField),
      status:
        status === undefined
          ? null
          : {
              label: String(status),
              tone: (() => {
                const at = statusOptions.indexOf(String(status));
                return at >= 0 ? K.toneAt(at, statusOptions) : 'primary';
              })(),
            },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
    sections,
    gallery,
    related,
    actions: K.actionsFor(opts, block.actions, tracker, [row]),
    timeline,
  };
}

/** El id de fila que guarda un campo relación (JSON `{id,label}` o el id suelto). */
function relationId(v: string | number): string | null {
  const s = String(v).trim();
  if (/^[0-9a-f-]{36}$/i.test(s)) return s.toLowerCase();
  try {
    const o = JSON.parse(s) as { id?: unknown };
    return typeof o.id === 'string' ? o.id.toLowerCase() : null;
  } catch {
    return null;
  }
}
