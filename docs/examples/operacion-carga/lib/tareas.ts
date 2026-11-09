import { useMemo } from 'react';
import { cortex } from '@cortex/app-sdk';
import type { SdkRow } from '@cortex/app-sdk';
import { T, aEquipo, aEvento, archivos, porRelacion, refsDe, rel, useCarga } from './datos';
import type { Archivo, Equipo, Evento } from './datos';
import { hoyBogota, horaAhora } from './tiempo';
import { isoBogota, msDeIso, soloExistentes } from './documental';
import type { Esquema } from './documental';
import type { Tono } from './estados';
import { N } from './formato';
import { subirArchivo } from './ui';
import { actualizarSS, esEncolado, insertarSS } from './enVivo';
import type { Encolado } from './enVivo';
import { agregarPendiente } from './SinSenal';

/**
 * TAREAS RÁPIDAS (v4): recoger, entregar, trasladar, apoyar un vuelo. Las crea el supervisor o
 * el documental, escogiendo a quién; el operario las inicia, anota el proceso, los equipos y las
 * termina. Aquí vive el tipo, la lectura, las personas asignables y el cierre con costos.
 */

export const TIPOS_TAREA = ['Recoger', 'Entregar', 'Traslado', 'Apoyo a vuelo', 'Revisión', 'Otro'] as const;
export const PLANTILLAS = ['Recoger', 'Entregar', 'Traslado', 'Apoyo a vuelo'] as const;
export const ESTADOS_TAREA = ['Asignada', 'En curso', 'Terminada', 'Cancelada'] as const;
export const TONO_TAREA: Record<string, Tono> = { Asignada: 'warn', 'En curso': 'info', Terminada: 'good', Cancelada: 'quiet' };

/** Tablas y campos que el plan agrega (para avisar cuando todavía no se aplican). */
export const REQUERIDO_TAREAS: Record<string, string[]> = {
  tareas_operacion: ['titulo', 'tipo', 'desde', 'hasta', 'asignados_ids', 'asignados', 'prioridad', 'estado', 'inicio', 'fin', 'duracion_min', 'costo_equipos', 'costo_otros', 'costo_total'],
};

export interface Tarea {
  id: string;
  titulo: string;
  tipo: string;
  descripcion: string;
  desde: string;
  hasta: string;
  vueloId: string;
  vuelo: string;
  asignadosIds: string[];
  asignados: string;
  prioridad: string;
  paraFecha: string;
  paraHora: string;
  estado: string;
  inicio: string;
  fin: string;
  duracionMin: number | null;
  costoEquipos: number;
  costoOtros: number;
  costoTotal: number;
  creadaPor: string;
  notasCierre: string;
  fotos: Archivo[];
  creado: string;
}

export function aTarea(r: SdkRow): Tarea {
  const v = r.values;
  const dur = T(v.duracion_min);
  return {
    id: r.id,
    titulo: T(v.titulo) || r.label,
    tipo: T(v.tipo) || 'Otro',
    descripcion: T(v.descripcion),
    desde: T(v.desde),
    hasta: T(v.hasta),
    vueloId: rel(v.vuelo)?.id ?? '',
    vuelo: T(v.vuelo),
    asignadosIds: refsDe(v.asignados_ids),
    asignados: T(v.asignados),
    prioridad: T(v.prioridad) || 'Normal',
    paraFecha: T(v.para_fecha).slice(0, 10),
    paraHora: T(v.para_hora),
    estado: T(v.estado) || 'Asignada',
    inicio: T(v.inicio),
    fin: T(v.fin),
    duracionMin: dur === '' ? null : N(dur),
    costoEquipos: N(v.costo_equipos),
    costoOtros: N(v.costo_otros),
    costoTotal: N(v.costo_total),
    creadaPor: T(v.creada_por),
    notasCierre: T(v.notas_cierre),
    fotos: archivos(v.fotos),
    creado: r.created_at,
  };
}

export const nombresDe = (t: { asignados: string }): string[] =>
  t.asignados
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** ¿Esta fila (tarea o vuelo) está asignada a quien mira? */
export const esMia = (ids: string[], miRef: string): boolean => !!miRef && ids.includes(miRef);

/** Lee las tareas (las más nuevas primero). Si la tabla no existe todavía devuelve `[]`. */
export async function cargarTareas(max = 600): Promise<Tarea[]> {
  try {
    const out: SdkRow[] = [];
    for (let off = 0; off < max; off += 500) {
      const res = await cortex.tables.query('tareas_operacion', { order: { field: 'created_at', dir: 'desc' }, limit: Math.min(500, max - off), offset: off });
      out.push(...res.rows);
      if (res.rows.length < 500) break;
    }
    return out.map(aTarea);
  } catch {
    return [];
  }
}

/* ───────────── Personas asignables ───────────── */

