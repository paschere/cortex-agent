import { ago } from '@/lib/accounting/card';

/**
 * «LO QUE YA ESTÁ CONECTADO», EN DATOS.
 *
 * Una empresa trae información a Cortex por nueve caminos que viven en nueve
 * tablas distintas —la cuenta de Google de cada quien, el programa contable,
 * una carpeta de Drive que llena una tabla, una hoja sincronizada, una API,
 * los extractos del banco, WhatsApp, la bandeja— y cada una dice «falló» a su
 * manera. Aquí se aplanan a una sola tarjeta con las mismas preguntas: qué
 * trae, cuándo fue la última vez, cuánto trajo, qué le pasa (dicho como lo
 * diría una persona, con el botón que lo arregla) y de quién es.
 *
 * Puro y serializable: la página lo arma con lo que lee `read.ts` y el
 * fixture de /v con datos inventados. Nada aquí importa valores de
 * @cortex/agent-tools, para que un componente de cliente pueda usarlo.
 */

export type SourceKind =
  | 'google'
  | 'microsoft'
  | 'hubspot'
  | 'github'
  | 'linear'
  | 'accounting'
  | 'drive_folder'
  | 'table_sync'
  | 'feed_source'
  | 'bank'
  | 'whatsapp'
  | 'inbox';

/** ok = al día · working = arrancando · attention = mírala · error = no trae nada · paused. */
export type SourceTone = 'ok' | 'working' | 'attention' | 'error' | 'paused';

export type SyncHandle =
  | { kind: 'accounting'; provider: string }
  | { kind: 'drive_folder' | 'table_sync'; id: string }
  | { kind: 'feed_source'; id: string };

export type SourceFix = { label: string; href: string } | { label: string; sync: true };

export interface SourceProblem {
  /** Lo que pasó y qué hacer, en una o dos frases sin jerga. */
  text: string;
  fix: SourceFix;
  /** Lo que dijo el sistema, tal cual, para quien quiera el detalle. */
  raw: string | null;
}

export interface ConnectedSource {
  key: string;
  kind: SourceKind;
  name: string;
  /** La cuenta o el destino: «Bancolombia corriente», «→ Guías». */
  detail: string | null;
  /** Qué trae a Cortex, en una frase. */
  brings: string;
  tone: SourceTone;
  status: string;
  lastSyncAt: string | null;
  /** «hace 12 min», ya calculado: el servidor y el navegador no discuten la hora. */
  lastSyncLabel: string | null;
  items: string | null;
  problem: SourceProblem | null;
  owner: string;
  scope: 'company' | 'personal';
  manage: { label: string; href: string } | null;
  /** Presente sólo si quien mira puede pedir «Sincronizar ahora». */
  sync: SyncHandle | null;
}

// ---------------------------------------------------------------------------
// Lo que se lee (read.ts) — filas planas, sin relaciones anidadas
// ---------------------------------------------------------------------------

export interface IntegrationRaw {
  provider: string;
  scopes: string[] | null;
  updated_at: string | null;
  user_id: string;
}

export interface AccountingRaw {
  id: string;
  provider: string;
  providerName: string;
  account_label: string | null;
  entities: string[];
  enabled: boolean;
  interval_minutes: number;
  last_run_at: string | null;
  last_status: 'ok' | 'partial' | 'error' | null;
  last_error: string | null;
  last_counts: Record<string, { inserted: number; updated: number } | undefined> | null;
  created_by: string;
}

export interface DriveRaw {
  id: string;
  folder_name: string;
  tracker_name: string | null;
  tracker_slug: string | null;
  enabled: boolean;
  interval_minutes: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_files: number;
  last_inserted: number;
  last_updated: number;
  last_needs_review: number;
  last_failed: number;
  created_by: string;
}

export interface TableSyncRaw {
  id: string;
  source_name: string | null;
  source_kind: string | null;
  tracker_name: string | null;
  tracker_slug: string | null;
  enabled: boolean;
  interval_minutes: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  last_inserted: number;
  last_updated: number;
  created_by: string;
}

export interface FeedSourceRaw {
  id: string;
  kind: string;
  name: string;
  enabled: boolean;
  status: string;
  last_checked_at: string | null;
  error: string | null;
}

