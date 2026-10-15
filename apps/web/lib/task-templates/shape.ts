/**
 * PLANTILLAS DE TAREA — la parte pura.
 *
 * Una plantilla es TEXTO: un pedido ya escrito que se manda como cualquier
 * otro a una tarea en segundo plano. No hay código por plantilla: Cortex
 * resuelve el pedido con las herramientas generales de siempre (y con los mismos
 * permisos y confirmaciones de quien lo lanza). Los huecos se marcan con
 * `{{nombre}}` y la galería los pide antes de empezar.
 */

export const NEED_KEYS = ['gmail', 'drive', 'accounting', 'siigo', 'bank_file', 'hubspot'] as const;
export type NeedKey = (typeof NEED_KEYS)[number];

export const NEED_LABEL: Record<NeedKey, string> = {
  gmail: 'Gmail',
  drive: 'Drive',
  accounting: 'Contabilidad (Siigo, Alegra o QuickBooks)',
  siigo: 'Siigo',
  bank_file: 'El extracto, adjunto en el chat',
  hubspot: 'HubSpot',
};

/** Qué proveedores de la tabla `integrations` cumplen cada necesidad. `null`: no es una conexión. */
export const NEED_PROVIDERS: Record<NeedKey, readonly string[] | null> = {
  gmail: ['google', 'gmail'],
  drive: ['google'],
  accounting: ['siigo', 'alegra', 'quickbooks'],
  siigo: ['siigo'],
  bank_file: null,
  hubspot: ['hubspot'],
};

export function needMet(need: NeedKey, connected: readonly string[]): boolean | null {
  const providers = NEED_PROVIDERS[need];
  if (!providers) return null;
  return providers.some((p) => connected.includes(p));
}

export interface TemplateField {
  key: string;
  label: string;
  placeholder: string;
}

export interface TaskTemplate {
  id: string;
  source: 'builtin' | 'company';
  title: string;
  summary: string;
  prompt: string;
  needs: NeedKey[];
  minutes: number;
  fields: TemplateField[];
}

const PLACEHOLDER = /\{\{\s*([^{}]{1,40}?)\s*\}\}/g;

/** Los huecos `{{...}}` de un texto, sin repetir y en orden. */
export function placeholdersOf(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(PLACEHOLDER)) {
    const name = (m[1] ?? '').trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Rellena los huecos; un hueco sin valor deja la plantilla sin lanzar. */
export function fillPrompt(
  prompt: string,
  values: Record<string, string>,
): { prompt: string; missing: string[] } {
  const missing: string[] = [];
  const filled = prompt.replace(PLACEHOLDER, (_all, raw: string) => {
    const name = raw.trim();
    const v = (values[name] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!v) {
      if (!missing.includes(name)) missing.push(name);
      return `{{${name}}}`;
    }
    return v;
  });
  return { prompt: filled, missing };
}

/** Los campos que pide la galería: los declarados, y los huecos del texto que falten. */
export function fieldsFor(
  prompt: string,
  declared: readonly TemplateField[] = [],
): TemplateField[] {
  const out = [...declared.filter((f) => prompt.includes(`{{${f.key}}}`))];
  for (const name of placeholdersOf(prompt)) {
    if (!out.some((f) => f.key === name)) out.push({ key: name, label: name, placeholder: '' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validación de una plantilla de la empresa (la escribe una persona admin)
// ---------------------------------------------------------------------------

export interface TemplateInput {
  title: string;
  summary: string;
  prompt: string;
  needs: NeedKey[];
  minutes: number;
}

const FIELD_NAME = /^[\p{L}\p{N} _.-]{1,40}$/u;

export function validateTemplateInput(
  raw: unknown,
): { ok: true; value: TemplateInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object')
    return { ok: false, error: 'Faltan los datos de la plantilla.' };
  const r = raw as Record<string, unknown>;
  const title = typeof r.title === 'string' ? r.title.replace(/\s+/g, ' ').trim() : '';
  const summary = typeof r.summary === 'string' ? r.summary.replace(/\s+/g, ' ').trim() : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : '';
  if (title.length < 3 || title.length > 90)
    return { ok: false, error: 'El título va de 3 a 90 caracteres.' };
  if (summary.length < 5 || summary.length > 280) {
    return { ok: false, error: 'Lo que hace va de 5 a 280 caracteres.' };
  }
  if (prompt.length < 10 || prompt.length > 6000) {
    return { ok: false, error: 'El pedido va de 10 a 6.000 caracteres.' };
  }
  const holes = placeholdersOf(prompt);
  if (holes.length > 5) return { ok: false, error: 'Usa como mucho 5 huecos {{así}}.' };
  if (holes.some((h) => !FIELD_NAME.test(h))) {
    return { ok: false, error: 'Los huecos {{así}} llevan sólo letras, números y espacios.' };
  }
  if (/\{\{|\}\}/.test(prompt.replace(PLACEHOLDER, ''))) {
    return { ok: false, error: 'Hay un hueco {{así}} mal cerrado.' };
  }
  const needsRaw = Array.isArray(r.needs) ? r.needs : [];
  const needs = needsRaw.filter((n): n is NeedKey =>
    (NEED_KEYS as readonly string[]).includes(n as string),
  );
  if (needs.length !== needsRaw.length)
    return { ok: false, error: 'Hay una conexión que no reconozco.' };
  const minutes = Math.round(Number(r.minutes ?? 10));
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
    return { ok: false, error: 'El tiempo estimado va de 1 a 120 minutos.' };
  }
  return {
    ok: true,
    value: { title, summary, prompt, needs: [...new Set(needs)], minutes },
  };
}

export function templateFromRow(row: Record<string, unknown>): TaskTemplate | null {
  if (
    typeof row.id !== 'string' ||
    typeof row.title !== 'string' ||
    typeof row.prompt !== 'string'
  ) {
    return null;
  }
  const needs = (Array.isArray(row.needs) ? row.needs : []).filter((n): n is NeedKey =>
    (NEED_KEYS as readonly string[]).includes(n as string),
  );
  return {
    id: row.id,
    source: 'company',
    title: row.title,
    summary: typeof row.summary === 'string' ? row.summary : '',
    prompt: row.prompt,
    needs,
    minutes: Math.min(Math.max(Number(row.minutes ?? 10) || 10, 1), 120),
    fields: fieldsFor(row.prompt),
  };
}

/** El título con los huecos llenos, o con «…» donde todavía falta el valor. */
export function titleWith(title: string, values: Record<string, string> = {}): string {
  return title.replace(PLACEHOLDER, (_all, raw: string) => {
    const v = (values[raw.trim()] ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    return v || '…';
  });
}
