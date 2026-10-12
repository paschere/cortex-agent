import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { parseFileValue } from '../trackers/schema';
import {
  type ViewRow,
  type ViewSource,
  formatValue,
  optionTones,
  todayIn,
  viewShortDate,
} from '../views/compute';
import { type CatalogTracker, type ViewSpec, fieldType, viewSpecSchema } from '../views/spec';
import { loadViewSources } from '../views/store';
import {
  type AppPermissions,
  type ResolvedRole,
  USER_ATTRIBUTE_RE,
  canSeeScreen,
  roleKeySchema,
  rowAccessFor,
  rowScopeFor,
  rowVisible,
} from './permissions';
import type { AppAccess, RoleInput } from './store';
import { cellText, namingSpec } from './tablero';

/**
 * EL PORTAL DE CLIENTES (migración 0225).
 *
 * Un portal NO es un sistema aparte: es un rol «cliente» de la app, con
 * usuarios externos (entran con el código por correo, 0209), cuyas tablas se
 * leen con el scope por atributo de siempre —`{field: 'cliente', equals:
 * '$user.cliente'}— y una pantalla sintética `portal` con lo que un cliente
 * quiere ver al entrar:
 *
 *   - sus envíos o pedidos (cualquier tabla del espacio);
 *   - sus facturas y lo que debe (cualquier tabla con valor y vencimiento);
 *   - sus documentos para descargar (campos de archivo);
 *   - un formulario para subir soportes (p. ej. el soporte de pago), que cae
 *     en una tabla de la empresa —con el cliente forzado por el servidor— y
 *     avisa por una automatización;
 *   - «Pagar», SÓLO si la factura trae un enlace de pago (un campo con una URL
 *     https que llena la integración de cobro o el programa contable). Si la
 *     empresa no tiene ese enlace, el botón no existe: nunca se inventa uno.
 *
 * LA REGLA QUE IMPORTA: un cliente nunca ve filas de otro. La lectura ya trae
 * el scope (`loadViewSources`), y además `computePortalFromSources` vuelve a
 * filtrar cada fila con `rowVisible` antes de mostrarla: aunque quien llame se
 * olvide del scope, lo ajeno no sale. Un cliente sin su atributo (no se dijo
 * de qué cliente es) no ve NADA, no «todo».
 */

export const PORTAL_SLUG = 'portal';
export const PORTAL_UPLOAD_SCREEN = 'subir_soporte';
export const PORTAL_AUTOMATION_NAME = 'Portal: soporte recibido';

const slug = z.string().trim().min(1).max(100);
const field = z.string().trim().min(1).max(40);
const sectionTitle = (fallback: string) => z.string().trim().min(1).max(60).default(fallback);

export const portalSchema = z.object({
  enabled: z.boolean().default(false),
  /** El rol de los clientes. */
  roleKey: roleKeySchema.default('cliente'),
  /** El atributo con que se les asigna su cliente: `$user.<attribute>` en el scope. */
  attribute: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]{0,39}$/)
    .default('cliente'),
  title: z.string().trim().max(60).optional(),
  welcome: z.string().trim().max(240).optional(),
  shipments: z
    .object({
      source: slug,
      title: sectionTitle('Mis envíos'),
      /** Columna que dice de qué cliente es cada fila. */
      clientField: field,
      columns: z.array(field).max(5).default([]),
      statusField: field.optional(),
      /** Pantalla (slug) que abre una fila; vacío = no abre. */
      screen: z.string().trim().max(48).optional(),
      limit: z.number().int().min(1).max(30).default(10),
    })
    .optional(),
  invoices: z
    .object({
      source: slug,
      title: sectionTitle('Mis facturas'),
      clientField: field,
      columns: z.array(field).max(4).default([]),
      amountField: field.optional(),
      dueField: field.optional(),
      statusField: field.optional(),
      /** Valores de estado que cuentan como «pagada». */
      paidValues: z.array(z.string().trim().max(40)).max(6).default(['Pagada', 'Pagado']),
      /** Campo con el ENLACE DE PAGO (https) de la factura. Sin campo, «Pagar» no existe. */
      payUrlField: field.optional(),
      limit: z.number().int().min(1).max(30).default(10),
    })
    .optional(),
  documents: z
    .object({
      source: slug,
      title: sectionTitle('Mis documentos'),
      clientField: field,
      /** Campo de archivo. */
      fileField: field,
      labelField: field.optional(),
      limit: z.number().int().min(1).max(30).default(10),
    })
    .optional(),
  upload: z
    .object({
      /** La tabla de la empresa donde caen los soportes. */
      source: slug,
      title: sectionTitle('Subir soporte'),
      clientField: field,
      fileField: field,
      noteField: field.optional(),
      kindField: field.optional(),
      hint: z.string().trim().max(160).optional(),
    })
    .optional(),
});
export type ClientPortal = z.infer<typeof portalSchema>;