export interface Persona {
  ref: string;
  name: string;
  roleKey: string;
  roleName: string;
  onShift: boolean;
}

type ListaPersonas = (opts?: { roles?: string[] }) => Promise<Persona[]>;

/**
 * Operarios (u otros roles) a quienes se puede asignar, los de turno abierto primero.
 * Si esta versión de Cortex aún no trae `people.list`, `faltaActualizar` es true.
 */
export function usePersonas(roles?: string[]): { personas: Persona[]; cargando: boolean; error: string | null; faltaActualizar: boolean } {
  const lista = (cortex as unknown as { people?: { list?: ListaPersonas } }).people?.list;
  const clave = (roles ?? []).join(',');
  const { data, loading, error } = useCarga(
    async () => {
      if (!lista) return null;
      const xs = await lista(roles?.length ? { roles } : undefined);
      return [...xs].sort((a, b) => Number(b.onShift) - Number(a.onShift) || a.name.localeCompare(b.name));
    },
    // biome-ignore lint/correctness/useExhaustiveDependencies: `clave` representa a `roles`.
    [clave, !!lista],
    120_000,
  );
  return useMemo(
    () => ({ personas: data ?? [], cargando: loading, error: lista ? error : null, faltaActualizar: !lista }),
    [data, loading, error, lista],
  );
}

/* ───────────── Lugares usados ───────────── */

/** Lugares de tareas anteriores, del más usado al menos usado (sin repetir mayúsculas/minúsculas). */
export function lugaresUsados(tareas: Tarea[]): string[] {
  const m = new Map<string, { n: number; texto: string }>();
  for (const t of tareas)
    for (const l of [t.desde, t.hasta]) {
      const x = l.trim();
      if (!x) continue;
      const k = x.toLowerCase();
      const e = m.get(k);
      if (e) e.n++;
      else m.set(k, { n: 1, texto: x });
    }
  return [...m.values()].sort((a, b) => b.n - a.n || a.texto.localeCompare(b.texto)).map((x) => x.texto);
}

/* ───────────── Eventos de la tarea ───────────── */

export type TipoEventoTarea = 'Inicio' | 'En proceso' | 'Uso de equipo' | 'Fin';

/** Ubicación de quien registra, como texto, o null si no hay (no dio permiso, sin señal…). */
export async function ubicacionTexto(): Promise<string | null> {
  try {
    const ub = await cortex.location.current();
    if (!ub) return null;
    return ub.zone ?? `${ub.lat.toFixed(5)}, ${ub.lng.toFixed(5)}${ub.inside === false ? ' (fuera de zonas)' : ''}`;
  } catch {
    return null;
  }
}

/**
 * Crea un evento de la tarea en eventos_operacion (tipo, tarea, vuelo, fecha, hora, ubicación).
 * Si el tipo todavía no existe en el select del servidor, se guarda como «Otro» con el tipo en el texto.
 */
export async function registrarEvento(
  esq: Esquema,
  a: { tipo: TipoEventoTarea; tarea: Tarea; descripcion?: string; costo?: number; equipo?: string; proveedor?: string; fotos?: File[] },
  opts: { sinSenal?: boolean } = {},
): Promise<SdkRow | Encolado> {
  // Sin señal el SDK guarda la escritura en la cola del aparato: la fila vuelve como `{ queued, localId }`.
  const crear = (v: Record<string, unknown>) => (opts.sinSenal ? insertarSS('eventos_operacion', v) : cortex.tables.insert('eventos_operacion', v));
  const zona = await ubicacionTexto();
  const base = {
    descripcion: a.descripcion?.trim() || a.tipo,
    tarea: a.tarea.id,
    vuelo: a.tarea.vueloId || undefined,
    fecha: hoyBogota(),
    hora: horaAhora(),
    zona: zona ?? undefined,
    costo: a.costo && a.costo > 0 ? a.costo : undefined,
    equipo: a.equipo || undefined,
    proveedor: a.proveedor || undefined,
  };
  let fila: SdkRow | Encolado;
  try {
    fila = await crear(soloExistentes(esq, 'eventos_operacion', { tipo: a.tipo, ...base }));
  } catch (e) {
    // Tipo aún no agregado al select: se registra igual para no perder el rastro.
    try {
      fila = await crear(soloExistentes(esq, 'eventos_operacion', { ...base, tipo: 'Otro', descripcion: `[${a.tipo}] ${base.descripcion}` }));
    } catch {
      throw e;
    }
  }
  const id = esEncolado(fila) ? fila.localId : fila.id;
  if (esEncolado(fila)) agregarPendiente({ localId: fila.localId, tabla: 'eventos_operacion', clave: a.tarea.id, titulo: a.tipo, detalle: base.descripcion !== a.tipo ? base.descripcion : undefined });
  for (const f of a.fotos ?? []) await subirArchivo(f, { table: 'eventos_operacion', id, field: 'fotos' }, { sinSenal: !!opts.sinSenal });
  return fila;
}

