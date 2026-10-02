/**
 * Lo que las pantallas de «Equipo» le piden al servidor. En la app son las
 * acciones de app/(app)/team/actions.ts; en /v/equipo-showcase, unas de
 * mentira que contestan igual sin guardar nada.
 */

export type TeamActionResult = { ok: true; note: string } | { ok: false; error: string };

export interface MappingFieldOption {
  key: string;
  label: string;
  type: string;
  options?: string[];
}

export interface TrackerOption {
  slug: string;
  name: string;
  rowCount: number;
  fields: MappingFieldOption[];
  /** El tipo de trabajo con que ya está conectada, si lo está. */
  mappedAs: string | null;
}

export interface MappingDraft {
  tracker: string;
  workType: string;
  assigneeField: string;
  statusField: string | null;
  doneValues: string[];
  cancelledValues: string[];
  dueField: string | null;
  quantityField: string | null;
  unit: string | null;
  titleField: string | null;
}

export type MappingSuggestion =
  | {
      ok: true;
      mapping: Omit<MappingDraft, 'tracker' | 'workType'> | null;
      candidates: Array<{ key: string; label: string; reason: string }>;
      notes: string;
    }
  | { ok: false; error: string };

export interface TeamActions {
  reassign(input: {
    moves: Array<{ toId: string; itemIds: string[] }>;
  }): Promise<TeamActionResult>;
  markDone(input: { itemId: string }): Promise<TeamActionResult>;
  saveAway(input: {
    personId: string;
    add: string[];
    remove: string[];
  }): Promise<TeamActionResult>;
  suggestMapping(input: { tracker: string }): Promise<MappingSuggestion>;
  configure(input: {
    mapTracker?: MappingDraft;
    unmapTracker?: string;
    measuredTypes?: string[] | null;
    teamVisibility?: 'self' | 'team' | 'all';
  }): Promise<TeamActionResult>;
}