/** El patch que acepta el chat y el editor: todo opcional, `null` quita una sección. */
export const portalPatchSchema = z.object({
  enabled: z.boolean().optional(),
  roleKey: roleKeySchema.optional(),
  attribute: portalSchema.shape.attribute.optional(),
  title: z.string().trim().max(60).nullable().optional(),
  welcome: z.string().trim().max(240).nullable().optional(),
  shipments: portalSchema.shape.shipments.nullable(),
  invoices: portalSchema.shape.invoices.nullable(),
  documents: portalSchema.shape.documents.nullable(),
  upload: portalSchema.shape.upload.nullable(),
});

export const EMPTY_PORTAL: ClientPortal = portalSchema.parse({});

export function parsePortal(raw: unknown): ClientPortal {
  const parsed = portalSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : EMPTY_PORTAL;
}

export function mergePortal(
  current: ClientPortal,
  patch: z.input<typeof portalPatchSchema>,
): ClientPortal {
  const next: Record<string, unknown> = { ...current };
  for (const key of ['enabled', 'roleKey', 'attribute'] as const)
    if (patch[key] !== undefined) next[key] = patch[key];
  for (const key of ['title', 'welcome'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    if (v === null || !v.trim()) next[key] = undefined;
    else next[key] = v;
  }
  for (const key of ['shipments', 'invoices', 'documents', 'upload'] as const) {
    const v = patch[key];
    if (v === undefined) continue;
    next[key] = v === null ? undefined : v;
  }
  return portalSchema.parse(next);
}

export function portalEnabled(portal: ClientPortal | null | undefined): portal is ClientPortal {
  return Boolean(portal?.enabled);
}

/** ¿Este acceso es de un cliente del portal (o un administrador mirando «como cliente»)? */
export function portalActive(access: Pick<AppAccess, 'app' | 'role'>): boolean {
  return portalEnabled(access.app.portal) && access.role.key === access.app.portal.roleKey;
}

/** Las tablas que nombra el portal, con el campo que dice de quién es cada fila. */
export function portalSources(
  portal: ClientPortal,
): Array<{
  source: string;
  clientField: string;
  section: 'shipments' | 'invoices' | 'documents' | 'upload';
}> {
  const out: ReturnType<typeof portalSources> = [];
  for (const section of ['shipments', 'invoices', 'documents', 'upload'] as const) {
    const s = portal[section];
    if (s) out.push({ source: s.source, clientField: s.clientField, section });
  }
  return out;
}

// ---------------------------------------------------------------------------
// El rol «cliente»
// ---------------------------------------------------------------------------

/**
 * Los permisos del rol de los clientes, calculados del portal: cada tabla que
 * muestra se lee con `{field: clientField, equals: $user.<attribute>}` y nada
 * más; sólo la tabla de soportes se puede llenar (crear), y sólo sus campos.
 * Sin exportar ni editar. Deny by default: lo que el portal no nombra, el
 * cliente no lo ve.
 */
export function buildPortalRole(portal: ClientPortal): RoleInput {
  const tables: AppPermissions['tables'] = {};
  for (const { source, clientField } of portalSources(portal)) {
    tables[source] = {
      read: { field: clientField, equals: `$user.${portal.attribute}` },
      create: false,
      edit: 'none',
      actions: [],
    };
  }
  const up = portal.upload;
  if (up) {
    const fields = [up.fileField, up.noteField, up.kindField].filter((f): f is string =>
      Boolean(f),
    );
    tables[up.source] = {
      read: { field: up.clientField, equals: `$user.${portal.attribute}` },
      create: true,
      edit: 'none',
      fields,
      actions: [],
    };
  }
  return {
    key: portal.roleKey,
    name: 'Cliente',
    description: 'Portal de clientes: cada cliente ve sólo lo suyo.',
    permissions: { tables, export: false },
  };
}

/** Los problemas de un portal frente al catálogo (vacío = todo existe y es coherente). */
export function portalProblems(
  portal: ClientPortal,
  catalog: { trackers: CatalogTracker[]; screenSlugs: string[] },
): string[] {
  const out: string[] = [];
  const bySlug = new Map(catalog.trackers.map((t) => [t.slug, t]));
  const screens = new Set(catalog.screenSlugs);
  for (const section of ['shipments', 'invoices', 'documents', 'upload'] as const) {
    const s = portal[section];
    if (!s) continue;
    const where = `Portal › «${s.title}»`;
    const tracker = bySlug.get(s.source);
    if (!tracker) {
      out.push(`${where}: la tabla «${s.source}» no existe.`);
      continue;
    }
    const keys: Array<[string | undefined, string]> = [[s.clientField, 'el campo del cliente']];
    for (const [k, v] of Object.entries(s)) {
      if (k === 'columns' && Array.isArray(v))
        for (const c of v) keys.push([String(c), 'la columna']);
      else if (/Field$/.test(k) && typeof v === 'string' && k !== 'clientField')
        keys.push([v, 'el campo']);
    }
    for (const [key, label] of keys)
      if (key && fieldType(tracker, key) === null)
        out.push(`${where}: ${label} «${key}» no existe en «${tracker.name}».`);
    if (section === 'documents' && fieldType(tracker, portal.documents?.fileField ?? '') !== 'file')
      out.push(`${where}: «${portal.documents?.fileField}» no es un campo de archivo.`);
    if (section === 'upload') {
      if (fieldType(tracker, portal.upload?.fileField ?? '') !== 'file')
        out.push(`${where}: «${portal.upload?.fileField}» no es un campo de archivo.`);
    }
    if ('screen' in s && s.screen && !screens.has(s.screen))
      out.push(`${where}: abre la pantalla «${s.screen}», que no existe.`);
  }
  if (portal.enabled && portalSources(portal).length === 0)
    out.push('Portal: enciende al menos una sección (envíos, facturas, documentos o soportes).');
  return out;
}

/** La pantalla de «Subir soporte»: un formulario sobre la tabla de soportes y lo ya enviado. */
export function portalUploadSpec(portal: ClientPortal): ViewSpec | null {
  const up = portal.upload;
  if (!up) return null;
  const fields = [up.fileField, up.kindField, up.noteField].filter((f): f is string => Boolean(f));
  const parsed = viewSpecSchema.safeParse({
    version: 1,
    accent: 'primary',
    refreshSeconds: 0,
    editing: 'team',
    alerts: [],
    blocks: [
      {
        id: 'subir',
        type: 'form',
        width: 'full',
        tracker: up.source,
        title: up.title,
        intro: up.hint ?? 'Adjunta el soporte (foto o PDF). La empresa lo recibe de inmediato.',
        fields,
        submitLabel: 'Enviar soporte',
        successMessage: 'Recibimos tu soporte. Te avisaremos cuando lo revisemos.',
        editWindowMinutes: 0,
      },
      {
        id: 'enviados',
        type: 'table',
        width: 'full',
        tracker: up.source,
        title: 'Lo que has enviado',
        columns: ['created_at', ...fields.filter((f) => f !== up.fileField)],
        sort: { field: 'created_at', dir: 'desc' },
        limit: 20,
        searchable: false,
        openRecord: false,
      },
    ],
  });
  return parsed.success ? parsed.data : null;
}

/** La regla que avisa a la empresa cuando un cliente sube un soporte. */
export function portalAutomationInput(portal: ClientPortal, adminRoles: string[] = []) {
  if (!portal.upload) return null;
  return {
    name: PORTAL_AUTOMATION_NAME,
    enabled: true,
    trigger: {
      type: 'form_submitted' as const,
      tracker: portal.upload.source,
      screen: PORTAL_UPLOAD_SCREEN,
    },
    conditions: [],
    actions: [
      {
        type: 'notify_member' as const,
        members: [],
        roles: adminRoles,
        admins: true,
        title: 'Un cliente subió un soporte',
        body: 'Llegó un soporte nuevo al portal de clientes. Revísalo en «{{app}}».',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Lo que ve el cliente
// ---------------------------------------------------------------------------

export interface PortalFile {
  url: string;
  name: string;
  mime: string;
  size: number;
}

export interface PortalRow {
  id: string;
  title: string;
  cells: Array<{ label: string; value: string }>;
  status: { label: string; tone: 'primary' | 'emerald' | 'amber' | 'sky' | 'rose' } | null;
  href: string | null;
}

export interface PortalInvoice extends PortalRow {
  amount: string | null;
  due: string | null;
  overdue: boolean;
  paid: boolean;
  /** El enlace de pago, o null: sin él no hay botón «Pagar». */
  payUrl: string | null;
}

export type PortalSection =
  | { kind: 'shipments'; title: string; total: number; rows: PortalRow[] }
  | {
      kind: 'invoices';
      title: string;
      total: number;
      owed: string | null;
      overdueCount: number;
      rows: PortalInvoice[];
    }
  | {
      kind: 'documents';
      title: string;
      total: number;
      files: Array<{ rowId: string; label: string; file: PortalFile }>;
    }
  | { kind: 'upload'; title: string; hint: string | null; href: string | null };

export interface ComputedPortal {
  title: string;
  welcome: string | null;
  /** De qué cliente es quien mira (el valor de su atributo). Null = no se le asignó: no ve nada. */
  client: string | null;
  sections: PortalSection[];
  computedAt: string;
}

export interface PortalContext {
  now: Date;
  role: ResolvedRole;
  user: { id: string; name: string; attributes: Record<string, string>; external?: boolean };
  basePath: string;
  visibleScreens: ReadonlySet<string>;
  appName: string;
}

/** Sólo `https` o una ruta propia: un «enlace de pago» no puede ser `javascript:` ni `data:`. */
export function safePayUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  if (!url || url.length > 1000) return null;
  return /^https:\/\/[^\s]+$/i.test(url) ? url : null;
}

function readable(source: ViewSource | undefined, ctx: PortalContext): ViewRow[] {
  if (!source || source.blocked) return [];
  // Segunda cerradura: aunque la lectura ya traía el scope, cada fila se vuelve a comprobar.
  const access = rowAccessFor(ctx.role, ctx.user, source.tracker.slug);
  return source.rows.filter((row) => rowVisible(access, row));
}

function statusOf(
  tracker: CatalogTracker,
  row: ViewRow,
  key: string | undefined,
): PortalRow['status'] {
  if (!key) return null;
  const value = String(row.values[key] ?? '').trim();
  if (!value) return null;
  const options = tracker.fields.find((f) => f.key === key)?.options ?? [];
  const tones = optionTones(options.includes(value) ? options : [...options, value]);
  const idx = (options.includes(value) ? options : [...options, value]).indexOf(value);
  return { label: value, tone: tones[idx] ?? 'primary' };
}

function link(ctx: PortalContext, screen: string | undefined, id: string): string | null {
  return screen && ctx.visibleScreens.has(screen)
    ? `${ctx.basePath}/${screen}?fila=${encodeURIComponent(id)}`
    : null;
}

/**
 * El portal calculado a partir de fuentes leídas. Sin atributo del cliente no
 * hay secciones con filas: `rowAccessFor` da `equals` con valor null y
 * `rowVisible` lo niega (nunca «todo»).
 */
export function computePortalFromSources(
  portal: ClientPortal,
  sources: Map<string, ViewSource>,
  ctx: PortalContext,
): ComputedPortal {
  const today = todayIn(ctx.now);
  const sections: PortalSection[] = [];
  const client = ctx.user.attributes[portal.attribute]?.trim() || null;

  if (portal.shipments) {
    const s = portal.shipments;
    const source = sources.get(s.source);
    const rows = readable(source, ctx);
    if (source && !source.blocked) {
      const columns =
        s.columns.length > 0
          ? s.columns
          : source.tracker.fields
              .filter((f) => f.key !== s.clientField)
              .slice(0, 3)
              .map((f) => f.key);
      sections.push({
        kind: 'shipments',
        title: s.title,
        total: rows.length,
        rows: [...rows]
          .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
          .slice(0, s.limit)
          .map((row) => ({
            id: row.id,
            title: row.label || '—',
            cells: columns
              .filter((c) => c !== s.statusField)
              .map((c) => ({
                label: source.tracker.fields.find((f) => f.key === c)?.label ?? c,
                value: cellText(source.tracker, row, c) || '—',
              })),
            status: statusOf(source.tracker, row, s.statusField),
            href: link(ctx, s.screen, row.id),
          })),
      });
    }
  }

  if (portal.invoices) {
    const s = portal.invoices;
    const source = sources.get(s.source);
    const rows = readable(source, ctx);
    if (source && !source.blocked) {
      const paidSet = new Set(s.paidValues.map((v) => v.toLowerCase()));
      const dueOf = (row: ViewRow) => {
        const raw = s.dueField ? row.values[s.dueField] : undefined;
        return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
      };
      const items = rows.map((row) => {
        const status = String(row.values[s.statusField ?? ''] ?? '').trim();
        const paid = Boolean(status) && paidSet.has(status.toLowerCase());
        const due = dueOf(row);
        const amountRaw = s.amountField ? Number(row.values[s.amountField]) : Number.NaN;
        return { row, paid, due, amount: Number.isFinite(amountRaw) ? amountRaw : null };
      });
      items.sort((a, b) => {
        if (a.paid !== b.paid) return a.paid ? 1 : -1;
        if (a.due && b.due) return a.due < b.due ? -1 : 1;
        return a.due ? -1 : b.due ? 1 : 0;
      });
      const owing = items.filter((i) => !i.paid);
      const owed = s.amountField ? owing.reduce((sum, i) => sum + (i.amount ?? 0), 0) : null;
      const columns = s.columns.filter(
        (c) => c !== s.amountField && c !== s.dueField && c !== s.statusField,
      );
      sections.push({
        kind: 'invoices',
        title: s.title,
        total: rows.length,
        owed: owed === null ? null : formatValue(owed, 'money'),
        overdueCount: owing.filter((i) => i.due && i.due < today).length,
        rows: items.slice(0, s.limit).map(({ row, paid, due, amount }) => ({
          id: row.id,
          title: row.label || '—',
          cells: columns.map((c) => ({
            label: source.tracker.fields.find((f) => f.key === c)?.label ?? c,
            value: cellText(source.tracker, row, c) || '—',
          })),
          status: statusOf(source.tracker, row, s.statusField),
          href: null,
          amount: amount === null ? null : formatValue(amount, 'money'),
          due: due ? viewShortDate(due) : null,
          overdue: Boolean(!paid && due && due < today),
          paid,
          // «Pagar» existe sólo si la factura trae un enlace de pago válido y sigue debiéndose.
          payUrl: !paid && s.payUrlField ? safePayUrl(row.values[s.payUrlField]) : null,
        })),
      });
    }
  }

  if (portal.documents) {
    const s = portal.documents;
    const source = sources.get(s.source);
    const rows = readable(source, ctx);
    if (source && !source.blocked) {
      const files: Array<{ rowId: string; label: string; file: PortalFile }> = [];
      for (const row of [...rows].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))) {
        const parsed = parseFileValue(row.values[s.fileField]);
        if (!parsed) continue;
        const label =
          (s.labelField ? cellText(source.tracker, row, s.labelField) : '') || row.label;
        for (const f of parsed)
          files.push({
            rowId: row.id,
            label: label || f.name,
            file: { url: f.url, name: f.name, mime: f.mime, size: f.size },
          });
      }
      sections.push({
        kind: 'documents',
        title: s.title,
        total: files.length,
        files: files.slice(0, s.limit),
      });
    }
  }

  if (portal.upload && ctx.role.permissions.tables[portal.upload.source]?.create) {
    sections.push({
      kind: 'upload',
      title: portal.upload.title,
      hint: portal.upload.hint ?? null,
      href: ctx.visibleScreens.has(PORTAL_UPLOAD_SCREEN)
        ? `${ctx.basePath}/${PORTAL_UPLOAD_SCREEN}`
        : null,
    });
  }

  return {
    title: portal.title?.trim() || ctx.appName,
    welcome: portal.welcome?.trim() || null,
    client,
    sections,
    computedAt: ctx.now.toISOString(),
  };
}

/** Lee con el scope del rol y calcula el portal. */
export async function computePortal(
  db: SupabaseClient,
  access: AppAccess,
  options: { basePath: string; now?: Date },
): Promise<ComputedPortal | null> {
  const portal = access.app.portal;
  if (!portalEnabled(portal)) return null;
  const refs = [...new Set(portalSources(portal).map((s) => s.source))];
  const spec = namingSpec(refs);
  const sources = spec
    ? await loadViewSources(db, spec, {
        audience: access.role.admin ? 'team' : 'public',
        viewerId: access.role.admin ? access.user.id : null,
        scope: rowScopeFor(access.role, access.user, spec),
      })
    : new Map<string, ViewSource>();
  return computePortalFromSources(portal, sources, {
    now: options.now ?? new Date(),
    role: access.role,
    user: access.user,
    basePath: options.basePath,
    visibleScreens: new Set(
      access.screens.filter((s) => canSeeScreen(access.role, s.roles)).map((s) => s.slug),
    ),
    appName: access.app.name,
  });
}

export function portalNav(access: AppAccess): Array<{ slug: string; title: string; icon: string }> {
  return portalActive(access)
    ? [{ slug: PORTAL_SLUG, title: access.app.portal.title?.trim() || 'Mi portal', icon: 'Home' }]
    : [];
}

export function isPortalRoute(access: AppAccess, ref: string | null | undefined): boolean {
  return ref === PORTAL_SLUG && portalActive(access);
}

// ---------------------------------------------------------------------------
// Sugerencia: armar el portal sobre lo que ya existe
// ---------------------------------------------------------------------------

const RE_CLIENT = /client|cliente|customer|empresa|razon|razón/i;

function clientFieldOf(t: CatalogTracker): string | null {
  return (
    t.fields.find(
      (f) => (f.type === 'text' || f.type === 'select') && RE_CLIENT.test(`${f.key} ${f.label}`),
    )?.key ?? null
  );
}

/**
 * Un portal SUGERIDO sobre las tablas del espacio: envíos/pedidos, facturas,
 * documentos y soportes se reconocen por el nombre de la tabla y por tener una
 * columna de cliente. Devuelve sólo lo que encontró (o un portal sin secciones
 * si nada encaja); el administrador lo revisa antes de encenderlo.
 */
export function suggestPortal(
  trackers: CatalogTracker[],
  clientAttribute = 'cliente',
): ClientPortal {
  const own = trackers.filter((t) => !t.slug.includes('.'));
  const find = (re: RegExp) =>
    own.find((t) => re.test(`${t.slug} ${t.name}`) && clientFieldOf(t) !== null);
  const patch: Record<string, unknown> = { enabled: false, attribute: clientAttribute };
  const ship = find(/envio|envío|pedido|orden|guia|guía|despacho|entrega|remesa|servicio/i);
  if (ship) {
    const clientField = clientFieldOf(ship) as string;
    const state = ship.fields.find((f) => f.type === 'select')?.key;
    patch.shipments = {
      source: ship.slug,
      clientField,
      columns: ship.fields
        .filter(
          (f) =>
            f.key !== clientField && f.key !== state && ['text', 'date', 'money'].includes(f.type),
        )
        .slice(0, 3)
        .map((f) => f.key),
      ...(state ? { statusField: state } : {}),
    };
  }
  const inv = find(/factura|cobro|cartera|cuenta de cobro|invoice|recibo/i);
  if (inv) {
    const clientField = clientFieldOf(inv) as string;
    const money = inv.fields.find((f) => f.type === 'money')?.key;
    const due = inv.fields.find(
      (f) => f.type === 'date' && /venc|limite|límite|pago/i.test(`${f.key} ${f.label}`),
    )?.key;
    const state = inv.fields.find(
      (f) => f.type === 'select' && /estado|pago/i.test(`${f.key} ${f.label}`),
    )?.key;
    const payUrl = inv.fields.find(
      (f) => f.type === 'text' && /enlace|link|url|pse|pago_url/i.test(`${f.key} ${f.label}`),
    )?.key;
    patch.invoices = {
      source: inv.slug,
      clientField,
      ...(money ? { amountField: money } : {}),
      ...(due ? { dueField: due } : {}),
      ...(state ? { statusField: state } : {}),
      ...(payUrl ? { payUrlField: payUrl } : {}),
    };
  }
  const doc = find(/documento|certificad|contrato|archivo|soporte/i);
  const docFile = doc?.fields.find((f) => f.type === 'file')?.key;
  if (doc && docFile) {
    patch.documents = {
      source: doc.slug,
      clientField: clientFieldOf(doc) as string,
      fileField: docFile,
    };
  }
  const sup = find(/soporte|pago|comprobante|documento/i);
  const supFile = sup?.fields.find((f) => f.type === 'file')?.key;
  if (sup && supFile) {
    patch.upload = {
      source: sup.slug,
      clientField: clientFieldOf(sup) as string,
      fileField: supFile,
      noteField: sup.fields.find(
        (f) => f.type === 'longtext' || (f.type === 'text' && /nota|observ/i.test(f.key)),
      )?.key,
      kindField: sup.fields.find((f) => f.type === 'select')?.key,
    };
  }
  const parsed = portalSchema.safeParse(patch);
  return parsed.success ? parsed.data : EMPTY_PORTAL;
}

/** El atributo que lleva el scope de un rol (para mostrarlo al invitar). */
export function attributeOfRead(equals: string): string | null {
  return USER_ATTRIBUTE_RE.exec(equals)?.[1] ?? null;
}
