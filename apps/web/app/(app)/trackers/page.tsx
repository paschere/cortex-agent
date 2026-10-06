import { readPeopleNames, readTableSyncs } from '@/lib/datagrid/tracker-read';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { workspaceHref } from '@/lib/workspace-context';
import { listTrackers, readWorkSettings } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { TrackersIndex } from './TrackersIndex';
import { createTracker, importTrackerRows, readSpreadsheetFile } from './actions';
import {
  analyzeSchemaChange,
  createTableFromSheet,
  createTrackerWithSchema,
  listSheetSources,
  listTrackerChoices,
  loadSchemaEditor,
  proposeFromSheet,
  runSyncNow,
  saveTrackerSchema,
  updateSyncSettings,
} from './schema-actions';
import type { SchemaActions } from './schema-types';
import type { TrackerCardData, TrackersIndexActions } from './types';

export const dynamic = 'force-dynamic';

/**
 * «TABLAS»: las tablas que esta empresa lleva, como tarjetas.
 *
 * Antes esta ruta redirigía al panel del chat; el panel sigue (`/chat?panel=
 * trackers`) y el rail lo abre igual. Aquí se ve cuántas filas tiene cada una,
 * cuándo cambió, qué la llena sola y si se mide como trabajo, y se crea una
 * tabla nueva (a mano, importando un CSV/Excel o contándosela a Cortex).
 */
export default async function TrackersPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [trackers, syncs, settings, denied, latest] = await Promise.all([
    listTrackers(db, 200),
    readTableSyncs(db),
    readWorkSettings(db).catch((err) => {
      logger.warn({ err }, 'tablas: no se pudo leer qué se mide como trabajo');
      return null;
    }),
    deniedToolPatterns(db, user.id),
    // La última fila tocada de cada tabla, en una lectura.
    db
      .from('tracker_rows')
      .select('tracker_id, updated_at')
      .order('updated_at', { ascending: false })
      .limit(2000),
  ]);
  if (latest.error) throw latest.error;
  const lastRow = new Map<string, string>();
  for (const r of (latest.data ?? []) as Array<{ tracker_id: string; updated_at: string }>)
    if (!lastRow.has(r.tracker_id)) lastRow.set(r.tracker_id, r.updated_at);
  const names = await readPeopleNames(
    db,
    trackers.map((t) => t.created_by ?? ''),
  );
  const mapped = new Map((settings?.trackerMappings ?? []).map((m) => [m.tracker, m.workType]));

  const cards: TrackerCardData[] = trackers.map((t) => {
    const rowAt = lastRow.get(t.id);
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      description: t.description,
      rowCount: t.rowCount,
      fieldCount: t.fields.length,
      fields: t.fields,
      updatedAt: rowAt && rowAt > t.updated_at ? rowAt : t.updated_at,
      createdBy: t.created_by ? (names.get(t.created_by) ?? null) : null,
      syncs: syncs
        .filter((s) => s.trackerId === t.id)
        .map(({ trackerId: _t, createdBy: _c, ...s }) => s),
      workType: mapped.get(t.slug) ?? null,
    };
  });
  cards.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  const actions: TrackersIndexActions = {
    createTracker,
    importRows: importTrackerRows,
    readSpreadsheet: readSpreadsheetFile,
  };

  const schemaActions: SchemaActions = {
    load: loadSchemaEditor,
    analyze: analyzeSchemaChange,
    save: saveTrackerSchema,
    create: createTrackerWithSchema,
    listTrackers: listTrackerChoices,
    listSheets: listSheetSources,
    proposeFromSheet,
    createFromSheet: createTableFromSheet,
    updateSync: updateSyncSettings,
    syncNow: runSyncNow,
  };

  return (
    <TrackersIndex
      cards={cards}
      actions={actions}
      schemaActions={schemaActions}
      canCreate={!isToolDenied('trackers.define', denied)}
      links={{
        base: workspaceHref(user.organization.id, '/trackers'),
        chatBase: workspaceHref(user.organization.id, '/chat'),
      }}
    />
  );
}
