import { countTrackerRows, readTableSyncs, readTrackerEntries } from '@/lib/datagrid/tracker-read';
import { TRACKER_SLUG_PATTERN, trackerColumns, trackerGridRow } from '@/lib/datagrid/trackers';
import { deleteGridView, listGridViews, saveGridView } from '@/lib/datagrid/views-store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { workspaceHref } from '@/lib/workspace-context';
import { getTrackerBySlug, readWorkSettings } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { notFound } from 'next/navigation';
import {
  addTrackerColumn,
  bulkEditTrackerRows,
  createTrackerRow,
  deleteTrackerRows,
  editTrackerCell,
  queryTrackerRows,
  syncTrackerNow,
  trackerRowHistory,
} from '../actions';
import type { TrackerActions } from '../types';
import { type TrackerLinks, TrackerScreen } from './TrackerScreen';

export const dynamic = 'force-dynamic';

/** Hasta aquí se manda la tabla entera al navegador; más allá, por páginas. */
const CLIENT_LIMIT = 2000;
const FIRST_PAGE = 500;

/**
 * /trackers/<slug>: una tabla de la empresa con todas sus filas en la grilla.
 *
 * Antes redirigía al panel del chat (`/chat?panel=tracker&key=…`), que sigue
 * existiendo y se abre desde «Abrir en el chat». Aquí se lee la tabla, lo que
 * la llena sola, si se mide como trabajo y las vistas guardadas; escribir es
 * de `../actions.ts`.
 */
export default async function TrackerPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug: raw } = await params;
  const slug = decodeURIComponent(raw).trim();
  if (!TRACKER_SLUG_PATTERN.test(slug)) notFound();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const tracker = await getTrackerBySlug(db, slug);
  if (!tracker) notFound();

  const total = await countTrackerRows(db, tracker.id);
  const paged = total > CLIENT_LIMIT;
  const [entries, syncs, settings, savedViews, denied] = await Promise.all([
    readTrackerEntries(db, tracker.id, { limit: paged ? FIRST_PAGE : CLIENT_LIMIT }),
    readTableSyncs(db, tracker.id),
    readWorkSettings(db).catch((err) => {
      logger.warn({ err }, 'tablas: no se pudo leer qué se mide como trabajo');
      return null;
    }),
    listGridViews(`tracker:${tracker.id}`).catch((err) => {
      logger.warn({ err }, 'tablas: no se pudieron leer las vistas guardadas');
      return [];
    }),
    deniedToolPatterns(db, user.id),
  ]);

  const syncedRows = entries.filter((e) => e.external_key).length;
  const mapping = settings?.trackerMappings.find((m) => m.tracker === tracker.slug) ?? null;
  const ws = (href: string) => workspaceHref(user.organization.id, href);

  const actions: TrackerActions = {
    edit: editTrackerCell,
    bulkEdit: bulkEditTrackerRows,
    create: createTrackerRow,
    remove: deleteTrackerRows,
    addColumn: addTrackerColumn,
    query: queryTrackerRows,
    history: trackerRowHistory,
    syncNow: syncTrackerNow,
    listViews: listGridViews,
    saveView: saveGridView,
    deleteView: deleteGridView,
  };

  return (
    <TrackerScreen
      data={{
        tracker: {
          id: tracker.id,
          slug: tracker.slug,
          name: tracker.name,
          description: tracker.description,
          fields: tracker.fields,
          createdBy: tracker.created_by,
          updatedAt: tracker.updated_at,
        },
        columns: trackerColumns(tracker.fields),
        rows: entries.map(trackerGridRow),
        total,
        savedViews,
        syncs: syncs.map(({ trackerId: _t, createdBy: _c, ...s }) => s),
        workType: mapping?.workType ?? null,
        syncedRows,
        canChangeSchema: !isToolDenied('trackers.define', denied),
      }}
      actions={actions}
      links={
        {
          chatBase: ws('/chat'),
          viewHref: ws(
            `/chat?prompt=${encodeURIComponent(`Crea una vista con la tabla «${tracker.name}» (${tracker.slug}): las cifras clave, un gráfico y la lista completa.`)}`,
          ),
          teamHref: ws('/team/medir'),
          backHref: ws('/trackers'),
        } satisfies TrackerLinks
      }
    />
  );
}
