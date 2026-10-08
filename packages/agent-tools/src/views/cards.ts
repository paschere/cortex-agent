import { weekDays } from './agenda';
import {
  type ComputeOptions,
  type ComputedBlock,
  type ViewRow,
  type ViewSource,
  blockWriteFields,
  rowKit,
} from './compute';
import { httpsUrl } from './embeds';
import { type ViewBlock, fieldType, isReadOnlySource } from './spec';

/**
 * LA LISTA DE TARJETAS CON FILTROS RÁPIDOS: SU CÁLCULO.
 *
 * Aquí sólo se deja cada tarjeta lista para filtrarse en el navegador (ver
 * cards-filter.ts): su día, su estado, si es «mía», su grupo y los valores por
 * los que se puede ordenar. Ninguna tarjeta lleva más campos que los que el
 * spec nombró; la ficha (`record`) sigue las mismas reglas que las demás
 * listas, y si la vista tiene un detalle para la tabla, tocar la tarjeta lo
 * abre por su enlace.
 *
 * «Mío» = lo que creó quien mira (su `created_by`, o el usuario externo de la
 * app). Es la definición que ya usa el scope «own» de las aplicaciones, y por
 * eso no necesita un campo de la tabla. En el enlace público no hay «quién
 * mira» y el chip no se ofrece.
 */

type CardsBlock = Extract<ViewBlock, { type: 'cards' }>;

export function computeCards(
  block: CardsBlock,
  ctx: { src: ViewSource; rows: ViewRow[]; today: string; opts: ComputeOptions },
): ComputedBlock {
  const { src, rows, today, opts } = ctx;
  const { tracker } = src;
  const K = rowKit;
  const sorted = K.sortRows(tracker, rows, block.sort).slice(0, block.limit);
  const options = (key: string | undefined) =>
    key ? (tracker.fields.find((f) => f.key === key)?.options ?? []) : [];
  const statusOptions = options(block.statusField);
  const groupOptions =
    fieldType(tracker, block.groupBy ?? '') === 'select' ? options(block.groupBy) : [];
  const viewer = opts.viewer ?? null;
  const week = weekDays(today);
  const isMine = (r: ViewRow) =>
    viewer
      ? viewer.kind === 'app_user'
        ? r.created_by_app_user === viewer.id
        : r.created_by === viewer.id
      : false;
  const text = (r: ViewRow, key: string | undefined) => {
    if (!key) return null;
    const v = K.displayValue(tracker, r, key);
    return v === '—' ? null : v;
  };
  const numeric = (key: string) => {
    const t = fieldType(tracker, key);
    return t === 'number' || t === 'money';
  };
  const dated = (key: string) => {
    const t = fieldType(tracker, key);
    return t === 'date' || t === 'builtin_date';
  };

  const cards = sorted.map((r) => {
    const status = block.statusField ? K.rawValue(r, block.statusField) : undefined;
    const at = status === undefined ? -1 : statusOptions.indexOf(String(status));
    const img = block.imageField ? K.rawValue(r, block.imageField) : undefined;
    const imageType = block.imageField ? fieldType(tracker, block.imageField) : null;
    const safeImg = img === undefined ? null : httpsUrl(String(img));
    const date = block.dateField ? K.rawValue(r, block.dateField) : undefined;
    const group = block.groupBy ? K.displayValue(tracker, r, block.groupBy) : null;
    return {
      id: r.id,
      ...(K.isAlertRow(tracker, r) ? { alert: true } : {}),
      title: text(r, block.titleField) ?? r.label,
      subtitle: text(r, block.subtitleField),
      image:
        img === undefined
          ? null
          : imageType === 'file'
            ? { kind: 'file' as const, raw: String(img) }
            : safeImg
              ? { kind: 'url' as const, url: safeImg }
              : null,
      status:
        status === undefined
          ? null
          : { label: String(status), tone: at >= 0 ? K.toneAt(at) : ('primary' as const) },
      data: block.dataFields.map((k) => K.detailOf(tracker, r, k)).filter((d) => d.value !== '—'),
      day: typeof date === 'string' ? K.dayOf(date) : null,
      mine: isMine(r),
      group: group === '—' ? 'Sin dato' : group,
      sort: block.sortOptions.map((k) => {
        const v = K.rawValue(r, k);
        return v === undefined ? null : numeric(k) ? Number(v) : String(v);
      }),
    };
  });
  // Agrupar por un campo de opciones sigue el orden de sus opciones.
  if (groupOptions.length) {
    const rank = (g: string | null) => {
      const i = g ? groupOptions.indexOf(g) : -1;
      return i < 0 ? groupOptions.length : i;
    };
    cards.sort((a, b) => rank(a.group) - rank(b.group));
  }

  const chips = [...new Set(block.chips)].filter((c) =>
    c === 'status'
      ? statusOptions.length > 0
      : c === 'mine'
        ? Boolean(viewer) && !isReadOnlySource(tracker.slug)
        : Boolean(block.dateField),
  );
  const sortIndex = block.sort ? block.sortOptions.indexOf(block.sort.field) : -1;

  return {
    type: 'cards',
    id: block.id,
    width: block.width,
    title: block.title,
    source: tracker.name,
    today,
    week: { from: week[0] ?? today, to: week[6] ?? today },
    total: rows.length,
    cards,
    chips,
    statusOptions: statusOptions.map((label, i) => ({ label, tone: K.toneAt(i) })),
    searchable: block.searchable,
    groupLabel: block.groupBy ? K.fieldLabel(tracker, block.groupBy) : null,
    sortOptions: block.sortOptions.map((k) => ({
      label: K.fieldLabel(tracker, k),
      dir: numeric(k) || dated(k) ? 'desc' : 'asc',
    })),
    defaultSort: block.sort && sortIndex >= 0 ? { index: sortIndex, dir: block.sort.dir } : null,
    pageSize: block.pageSize,
    paging: block.paging,
    actions: K.actionsFor(opts, block.actions, tracker, sorted),
    record: K.buildRecords(
      block,
      tracker,
      sorted,
      [
        block.titleField,
        ...(block.subtitleField ? [block.subtitleField] : []),
        ...(block.statusField ? [block.statusField] : []),
        ...block.dataFields,
      ],
      blockWriteFields(block),
      opts,
    ),
  };
}
