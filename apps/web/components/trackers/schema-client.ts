'use client';

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
} from '@/app/(app)/trackers/schema-actions';
import type { SchemaActions } from '@/app/(app)/trackers/schema-types';

/** Las acciones reales del editor de campos y reglas (server actions). */
export const schemaActions: SchemaActions = {
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

/**
 * Agrega UN campo a una tabla que existe, por el mismo camino y con los mismos
 * permisos que el editor completo (lee la tabla y la guarda con su validación,
 * su revisión de vistas y su auditoría). Lo usa el inspector de formularios
 * para ofrecer «crear el campo Estado» sin abrir todo el editor.
 */
export async function addFieldToTracker(
  slug: string,
  field: import('@/lib/trackers/schema-editor').TrackerField,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const current = await schemaActions.load(slug);
  if (!current.ok) return current;
  const { tracker } = current.data;
  if (tracker.fields.length >= 20)
    return { ok: false, error: 'La tabla ya tiene 20 campos, que es el máximo.' };
  const r = await schemaActions.save(tracker.id, {
    name: tracker.name,
    description: tracker.description,
    fields: [...tracker.fields, field],
    duplicates: tracker.duplicates,
    confirmRemoved: [],
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
