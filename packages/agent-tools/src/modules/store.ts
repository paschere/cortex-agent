import { CortexError, ForbiddenError, ValidationError, logger } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { writeAuditEvent } from '../audit';
import { isCompanyManager } from '../directory/store';
import {
  type CortexModule,
  MODULES,
  MODULE_KEYS,
  type ModuleKey,
  moduleByKey,
  moduleForTool,
} from './catalog';

/**
 * LA OTRA MITAD DEL CONTRATO DE `catalog.ts`: QUÉ TIENE PRENDIDO CADA EMPRESA.
 *
 * Una fila en `company_modules` (0186) sólo existe si alguien tocó el
 * interruptor; sin fila manda `defaultOn`. Leer es UNA consulta por empresa,
 * con una memoria corta pegada al handle de la base: el chat, el filtro de
 * herramientas y `runTool` preguntan varias veces en el mismo turno y pagan
 * una sola lectura. `getOrgScopedClient` crea un handle por petición, así que
 * en la práctica la memoria dura lo que dura el turno; el tope de 30 s cubre
 * los handles que viven más (el piloto, un trabajo largo).
 *
 * Si la lectura falla, se cae al estado por defecto y se anota: un tropiezo
 * de la base no puede tumbar cada herramienta gobernada, y el peor caso es
 * ofrecer durante un turno algo que la empresa apagó — que igual no borra ni
 * mueve nada que no se pudiera antes.
 */

const TTL_MS = 30_000;
const CACHE = new WeakMap<object, { at: number; value: Promise<Set<ModuleKey>> }>();

export interface ModuleRow {
  module_key: string;
  enabled: boolean;
  updated_by?: string | null;
  updated_at?: string | null;
}

export function isModuleKey(value: string): value is ModuleKey {
  return (MODULE_KEYS as readonly string[]).includes(value);
}

/** Lo que tiene una empresa que nunca tocó un interruptor. */
export function defaultModules(): Set<ModuleKey> {
  return new Set(MODULES.filter((m) => m.defaultOn).map((m) => m.key));
}

/** Por defecto + lo que la empresa decidió. Una clave que el código ya no conoce se ignora. */
export function resolveModules(rows: readonly ModuleRow[]): Set<ModuleKey> {
  const out = defaultModules();
  for (const row of rows) {
    if (!isModuleKey(row.module_key)) continue;
    if (row.enabled) out.add(row.module_key);
    else out.delete(row.module_key);
  }
  return out;
}

async function readRows(db: SupabaseClient): Promise<ModuleRow[]> {
  const { data, error } = await db
    .from('company_modules')
    .select('module_key, enabled, updated_by, updated_at');
  if (error) throw error;
  return (data ?? []) as ModuleRow[];
}

