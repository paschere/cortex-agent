/**
 * LA APP AL LADO DEL CHAT: LO PURO.
 *
 * Qué resultados de herramientas hablan de una app, cuál es «la app de esta
 * conversación», cuándo el panel debe refrescarse porque Cortex la cambió, qué
 * modos ofrece según los permisos, cuánto mide el panel y cómo se le cuenta a
 * Cortex lo que la persona editó. Sin React ni red para poder probarlo.
 */

export interface AppRef {
  /** El id de la app (la mención `@` sólo sabe el id; el resto se completa al abrir). */
  id: string;
  slug: string;
  name: string;
  icon: string;
  status: 'draft' | 'published';
  /** Número de la versión publicada, si el resultado lo dice (apps.publish). */
  version: number | null;
  /** De dónde salió: lo que Cortex hizo, lo que se leyó, o una mención con @. */
  source: 'created' | 'updated' | 'published' | 'read' | 'mention';
  updatedAt: string | null;
}

export type AppPanelMode = 'vista' | 'editar';

const CHANGES: Record<string, AppRef['source']> = {
  apps_create: 'created',
  apps_apply_draft: 'created',
  apps_update: 'updated',
  apps_publish: 'published',
  apps_get: 'read',
};

function obj(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Un id de herramienta llega con punto o con guion bajo. */
export function appToolKey(toolName: string): string {
  return toolName.replaceAll('.', '_');
}

/** ¿Esta herramienta cambia la app (y por tanto el panel debe refrescarse)? */
export function changesApp(toolName: string): boolean {
  const s = CHANGES[appToolKey(toolName)];
  return s === 'created' || s === 'updated' || s === 'published';
}

export function appRefOfSummary(
  summary: unknown,
  source: AppRef['source'] = 'read',
  version: number | null = null,
): AppRef | null {
  return refOf(summary, source, version);
}

function refOf(
  summary: unknown,
  source: AppRef['source'],
  version: number | null = null,
): AppRef | null {
  const s = obj(summary);
  if (!s) return null;
  const id = str(s.id);
  const name = str(s.name);
  if (!id || !name) return null;
  const status = s.status === 'published' ? 'published' : 'draft';
  return {
    id,
    slug: str(s.slug) ?? id,
    name,
    icon: str(s.icon) ?? '▦',
    status,
    version,
    source,
    updatedAt: str(s.updatedAt),
  };
}

/** La app de UN resultado (create, update, apply_draft, publish, get). Una lista no tiene «la» app. */
export function appRefFromResult(toolName: string, result: unknown): AppRef | null {
  const source = CHANGES[appToolKey(toolName)];
  const r = obj(result);
  if (!source || !r || '__error' in r || r.__requires_confirmation === true) return null;
  const version = typeof r.version === 'number' && Number.isFinite(r.version) ? r.version : null;
  return refOf(r.app, source, version);
}

/** apps.list: las apps entre las que se elige una. */
export function appRefsFromList(result: unknown): AppRef[] {
  const apps = obj(result)?.apps;
  if (!Array.isArray(apps)) return [];
  return apps.flatMap((a) => {
    const ref = refOf(a, 'read');
    return ref ? [ref] : [];
  });
}

export interface ToolCallLike {
  toolName: string;
  state?: string;
  result?: unknown;
}

/**
 * La app más reciente de la conversación, de las invocaciones en orden. Gana la
 * última; una lectura (`apps.get`) no pisa a un cambio del MISMO id (el cambio
 * trae el estado más nuevo).
 */
export function latestAppRef(calls: readonly ToolCallLike[]): AppRef | null {
  let found: AppRef | null = null;
  for (const call of calls) {
    if (call.state !== undefined && call.state !== 'result') continue;
    const ref = appRefFromResult(call.toolName, call.result);
    if (!ref) continue;
    if (found && found.id === ref.id && ref.source === 'read' && found.source !== 'read') continue;
    found = ref;
  }
  return found;
}

/**
 * La señal de «esto cambió»: el panel recarga la vista cuando cambia. Mezcla el
 * sello de la app, la versión y la fuente, no el número de turnos.
 */
export function appSyncKey(ref: AppRef | null): string {
  if (!ref) return '';
  return [ref.id, ref.updatedAt ?? '', ref.version ?? '', ref.status, ref.name].join('|');
}

/** ¿Hay que refrescar el panel ya abierto? Misma app con otro sello, o app distinta. */
export function shouldRefresh(prev: AppRef | null, next: AppRef | null): boolean {
  if (!next) return false;
  if (!prev) return true;
  return appSyncKey(prev) !== appSyncKey(next);
}

/** Cuando hay un borrador abierto y llega la app creada, el panel pasa a la app real. */
export function shouldSwitchFromDraft(
  draftOpen: boolean,
  prev: AppRef | null,
  next: AppRef | null,
): boolean {
  return draftOpen && next !== null && next.source === 'created' && prev?.id !== next.id;
}

// ---------------------------------------------------------------------------
// Modos y permisos
// ---------------------------------------------------------------------------

/** Quien no administra la app sólo ve «Vista». */
export function availableModes(canEdit: boolean): AppPanelMode[] {
  return canEdit ? ['vista', 'editar'] : ['vista'];
}

export function resolveMode(mode: AppPanelMode, canEdit: boolean): AppPanelMode {
  return availableModes(canEdit).includes(mode) ? mode : 'vista';
}

export function statusLabel(status: AppRef['status'], publishedNumber: number | null): string {
  if (status !== 'published') return 'Borrador';
  return publishedNumber ? `Publicada v${publishedNumber}` : 'Publicada';
}

// ---------------------------------------------------------------------------
// Ancho del panel
// ---------------------------------------------------------------------------

export const APP_PANEL_WIDTH_KEY = 'cortex-app-panel-width';
export const APP_PANEL_MODE_KEY = 'cortex-app-panel-mode';
export const MIN_APP_PANEL = 400;
/** Lo que siempre se le deja a la conversación. */
export const MIN_CHAT = 380;

export function defaultAppPanelWidth(viewport: number): number {
  return clampAppPanelWidth(Math.round(viewport * 0.46), viewport);
}

export function clampAppPanelWidth(width: number, viewport: number): number {
  // Además de la conversación (MIN_CHAT) queda la lista de chats a la izquierda (~280).
  const max = Math.max(MIN_APP_PANEL, viewport - MIN_CHAT - 280);
  if (!Number.isFinite(width)) return Math.min(max, Math.max(MIN_APP_PANEL, 720));
  return Math.round(Math.min(max, Math.max(MIN_APP_PANEL, width)));
}

export function parseStoredWidth(raw: string | null, viewport: number): number {
  const n = raw === null ? Number.NaN : Number(raw);
  return Number.isFinite(n) ? clampAppPanelWidth(n, viewport) : defaultAppPanelWidth(viewport);
}

export function parseStoredMode(raw: string | null): AppPanelMode {
  return raw === 'editar' ? 'editar' : 'vista';
}

// ---------------------------------------------------------------------------
// Contarle a Cortex
// ---------------------------------------------------------------------------

/**
 * Lo que la persona «dice» al contarle a Cortex lo que editó. Entra como mensaje
 * suyo y es una señal de control (el prefijo está en `CONTROL_MESSAGE_STEMS`):
 * la búsqueda en el cerebro lo salta.
 */
export function editNote(appName: string, changes: readonly string[]): string {
  const list = changes
    .map((c) => c.trim().replace(/\.$/, ''))
    .filter(Boolean)
    .slice(0, 6);
  const what = list.length > 0 ? `cambié ${list.join('; ')}` : 'hice cambios';
  return `Edité la app en el panel: «${appName}», ${what}. Tenlo en cuenta si sigues con ella; no rehagas lo que ya quedó.`;
}

export function publishNote(appName: string, number: number | null, note?: string): string {
  const v = number ? ` como versión ${number}` : '';
  const n = note?.trim() ? ` Nota: ${note.trim()}.` : '';
  return `Edité la app en el panel: publiqué «${appName}»${v}.${n} Tenlo en cuenta si sigues con ella.`;
}

/** Los textos de cambios nuevos entre dos lecturas del borrador (para no repetir lo ya contado). */
export function newChanges(before: readonly string[], after: readonly string[]): string[] {
  const seen = new Set(before);
  return after.filter((c) => !seen.has(c));
}

/** El mensaje que un iframe del editor le manda al panel al guardarse algo. */
export const PANEL_MESSAGE = 'cortex-app-panel';

export interface PanelMessage {
  type: typeof PANEL_MESSAGE;
  event: 'edited';
  appId: string;
  stamp: string;
}

export function parsePanelMessage(data: unknown, appId: string): PanelMessage | null {
  const m = obj(data);
  if (!m || m.type !== PANEL_MESSAGE || m.event !== 'edited') return null;
  if (m.appId !== appId || typeof m.stamp !== 'string') return null;
  return m as unknown as PanelMessage;
}