export interface BankRaw {
  account: string;
  movements: number;
  unmatched: number;
  lastImportAt: string | null;
  lastBy: string | null;
}

export interface WhatsappRaw {
  status: string;
  lastSeenAt: string | null;
  groups: number;
  links: number;
  mineLinked: boolean;
}

export interface InboxRaw {
  count: number;
  latestAt: string | null;
}

/** `null` en una lista = esa lectura falló; nunca se toma por «no hay nada». */
export interface SourcesSnapshot {
  userId: string;
  /** Dueños y administradores: sincronizan el programa contable y lo de otros. */
  canManage: boolean;
  hubspotWorkspace: boolean;
  integrations: IntegrationRaw[] | null;
  accounting: AccountingRaw[] | null;
  drive: DriveRaw[] | null;
  tableSyncs: TableSyncRaw[] | null;
  feedSources: FeedSourceRaw[] | null;
  bank: BankRaw[] | null;
  whatsapp: WhatsappRaw | null;
  inbox: InboxRaw | null;
  /** id → nombre, para «Conectada por Ana». */
  people: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Frases
// ---------------------------------------------------------------------------

const PROVIDER_NAME: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft 365',
  hubspot: 'HubSpot',
  github: 'GitHub',
  linear: 'Linear',
};

const ENTITY_LABEL: Record<string, string> = {
  customers: 'clientes',
  products: 'productos',
  invoices: 'facturas',
  payments: 'pagos',
};

const FEED_KIND_BRINGS: Record<string, string> = {
  google_sheet: 'Una captura de la hoja de cálculo que se actualiza cuando lo pides',
  api: 'Los datos de tu sistema, leídos por su API',
  url: 'Una página web capturada para consultarla',
  combined: 'Varias fuentes cruzadas en una sola',
};

const FEED_KIND_NAME: Record<string, string> = {
  google_sheet: 'Hoja de Google',
  api: 'API',
  url: 'Página web',
  combined: 'Fuentes cruzadas',
};

export function every(minutes: number): string {
  if (minutes < 60) return `cada ${minutes} min`;
  if (minutes === 60) return 'cada hora';
  if (minutes % 60 === 0 && minutes < 1440) return `cada ${minutes / 60} h`;
  return 'una vez al día';
}

function listJoin(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} y ${items[items.length - 1]}`;
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('es-CO')} ${n === 1 ? one : many}`;
}

export function chatHelpHref(name: string, raw: string | null): string {
  const prompt = raw
    ? `La conexión «${name}» está fallando y el sistema dice: "${raw.slice(0, 400)}". Explícame en palabras simples qué pasó y ayúdame a arreglarlo.`
    : `La conexión «${name}» no está funcionando. Revisa qué pasa y ayúdame a arreglarlo.`;
  return `/chat?prompt=${encodeURIComponent(prompt)}`;
}

const RECONNECT: Partial<Record<SourceKind, string>> = {
  google: '/api/integrations/google?preset=all',
  drive_folder: '/api/integrations/google?preset=all',
  microsoft: '/api/integrations/microsoft?preset=all',
  hubspot: '/api/integrations/hubspot',
  accounting: '#programas-contables',
  whatsapp: '/integrations/whatsapp',
};

/**
 * El error crudo de un sistema, dicho como lo diría una persona, con el
 * arreglo que corresponde. Lo que no se reconoce no se inventa: se dice que
 * falló, se muestra lo que dijo el sistema y se ofrece pedirle ayuda a Cortex.
 */