/** Los módulos prendidos de esta empresa. Una lectura, con memoria corta por handle. */
export function enabledModules(
  db: SupabaseClient,
  opts: { fresh?: boolean } = {},
): Promise<Set<ModuleKey>> {
  const hit = CACHE.get(db);
  if (!opts.fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = readRows(db)
    .then(resolveModules)
    .catch((err) => {
      logger.warn({ err }, 'company_modules: no se pudo leer; uso el estado por defecto');
      // Un fallo no se recuerda: el siguiente intento vuelve a leer.
      CACHE.delete(db);
      return defaultModules();
    });
  CACHE.set(db, { at: Date.now(), value });
  return value;
}

export async function isModuleEnabled(db: SupabaseClient, key: ModuleKey): Promise<boolean> {
  return (await enabledModules(db)).has(key);
}

/** Olvidar lo leído (después de escribir). */
export function forgetModules(db: SupabaseClient): void {
  CACHE.delete(db);
}

// ---------------------------------------------------------------------------
// Herramientas
// ---------------------------------------------------------------------------

/** El texto que recibe quien llama una herramienta de un módulo apagado. */
export function moduleOffMessage(module: Pick<CortexModule, 'label'>): string {
  return `El módulo ${module.label} está apagado; un administrador lo prende en Ajustes › Módulos.`;
}

export class ModuleDisabledError extends CortexError {
  constructor(
    public readonly module: ModuleKey,
    label: string,
  ) {
    super(moduleOffMessage({ label }), 'MODULE_DISABLED');
    this.name = 'ModuleDisabledError';
  }
}

/** ¿Esta herramienta se puede ofrecer con estos módulos prendidos? Las que no son de ningún módulo, siempre. */
export function toolAllowedByModules(toolId: string, enabled: ReadonlySet<ModuleKey>): boolean {
  const m = moduleForTool(toolId);
  return !m || enabled.has(m.key);
}

/** Lo de esta lista que sí se puede ofrecer. */
export function withoutDisabledModules<T extends { id: string }>(
  tools: readonly T[],
  enabled: ReadonlySet<ModuleKey>,
): T[] {
  return tools.filter((t) => toolAllowedByModules(t.id, enabled));
}

/**
 * El módulo apagado que gobierna esta herramienta, o null si puede correr.
 * Sólo lee la base si la herramienta es de algún módulo.
 */
export async function disabledModuleForTool(
  db: SupabaseClient,
  toolId: string,
): Promise<CortexModule | null> {
  const m = moduleForTool(toolId);
  if (!m) return null;
  return (await enabledModules(db)).has(m.key) ? null : m;
}

// ---------------------------------------------------------------------------
// Cambiar: la regla de dependencias, pura
// ---------------------------------------------------------------------------

export interface ModuleChange {
  key: ModuleKey;
  enabled: boolean;
}

export type ModulePlan =
  | { ok: true; changes: ModuleChange[]; next: Set<ModuleKey> }
  | { ok: false; message: string };

/** Los que necesita un módulo, con los que necesitan esos, sin repetir. */
export function requiredClosure(key: ModuleKey): ModuleKey[] {
  const out: ModuleKey[] = [];
  const stack = [...(moduleByKey(key).requires ?? [])];
  while (stack.length) {
    const k = stack.pop() as ModuleKey;
    if (out.includes(k) || k === key) continue;
    out.push(k);
    stack.push(...(moduleByKey(k).requires ?? []));
  }
  return out;
}

/** Los prendidos que dejarían de tener sentido sin este. */
export function requiredBy(key: ModuleKey, enabled: ReadonlySet<ModuleKey>): CortexModule[] {
  return MODULES.filter((m) => enabled.has(m.key) && (m.requires ?? []).includes(key));
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} y ${labels[labels.length - 1]}`;
}

/**
 * Qué pasa si se piden estos cambios. Prender un módulo prende también lo que
 * necesita; apagar uno que otro prendido necesita se niega con una frase que
 * dice qué apagar primero — salvo que ese otro se apague en el mismo pedido.
 * Sólo devuelve lo que de verdad cambia.
 */
export function planModuleChanges(
  current: ReadonlySet<ModuleKey>,
  requested: readonly ModuleChange[],
): ModulePlan {
  const next = new Set(current);
  const offs = requested.filter((c) => !c.enabled).map((c) => c.key);
  for (const c of requested) {
    if (!c.enabled) continue;
    next.add(c.key);
    for (const r of requiredClosure(c.key)) next.add(r);
  }
  for (const key of offs) {
    if (
      requested.some((c) => c.enabled && (c.key === key || requiredClosure(c.key).includes(key)))
    ) {
      const m = moduleByKey(key);
      return {
        ok: false,
        message: `No puedo prender y apagar ${m.label} en el mismo cambio.`,
      };
    }
    next.delete(key);
  }
  for (const key of offs) {
    const blockers = requiredBy(key, next);
    if (blockers.length) {
      const m = moduleByKey(key);
      const names = joinLabels(blockers.map((b) => b.label));
      return {
        ok: false,
        message: `No puedo apagar ${m.label}: ${names} ${blockers.length === 1 ? 'lo necesita' : 'lo necesitan'}. Apaga primero ${names}.`,
      };
    }
  }
  const changes: ModuleChange[] = MODULE_KEYS.filter((k) => current.has(k) !== next.has(k)).map(
    (k) => ({ key: k, enabled: next.has(k) }),
  );
  return { ok: true, changes, next };
}

// ---------------------------------------------------------------------------
// Cambiar: la escritura
// ---------------------------------------------------------------------------

export interface SetModulesResult {
  /** Lo que cambió de verdad, incluidas las dependencias que se prendieron solas. */
  changed: ModuleChange[];
  enabled: Set<ModuleKey>;
}

/**
 * Prender o apagar varios módulos de una vez (un preset, por ejemplo). Sólo
 * quien administra la empresa o es su dueño. Deja una fila de auditoría con
 * lo que cambió.
 */
export async function setModules(
  db: SupabaseClient,
  input: { changes: readonly ModuleChange[]; userId: string; via?: string },
): Promise<SetModulesResult> {
  for (const c of input.changes) {
    if (!isModuleKey(c.key)) throw new ValidationError(`No conozco el módulo «${c.key}».`);
  }
  if (!(await isCompanyManager(db, input.userId))) {
    throw new ForbiddenError(
      'Sólo un administrador o el dueño de la empresa puede prender o apagar módulos.',
    );
  }
  const current = await enabledModules(db, { fresh: true });
  const plan = planModuleChanges(current, input.changes);
  if (!plan.ok) throw new ValidationError(plan.message);
  if (plan.changes.length === 0) return { changed: [], enabled: current };

  const now = new Date().toISOString();
  const { error } = await db.from('company_modules').upsert(
    plan.changes.map((c) => ({
      module_key: c.key,
      enabled: c.enabled,
      updated_by: input.userId,
      updated_at: now,
    })),
    { onConflict: 'organization_id,module_key' },
  );
  forgetModules(db);
  if (error) throw error;

  await writeAuditEvent({
    db,
    userId: input.userId,
    toolId: 'modules.toggle',
    input: input.changes,
    status: 'ok',
    latencyMs: 0,
    metadata: {
      requested: input.changes,
      changed: plan.changes,
      via: input.via ?? 'settings',
    },
  });
  return { changed: plan.changes, enabled: plan.next };
}

/** Prender o apagar un módulo. Prender prende también lo que necesita. */
export async function setModule(
  db: SupabaseClient,
  input: { key: ModuleKey; enabled: boolean; userId: string; via?: string },
): Promise<SetModulesResult> {
  return setModules(db, {
    changes: [{ key: input.key, enabled: input.enabled }],
    userId: input.userId,
    via: input.via,
  });
}

// ---------------------------------------------------------------------------
// Para la pantalla
// ---------------------------------------------------------------------------

export interface ModuleState {
  key: ModuleKey;
  enabled: boolean;
  /** Nadie lo ha tocado: manda el catálogo. */
  isDefault: boolean;
  updatedBy: string | null;
  updatedAt: string | null;
}

/** Cada módulo del catálogo con su estado, en el orden del catálogo. */
export async function readModuleStates(db: SupabaseClient): Promise<ModuleState[]> {
  const rows = await readRows(db);
  const enabled = resolveModules(rows);
  const byKey = new Map(
    rows.filter((r) => isModuleKey(r.module_key)).map((r) => [r.module_key, r]),
  );
  return MODULES.map((m) => {
    const row = byKey.get(m.key);
    return {
      key: m.key,
      enabled: enabled.has(m.key),
      isDefault: !row,
      updatedBy: row?.updated_by ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

/** Lo que un preset cambiaría hoy, sin escribir nada. */
export function previewModuleChanges(
  current: ReadonlySet<ModuleKey>,
  preset: { on: readonly ModuleKey[]; off: readonly ModuleKey[] },
): ModulePlan {
  // Lo que el preset apaga pero otro de sus prendidos necesita, no se apaga.
  const on = new Set<ModuleKey>(preset.on);
  for (const k of preset.on) for (const r of requiredClosure(k)) on.add(r);
  const off = preset.off.filter((k) => !on.has(k));
  // Y lo que apaga pero otro módulo prendido (fuera del preset) necesita, tampoco.
  const after = new Set([...current, ...on]);
  const safeOff = off.filter((k) => requiredBy(k, after).every((m) => off.includes(m.key)));
  return planModuleChanges(current, [
    ...[...on].map((key) => ({ key, enabled: true })),
    ...safeOff.map((key) => ({ key, enabled: false })),
  ]);
}