/* ───────────── Cierre con costos ───────────── */

/** Costo en pesos de un equipo (el de la fila, o tarifa × cantidad si es en pesos). */
export const costoEquipoCop = (e: Equipo): number => e.costoCop || (e.moneda === 'COP' ? e.costoTotal || e.tarifa * e.cantidad : 0);

export async function equiposDeTarea(id: string): Promise<Equipo[]> {
  try {
    return (await porRelacion('equipos_usados', 'tarea', id)).map(aEquipo);
  } catch {
    return [];
  }
}

export async function eventosDeTarea(id: string): Promise<Evento[]> {
  try {
    return (await porRelacion('eventos_operacion', 'tarea', id)).map(aEvento).sort((a, b) => a.creado.localeCompare(b.creado));
  } catch {
    return [];
  }
}

export interface CierreCalculado {
  duracionMin: number;
  costoEquipos: number;
  costoOtros: number;
  costoTotal: number;
}

/** Duración y costos de una tarea a partir de sus equipos y de los costos de sus eventos. */
export function calcularCierre(t: Pick<Tarea, 'inicio' | 'creado'>, equipos: Equipo[], eventos: Evento[], finMs = Date.now()): CierreCalculado {
  const ini = msDeIso(t.inicio) ?? msDeIso(t.creado) ?? finMs;
  const costoEquipos = equipos.reduce((s, e) => s + costoEquipoCop(e), 0);
  const costoOtros = eventos.reduce((s, e) => s + e.costo, 0);
  return { duracionMin: Math.max(0, Math.round((finMs - ini) / 60_000)), costoEquipos, costoOtros, costoTotal: costoEquipos + costoOtros };
}

/** Termina la tarea: último evento (Fin), cálculos y estado Terminada. Devuelve lo calculado. */
export async function terminarTarea(
  esq: Esquema,
  t: Tarea,
  notas: string,
  fotos: File[],
  opts: { sinSenal?: boolean; equipos?: Equipo[]; eventos?: Evento[] } = {},
): Promise<CierreCalculado> {
  await registrarEvento(esq, { tipo: 'Fin', tarea: t, descripcion: notas.trim() || 'Tarea terminada' }, { sinSenal: opts.sinSenal });
  // Sin señal no se puede releer del servidor: se calcula con lo que la pantalla ya tenía a la vista.
  const [eq, ev]: [Equipo[], Evento[]] =
    opts.sinSenal && (opts.equipos || opts.eventos) && !navigator.onLine
      ? [opts.equipos ?? [], opts.eventos ?? []]
      : await Promise.all([equiposDeTarea(t.id), eventosDeTarea(t.id)]);
  const c = calcularCierre(t, eq, ev);
  const escribir = opts.sinSenal ? actualizarSS : cortex.tables.update;
  await escribir(
    'tareas_operacion',
    t.id,
    soloExistentes(esq, 'tareas_operacion', {
      estado: 'Terminada',
      fin: isoBogota(Date.now()),
      duracion_min: c.duracionMin,
      costo_equipos: c.costoEquipos,
      costo_otros: c.costoOtros,
      costo_total: c.costoTotal,
      notas_cierre: notas.trim() || undefined,
    }),
  );
  for (const f of fotos) await subirArchivo(f, { table: 'tareas_operacion', id: t.id, field: 'fotos' }, { sinSenal: !!opts.sinSenal });
  return c;
}

/* ───────────── Resúmenes para costos e indicadores ───────────── */

export interface FilaResumen {
  clave: string;
  tareas: number;
  minutos: number;
  costo: number;
  costoEquipos: number;
  costoOtros: number;
}

/** Tareas terminadas agrupadas por tipo o por operario (el costo se reparte entre los asignados). */
export function resumirTareas(tareas: Tarea[], por: 'tipo' | 'operario'): FilaResumen[] {
  const m = new Map<string, FilaResumen>();
  const fila = (k: string): FilaResumen => {
    let f = m.get(k);
    if (!f) {
      f = { clave: k, tareas: 0, minutos: 0, costo: 0, costoEquipos: 0, costoOtros: 0 };
      m.set(k, f);
    }
    return f;
  };
  for (const t of tareas.filter((x) => x.estado === 'Terminada')) {
    const claves = por === 'tipo' ? [t.tipo] : nombresDe(t).length ? nombresDe(t) : ['Sin asignar'];
    const n = claves.length;
    for (const k of claves) {
      const f = fila(k);
      f.tareas += 1 / n;
      f.minutos += t.duracionMin ?? 0;
      f.costo += t.costoTotal / n;
      f.costoEquipos += t.costoEquipos / n;
      f.costoOtros += t.costoOtros / n;
    }
  }
  return [...m.values()].sort((a, b) => b.costo - a.costo || b.tareas - a.tareas);
}