export function plainProblem(
  raw: string | null,
  ctx: { kind: SourceKind; name: string; canSync: boolean },
): SourceProblem {
  const text = (raw ?? '').toLowerCase();
  const help: SourceFix = { label: 'Pedir ayuda a Cortex', href: chatHelpHref(ctx.name, raw) };
  const retry: SourceFix = ctx.canSync ? { label: 'Intentar de nuevo', sync: true } : help;
  const reconnectHref = RECONNECT[ctx.kind];

  if (
    /invalid_grant|unauthori[sz]ed|\b401\b|token (has )?(expired|revoked)|reautoriza|vuelve a conectar|permiso venci|credencial(es)? (inválida|vencida)/.test(
      text,
    )
  )
    return {
      text: 'Cortex perdió el permiso para entrar. Pasa cuando alguien cambia la contraseña o revoca el acceso; se arregla conectando otra vez.',
      fix: reconnectHref ? { label: 'Volver a conectar', href: reconnectHref } : help,
      raw,
    };
  if (/llave|api[ _-]?key|apikey|clave (inválida|incorrecta)/.test(text))
    return {
      text: 'La llave del programa ya no sirve (la cambiaron o venció). Pega una nueva en la tarjeta del programa.',
      fix: { label: 'Cambiar la llave', href: RECONNECT.accounting ?? '#programas-contables' },
      raw,
    };
  if (
    /\b403\b|forbidden|access denied|sin acceso|no tiene acceso|insufficient permission/.test(text)
  )
    return {
      text: 'La cuenta que conectó esto ya no tiene acceso. Pide que vuelvan a compartirle la carpeta u hoja, o conéctala con otra cuenta.',
      fix: help,
      raw,
    };
  if (/\b404\b|not found|no existe|no se encontr|was deleted|eliminad/.test(text))
    return {
      text: 'Lo que se estaba leyendo ya no está: la carpeta, la hoja o la dirección se borró o la movieron.',
      fix: help,
      raw,
    };
  if (/\b429\b|rate limit|too many|quota|cuota|límite de/.test(text))
    return {
      text: 'El sistema pidió esperar porque recibió muchas consultas seguidas. Cortex vuelve a intentar sola en la próxima vuelta.',
      fix: retry,
      raw,
    };
  if (
    /timeout|timed out|etimedout|econnreset|econnrefused|\b50[234]\b|unavailable|no respondi|tardó demasiado/.test(
      text,
    )
  )
    return {
      text: 'El sistema no respondió a tiempo. Casi siempre se arregla solo; puedes intentarlo ahora.',
      fix: retry,
      raw,
    };
  return {
    text: raw
      ? 'La última sincronización falló. Abajo está lo que dijo el sistema; Cortex te ayuda a entenderlo.'
      : 'La última sincronización falló sin decir por qué.',
    fix: ctx.canSync ? { label: 'Intentar de nuevo', sync: true } : help,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Armado
// ---------------------------------------------------------------------------

const STATUS: Record<SourceTone, string> = {
  ok: 'Al día',
  working: 'Arrancando',
  attention: 'Revisar',
  error: 'Con error',
  paused: 'En pausa',
};

function ownerLine(snap: SourcesSnapshot, createdBy: string | null, verb = 'Conectada'): string {
  if (!createdBy) return 'De la empresa';
  if (createdBy === snap.userId) return 'La conectaste tú';
  const name = snap.people[createdBy];
  return name ? `${verb} por ${name}` : `${verb} por alguien del equipo`;
}

/** Una sincronización que dejó de correr: más de tres vueltas, y nunca menos de 6 h. */
function isStale(lastRunAt: string | null, intervalMinutes: number, now: Date): boolean {
  if (!lastRunAt) return false;
  const limit = Math.max(intervalMinutes * 3, 360) * 60_000;
  return now.getTime() - Date.parse(lastRunAt) > limit;
}

function stalled(name: string, lastRunAt: string | null, now: Date, canSync: boolean) {
  return {
    text: `No corre desde ${ago(lastRunAt, now)}. Debería haber traído algo nuevo hace rato.`,
    fix: canSync
      ? ({ label: 'Sincronizar ahora', sync: true } as const)
      : { label: 'Pedir ayuda a Cortex', href: chatHelpHref(name, null) },
    raw: null,
  };
}

const GOOGLE_PARTS: Array<{ key: string; label: string }> = [
  { key: 'gmail', label: 'correo' },
  { key: 'calendar', label: 'calendario' },
  { key: 'drive', label: 'Drive' },
  { key: 'spreadsheets', label: 'hojas de cálculo' },
];

function oauthCards(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  const out: ConnectedSource[] = [];
  const mine = new Map(
    (snap.integrations ?? []).filter((r) => r.user_id === snap.userId).map((r) => [r.provider, r]),
  );

  const google = mine.get('google');
  if (google) {
    const scopes = (google.scopes ?? []).join(' ').toLowerCase();
    // Sin la lista de permisos no se puede decir que falte uno: callar es mejor que alarmar.
    const missing = scopes ? GOOGLE_PARTS.filter((p) => !scopes.includes(p.key)) : [];
    const has = GOOGLE_PARTS.filter((p) => !missing.includes(p)).map((p) => p.label);
    out.push({
      key: 'google',
      kind: 'google',
      name: 'Google',
      detail: 'Tu cuenta',
      brings: `Tu ${listJoin(has.length ? has : ['correo', 'calendario', 'Drive'])}, y las notas de tus reuniones`,
      tone: missing.length ? 'attention' : 'ok',
      status: missing.length ? 'Faltan permisos' : 'Conectada',
      lastSyncAt: google.updated_at,
      lastSyncLabel: google.updated_at ? `Autorizada ${ago(google.updated_at, now)}` : null,
      items: null,
      problem: missing.length
        ? {
            text: `Falta el permiso de ${listJoin(missing.map((m) => m.label))}: Cortex no puede usarlo hasta que lo apruebes.`,
            fix: { label: 'Dar los permisos', href: RECONNECT.google ?? '' },
            raw: null,
          }
        : null,
      owner: 'Tu cuenta: nadie más ve tu correo',
      scope: 'personal',
      manage: null,
      sync: null,
    });
  }

  const simple: Array<{ provider: string; brings: string }> = [
    { provider: 'microsoft', brings: 'Tu correo de Outlook y tu calendario' },
    { provider: 'hubspot', brings: 'Negocios, contactos y cómo va el embudo de ventas' },
    { provider: 'github', brings: 'Repositorios, issues y pull requests' },
    { provider: 'linear', brings: 'Proyectos, ciclos e issues del equipo' },
  ];
  for (const s of simple) {
    if (s.provider === 'hubspot' && snap.hubspotWorkspace) {
      out.push({
        key: 'hubspot',
        kind: 'hubspot',
        name: 'HubSpot',
        detail: 'Toda la empresa',
        brings: s.brings,
        tone: 'ok',
        status: 'Conectada',
        lastSyncAt: null,
        lastSyncLabel: null,
        items: null,
        problem: null,
        owner: 'La activó el equipo de Cortex',
        scope: 'company',
        manage: null,
        sync: null,
      });
      continue;
    }
    const row = mine.get(s.provider);
    if (!row) continue;
    out.push({
      key: s.provider,
      kind: s.provider as SourceKind,
      name: PROVIDER_NAME[s.provider] ?? s.provider,
      detail: 'Tu cuenta',
      brings: s.brings,
      tone: 'ok',
      status: 'Conectada',
      lastSyncAt: row.updated_at,
      lastSyncLabel: row.updated_at ? `Autorizada ${ago(row.updated_at, now)}` : null,
      items: null,
      problem: null,
      owner: 'La conectaste tú',
      scope: 'personal',
      manage: null,
      sync: null,
    });
  }
  return out;
}

function accountingCards(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  return (snap.accounting ?? []).map((c) => {
    const canSync = snap.canManage && c.enabled;
    const name = c.providerName;
    const counts = Object.values(c.last_counts ?? {}).filter(Boolean) as Array<{
      inserted: number;
      updated: number;
    }>;
    const inserted = counts.reduce((s, n) => s + (n.inserted || 0), 0);
    const updated = counts.reduce((s, n) => s + (n.updated || 0), 0);
    let tone: SourceTone = 'ok';
    let problem: SourceProblem | null = null;
    if (!c.enabled) tone = 'paused';
    else if (c.last_status === 'error') {
      tone = 'error';
      problem = plainProblem(c.last_error, { kind: 'accounting', name, canSync });
    } else if (c.last_status === 'partial' || !c.last_status) tone = 'working';
    else if (isStale(c.last_run_at, c.interval_minutes, now)) {
      tone = 'attention';
      problem = stalled(name, c.last_run_at, now, canSync);
    }
    return {
      key: `accounting:${c.provider}`,
      kind: 'accounting',
      name,
      detail: c.account_label,
      brings: `Trae ${listJoin(c.entities.map((e) => ENTITY_LABEL[e] ?? e))} a tablas, ${every(c.interval_minutes)}`,
      tone,
      status: c.last_status === 'partial' ? 'Trayendo datos' : STATUS[tone],
      lastSyncAt: c.last_run_at,
      lastSyncLabel: c.last_run_at
        ? `Última vez ${ago(c.last_run_at, now)}`
        : 'Todavía no ha corrido',
      items: c.last_run_at
        ? inserted || updated
          ? `${plural(inserted, 'nuevo', 'nuevos')} · ${plural(updated, 'actualizado', 'actualizados')}`
          : 'Sin cambios en la última vuelta'
        : null,
      problem,
      owner: ownerLine(snap, c.created_by),
      scope: 'company',
      manage: { label: 'Configurar', href: '#programas-contables' },
      sync: canSync ? { kind: 'accounting', provider: c.provider } : null,
    };
  });
}

function driveCards(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  return (snap.drive ?? []).map((d) => {
    const canSync = d.enabled && (snap.canManage || d.created_by === snap.userId);
    const table = d.tracker_name?.trim() || 'una tabla';
    const name = d.folder_name.trim() || 'Carpeta de Drive';
    let tone: SourceTone = 'ok';
    let problem: SourceProblem | null = null;
    if (!d.enabled) tone = 'paused';
    else if (d.last_status === 'error') {
      tone = 'error';
      problem = plainProblem(d.last_error, { kind: 'drive_folder', name, canSync });
    } else if (!d.last_run_at) tone = 'working';
    else if (d.last_failed > 0) {
      tone = 'attention';
      problem = {
        text: `${plural(d.last_failed, 'archivo no se pudo leer', 'archivos no se pudieron leer')} (fotos o PDF escaneados, casi siempre). Los demás sí entraron.`,
        fix: { label: 'Ver cuáles', href: chatHelpHref(name, null) },
        raw: null,
      };
    } else if (isStale(d.last_run_at, d.interval_minutes, now)) {
      tone = 'attention';
      problem = stalled(name, d.last_run_at, now, canSync);
    }
    const parts = d.last_run_at
      ? [
          plural(d.last_files, 'archivo leído', 'archivos leídos'),
          plural(d.last_inserted, 'fila nueva', 'filas nuevas'),
          ...(d.last_needs_review > 0
            ? [`${d.last_needs_review.toLocaleString('es-CO')} por revisar`]
            : []),
        ]
      : [];
    return {
      key: `drive:${d.id}`,
      kind: 'drive_folder',
      name,
      detail: `→ ${table}`,
      brings: `Cada archivo nuevo de la carpeta se vuelve una fila en «${table}», ${every(d.interval_minutes)}`,
      tone,
      status: STATUS[tone],
      lastSyncAt: d.last_run_at,
      lastSyncLabel: d.last_run_at
        ? `Última vez ${ago(d.last_run_at, now)}`
        : 'Todavía no ha corrido',
      items: parts.length ? parts.join(' · ') : null,
      problem,
      owner: ownerLine(snap, d.created_by),
      scope: 'company',
      manage: d.tracker_slug
        ? { label: 'Ver la tabla', href: `/trackers/${d.tracker_slug}` }
        : null,
      sync: canSync ? { kind: 'drive_folder', id: d.id } : null,
    };
  });
}

function tableSyncCards(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  return (snap.tableSyncs ?? []).map((s) => {
    const canSync = s.enabled && (snap.canManage || s.created_by === snap.userId);
    const table = s.tracker_name?.trim() || 'una tabla';
    const name = s.source_name?.trim() || 'Hoja de cálculo';
    let tone: SourceTone = 'ok';
    let problem: SourceProblem | null = null;
    if (!s.enabled) tone = 'paused';
    else if (s.last_status === 'error') {
      tone = 'error';
      problem = plainProblem(s.last_error, { kind: 'table_sync', name, canSync });
    } else if (!s.last_run_at) tone = 'working';
    else if (isStale(s.last_run_at, s.interval_minutes, now)) {
      tone = 'attention';
      problem = stalled(name, s.last_run_at, now, canSync);
    }
    return {
      key: `sync:${s.id}`,
      kind: 'table_sync',
      name,
      detail: `→ ${table}`,
      brings: `Las filas nuevas y los cambios llegan a «${table}», ${every(s.interval_minutes)}`,
      tone,
      status: STATUS[tone],
      lastSyncAt: s.last_run_at,
      lastSyncLabel: s.last_run_at
        ? `Última vez ${ago(s.last_run_at, now)}`
        : 'Todavía no ha corrido',
      items: s.last_run_at
        ? `${plural(s.last_inserted, 'nueva', 'nuevas')} · ${plural(s.last_updated, 'actualizada', 'actualizadas')}`
        : null,
      problem,
      owner: ownerLine(snap, s.created_by),
      scope: 'company',
      manage: s.tracker_slug
        ? { label: 'Ver la tabla', href: `/trackers/${s.tracker_slug}` }
        : null,
      sync: canSync ? { kind: 'table_sync', id: s.id } : null,
    };
  });
}

function feedSourceCards(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  return (snap.feedSources ?? [])
    .filter((f) => f.kind in FEED_KIND_BRINGS)
    .map((f) => {
      const canSync = f.enabled;
      let tone: SourceTone = 'ok';
      let problem: SourceProblem | null = null;
      if (!f.enabled || f.status === 'disabled') tone = 'paused';
      else if (f.status === 'error') {
        tone = 'error';
        problem = plainProblem(f.error, { kind: 'feed_source', name: f.name, canSync });
      } else if (f.status === 'refreshing') tone = 'working';
      return {
        key: `feed:${f.id}`,
        kind: 'feed_source',
        name: f.name,
        detail: FEED_KIND_NAME[f.kind] ?? null,
        brings: FEED_KIND_BRINGS[f.kind] ?? 'Una fuente de tu bandeja',
        tone,
        status: f.status === 'refreshing' ? 'Actualizando' : STATUS[tone],
        lastSyncAt: f.last_checked_at,
        lastSyncLabel: f.last_checked_at ? `Revisada ${ago(f.last_checked_at, now)}` : null,
        items: null,
        problem,
        owner: 'Tuya: sólo tú la ves',
        scope: 'personal',
        manage: { label: 'Ver en la bandeja', href: '/feed?vista=fuentes' },
        sync: canSync ? { kind: 'feed_source', id: f.id } : null,
      };
    });
}

function bankCards(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  return (snap.bank ?? []).map((b) => {
    const old = b.lastImportAt && now.getTime() - Date.parse(b.lastImportAt) > 35 * 86_400_000;
    return {
      key: `bank:${b.account}`,
      kind: 'bank',
      name: 'Extractos del banco',
      detail: b.account,
      brings: 'Los movimientos de la cuenta, para atarlos a las facturas que pagan',
      tone: old ? 'attention' : 'ok',
      status: old ? 'Desactualizado' : 'Al día',
      lastSyncAt: b.lastImportAt,
      lastSyncLabel: b.lastImportAt ? `Último extracto ${ago(b.lastImportAt, now)}` : null,
      items: [
        plural(b.movements, 'movimiento', 'movimientos'),
        ...(b.unmatched > 0 ? [`${b.unmatched.toLocaleString('es-CO')} sin factura`] : []),
      ].join(' · '),
      problem: old
        ? {
            text: 'El último extracto tiene más de un mes: la conciliación y la caja se están quedando viejas.',
            fix: { label: 'Importar extracto', href: '/payments#extractos' },
            raw: null,
          }
        : null,
      owner: ownerLine(snap, b.lastBy, 'Importado'),
      scope: 'company',
      manage: { label: 'Ver conciliación', href: '/payments#extractos' },
      sync: null,
    };
  });
}

function whatsappCard(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  const wa = snap.whatsapp;
  if (!wa || wa.status === 'disconnected') return [];
  const alive = !!wa.lastSeenAt && now.getTime() - Date.parse(wa.lastSeenAt) < 3 * 60_000;
  let tone: SourceTone = 'ok';
  let problem: SourceProblem | null = null;
  if (wa.status === 'pairing') tone = 'working';
  else if (wa.status !== 'connected' || !alive) {
    tone = 'error';
    problem = {
      text: 'El teléfono de la empresa se desconectó: Cortex no recibe ni contesta mensajes. Vuelve a emparejarlo con el QR.',
      fix: { label: 'Volver a emparejar', href: '/integrations/whatsapp' },
      raw: null,
    };
  } else if (!wa.mineLinked) {
    tone = 'attention';
    problem = {
      text: 'Tu número todavía no está vinculado, así que Cortex no te contesta por WhatsApp.',
      fix: { label: 'Vincular mi número', href: '/integrations/whatsapp' },
      raw: null,
    };
  }
  return [
    {
      key: 'whatsapp',
      kind: 'whatsapp',
      name: 'WhatsApp',
      detail: 'Número de la empresa',
      brings:
        'Conversar con Cortex desde el teléfono y guardar en el cerebro los grupos que elegiste',
      tone,
      status:
        wa.status === 'pairing' ? 'Emparejando' : tone === 'error' ? 'Desconectado' : STATUS[tone],
      lastSyncAt: wa.lastSeenAt,
      lastSyncLabel: wa.lastSeenAt ? `Visto ${ago(wa.lastSeenAt, now)}` : null,
      items: `${plural(wa.groups, 'grupo', 'grupos')} · ${plural(wa.links, 'número', 'números')}`,
      problem,
      owner: 'De la empresa',
      scope: 'company',
      manage: { label: 'Configurar', href: '/integrations/whatsapp' },
      sync: null,
    },
  ];
}

function inboxCard(snap: SourcesSnapshot, now: Date): ConnectedSource[] {
  const inbox = snap.inbox;
  if (!inbox || inbox.count === 0) return [];
  return [
    {
      key: 'inbox',
      kind: 'inbox',
      name: 'Bandeja de archivos',
      detail: 'Temporal · sólo tú',
      brings: 'Los archivos, enlaces y textos que subiste para consultar',
      tone: 'ok',
      status: 'Al día',
      lastSyncAt: inbox.latestAt,
      lastSyncLabel: inbox.latestAt ? `El último ${ago(inbox.latestAt, now)}` : null,
      items: plural(inbox.count, 'entrada', 'entradas'),
      problem: null,
      owner: 'Tuya: duran siete días',
      scope: 'personal',
      manage: { label: 'Abrir la bandeja', href: '/feed' },
      sync: null,
    },
  ];
}

const RANK: Record<SourceTone, number> = { error: 0, attention: 1, working: 2, ok: 3, paused: 4 };

/** Todo lo conectado, lo que pide algo primero. */
export function buildConnectedSources(snap: SourcesSnapshot, now = new Date()): ConnectedSource[] {
  const all = [
    ...oauthCards(snap, now),
    ...accountingCards(snap, now),
    ...driveCards(snap, now),
    ...tableSyncCards(snap, now),
    ...feedSourceCards(snap, now),
    ...bankCards(snap, now),
    ...whatsappCard(snap, now),
    ...inboxCard(snap, now),
  ];
  return all
    .map((s, i) => ({ s, i }))
    .sort((a, b) => RANK[a.s.tone] - RANK[b.s.tone] || a.i - b.i)
    .map(({ s }) => s);
}

/** Las lecturas que fallaron, dichas por lo que cubren. */
export function unreadParts(snap: SourcesSnapshot): string[] {
  const parts: Array<[unknown, string]> = [
    [snap.integrations, 'las cuentas conectadas'],
    [snap.accounting, 'los programas contables'],
    [snap.drive, 'las carpetas de Drive'],
    [snap.tableSyncs, 'las hojas sincronizadas'],
    [snap.feedSources, 'las fuentes de tu bandeja'],
    [snap.bank, 'los extractos del banco'],
    [snap.whatsapp, 'WhatsApp'],
  ];
  return parts.filter(([v]) => v === null).map(([, label]) => label);
}

export interface SourcesHealth {
  total: number;
  ok: number;
  errors: number;
  attention: number;
  working: number;
  paused: number;
  /** «6 conectadas · 1 con error». */
  label: string;
}

export function summarizeSources(list: ConnectedSource[]): SourcesHealth {
  const n = (tone: SourceTone) => list.filter((s) => s.tone === tone).length;
  const h = {
    total: list.length,
    ok: n('ok'),
    errors: n('error'),
    attention: n('attention'),
    working: n('working'),
    paused: n('paused'),
  };
  const parts = [plural(h.total, 'conectada', 'conectadas')];
  if (h.errors) parts.push(`${h.errors} con error`);
  if (h.attention) parts.push(`${h.attention} por revisar`);
  if (h.paused) parts.push(`${h.paused} en pausa`);
  return { ...h, label: h.total ? parts.join(' · ') : 'Nada conectado todavía' };
}
