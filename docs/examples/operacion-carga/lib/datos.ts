import { useCallback, useEffect, useRef, useState } from 'react';
import { cortex, useUser } from '@cortex/app-sdk';
import type { QueryOptions, SdkRow } from '@cortex/app-sdk';
import { N, hay } from './formato';
import { marcarCarga } from './vivo';
import { useRefrescoVivo } from './enVivo';

/**
 * Lectura de datos: filas del servidor → objetos con nombres claros.
 * Los permisos los decide el servidor; aquí solo se lee lo que el rol pueda ver.
 */

/** Texto de un valor (las relaciones llegan como {"id","label"} o JSON). */
export function T(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    if (v.startsWith('{')) {
      try {
        const o = JSON.parse(v) as { label?: string };
        if (o.label) return o.label;
      } catch {
        /* texto normal */
      }
    }
    return v;
  }
  if (typeof v === 'object') {
    const o = v as { label?: unknown; name?: unknown };
    if (typeof o.label === 'string') return o.label;
    if (typeof o.name === 'string') return o.name;
    return '';
  }
  return String(v);
}

export interface Rel {
  id: string;
  label: string;
}

/** Relación: id y nombre, venga como objeto, JSON o texto suelto. */
export function rel(v: unknown): Rel | null {
  if (!hay(v)) return null;
  if (typeof v === 'object' && v !== null) {
    const o = v as { id?: unknown; label?: unknown };
    if (o.id !== undefined) return { id: String(o.id), label: typeof o.label === 'string' ? o.label : String(o.id) };
    return null;
  }
  if (typeof v === 'string') {
    if (v.startsWith('{')) {
      try {
        const o = JSON.parse(v) as { id?: unknown; label?: unknown };
        if (o.id !== undefined) return { id: String(o.id), label: typeof o.label === 'string' ? o.label : String(o.id) };
      } catch {
        /* sigue */
      }
    }
    return { id: v, label: v };
  }
  return null;
}

export const relId = (v: unknown): string => rel(v)?.id ?? '';

export interface Archivo {
  url: string;
  name: string;
}

/** Archivos de un campo `file`: lista de URLs, de objetos o JSON. */
export function archivos(v: unknown): Archivo[] {
  if (!hay(v)) return [];
  let x: unknown = v;
  if (typeof x === 'string') {
    const s = x.trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try {
        x = JSON.parse(s);
      } catch {
        return [{ url: s, name: nombreDeUrl(s) }];
      }
    } else {
      return s
        .split(/[\n,]\s*(?=https?:)/)
        .filter(Boolean)
        .map((u) => ({ url: u.trim(), name: nombreDeUrl(u) }));
    }
  }
  const lista = Array.isArray(x) ? x : [x];
  const out: Archivo[] = [];
  for (const it of lista) {
    if (typeof it === 'string') out.push({ url: it, name: nombreDeUrl(it) });
    else if (it && typeof it === 'object') {
      const o = it as { url?: unknown; href?: unknown; name?: unknown; label?: unknown };
      const url = typeof o.url === 'string' ? o.url : typeof o.href === 'string' ? o.href : '';
      if (url) out.push({ url, name: typeof o.name === 'string' ? o.name : typeof o.label === 'string' ? o.label : nombreDeUrl(url) });
    }
  }
  return out;
}

function nombreDeUrl(u: string): string {
  try {
    const p = decodeURIComponent(u.split('?')[0]?.split('/').pop() ?? '');
    return p || 'archivo';
  } catch {
    return 'archivo';
  }
}

export const esImagen = (a: Archivo): boolean => /\.(png|jpe?g|webp|gif|heic|avif)$/i.test(a.name) || /\.(png|jpe?g|webp|gif|heic|avif)(\?|$)/i.test(a.url);

/* ───────────── Tipos de las filas ───────────── */

export interface Vuelo {
  id: string;
  numero: string;
  aerolinea: string;
  origen: string;
  fecha: string;
  hora: string;
  horaActual: string;
  horaReal: string;
  estado: string;
  posicion: string;
  kilosEsp: number;
  palletsEsp: number;
  piezasEsp: number;
  margenKilos: number;
  margenPallets: number;
  kilosRec: number | null;
  palletsRec: number | null;
  piezasRec: number | null;
  atendidoPor: string;
  atendidoPorId: string;
  llegadaHora: string;
  tomadoHora: string;
  cierreHora: string;
  minToma: number | null;
  minAtencion: number | null;
  minTotal: number | null;
  zonaToma: string;
  fueraZonaToma: string;
  observaciones: string;
  carpeta: string;
  documentos: Archivo[];
  /* Documental (campos nuevos: vacíos mientras no se apliquen los datos). */
  finDescargueFecha: string;
  finDescargueHora: string;
  manifiestoNumero: string;
  matricula: string;
  destino: string;
  estadoDocumental: string;
  inconsistencias: number;
  manifiestoArchivo: Archivo[];
  /** Asignación a operarios (campos nuevos): refs separados por coma y nombres para leer. */
  asignadosIds: string[];
  asignados: string;
}

/** Lista de refs «a, b, c» → arreglo limpio. */
export const refsDe = (v: unknown): string[] =>
  T(v)
    .split(/[,;\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

const nul = (v: unknown): number | null => (hay(v) ? N(v) : null);

export function aVuelo(r: SdkRow): Vuelo {
  const v = r.values;
  return {
    id: r.id,
    numero: T(v.numero_vuelo) || r.label,
    aerolinea: T(v.aerolinea),
    origen: T(v.origen),
    fecha: T(v.fecha).slice(0, 10),
    hora: T(v.hora_estimada),
    horaActual: T(v.hora_estimada_actual) || T(v.hora_estimada),
    horaReal: T(v.hora_real),
    estado: T(v.estado) || 'Programado',
    posicion: T(v.posicion),
    kilosEsp: N(v.kilos_esperados),
    palletsEsp: N(v.pallets_esperados),
    piezasEsp: N(v.piezas_esperadas),
    margenKilos: N(v.margen_kilos_pct),
    margenPallets: N(v.margen_pallets),
    kilosRec: nul(v.kilos_recibidos),
    palletsRec: nul(v.pallets_recibidos),
    piezasRec: nul(v.piezas_recibidas),
    atendidoPor: T(v.atendido_por),
    atendidoPorId: T(v.atendido_por_id),
    llegadaHora: T(v.llegada_hora),
    tomadoHora: T(v.tomado_hora),
    cierreHora: T(v.cierre_hora),
    minToma: nul(v.min_llegada_toma),
    minAtencion: nul(v.min_atencion),
    minTotal: nul(v.min_total),
    zonaToma: T(v.zona_toma),
    fueraZonaToma: T(v.fuera_zona_toma),
    observaciones: T(v.observaciones),
    carpeta: T(v.carpeta_drive),
    documentos: archivos(v.documentos),
    finDescargueFecha: T(v.fin_descargue_fecha).slice(0, 10),
    finDescargueHora: T(v.fin_descargue_hora),
    manifiestoNumero: T(v.manifiesto_numero),
    matricula: T(v.matricula),
    destino: T(v.destino),
    estadoDocumental: T(v.estado_documental),
    inconsistencias: N(v.inconsistencias),
    manifiestoArchivo: archivos(v.manifiesto_archivo),
    asignadosIds: refsDe(v.asignados_ids),
    asignados: T(v.asignados),
  };
}

export interface Atencion {
  id: string;
  vueloId: string;
  vuelo: string;
  operario: string;
  operarioId: string;
  estado: string;
  fecha: string;
  horaInicio: string;
  horaFin: string;
  kilosEsp: number;
  palletsEsp: number;
  piezasEsp: number;
  margenKilos: number;
  margenPallets: number;
  kilosRec: number | null;
  palletsRec: number | null;
  piezasRec: number | null;
  difKilos: number | null;
  difPallets: number | null;
  difPiezas: number | null;
  fueraDeMargen: boolean;
  fueraDeZona: boolean;
  zonaInicio: string;
  zonaCierre: string;
  novedades: string;
  fotos: Archivo[];
  costoEquipos: number;
  motivoRechazo: string;
  notaCorreccion: string;
  creada: string;
}

export function aAtencion(r: SdkRow): Atencion {
  const v = r.values;
  const f = T(v.fuera_de_margen);
  return {
    id: r.id,
    vueloId: relId(v.vuelo),
    vuelo: T(v.vuelo) || r.label,
    operario: T(v.operario),
    operarioId: T(v.operario_id),
    estado: T(v.estado) || 'En atención',
    fecha: T(v.fecha_atencion).slice(0, 10),
    horaInicio: T(v.hora_inicio),
    horaFin: T(v.hora_fin),
    kilosEsp: N(v.kilos_esperados),
    palletsEsp: N(v.pallets_esperados),
    piezasEsp: N(v.piezas_esperadas),
    margenKilos: N(v.margen_kilos_pct),
    margenPallets: N(v.margen_pallets),
    kilosRec: nul(v.kilos_recibidos),
    palletsRec: nul(v.pallets_recibidos),
    piezasRec: nul(v.piezas_recibidas),
    difKilos: nul(v.dif_kilos),
    difPallets: nul(v.dif_pallets),
    difPiezas: nul(v.dif_piezas),
    fueraDeMargen: f === 'Sí' || (f !== '' && f !== 'No' && f.toLowerCase() !== 'dentro'),
    fueraDeZona: T(v.fuera_de_zona) === 'Sí',
    zonaInicio: T(v.zona_inicio),
    zonaCierre: T(v.zona_cierre),
    novedades: T(v.novedades),
    fotos: archivos(v.fotos),
    costoEquipos: N(v.costo_equipos_cop),
    motivoRechazo: T(v.motivo_rechazo),
    notaCorreccion: T(v.nota_correccion),
    creada: r.created_at,
  };
}

export interface Equipo {
  id: string;
  atencionId: string;
  atencion: string;
  tarifaId: string;
  equipo: string;
  proveedor: string;
  moneda: string;
  tarifa: number;
  cantidad: number;
  costoTotal: number;
  costoCop: number;
  porPagar: number;
  estadoCosto: string;
  foto: Archivo[];
  fueraDeZona: string;
  creado: string;
}

export function aEquipo(r: SdkRow): Equipo {
  const v = r.values;
  return {
    id: r.id,
    atencionId: relId(v.atencion),
    atencion: T(v.atencion),
    tarifaId: relId(v.tarifa),
    equipo: T(v.equipo) || T(v.tarifa),
    proveedor: T(v.proveedor),
    moneda: T(v.moneda) || 'COP',
    tarifa: N(v.tarifa_unitaria),
    cantidad: N(v.cantidad),
    costoTotal: N(v.costo_total),
    costoCop: N(v.costo_cop),
    porPagar: N(v.costo_por_pagar),
    estadoCosto: T(v.estado_costo),
    foto: archivos(v.foto),
    fueraDeZona: T(v.fuera_de_zona),
    creado: r.created_at,
  };
}

export interface Evento {
  id: string;
  tipo: string;
  descripcion: string;
  vueloId: string;
  vuelo: string;
  atencionId: string;
  equipo: string;
  proveedor: string;
  costo: number;
  operario: string;
  fecha: string;
  hora: string;
  critico: boolean;
  estado: string;
  fueraDeZona: boolean;
  zona: string;
  fotos: Archivo[];
  documentos: Archivo[];
  nota: string;
  creado: string;
  /** Tarea a la que pertenece (vacío si es de un vuelo). */
  tareaId: string;
  /** Centro de atención: quién lo vio / lo tomó y cuándo (vacíos mientras no se apliquen los datos). */
  vistoPor: string;
  vistoEn: string;
  tomadoPor: string;
  escalado: boolean;
}

export function aEvento(r: SdkRow): Evento {
  const v = r.values;
  const crit = T(v.critico);
  return {
    id: r.id,
    tipo: T(v.tipo),
    descripcion: T(v.descripcion),
    vueloId: relId(v.vuelo),
    vuelo: T(v.vuelo),
    atencionId: relId(v.atencion),
    equipo: T(v.equipo),
    proveedor: T(v.proveedor),
    costo: N(v.costo),
    operario: T(v.operario),
    fecha: T(v.fecha).slice(0, 10),
    hora: T(v.hora),
    critico: crit !== '' && crit !== 'No' && crit !== 'false',
    estado: T(v.estado) || 'Abierto',
    fueraDeZona: T(v.fuera_de_zona) === 'Sí',
    zona: T(v.zona),
    fotos: archivos(v.fotos),
    documentos: archivos(v.documentos),
    nota: T(v.nota_supervisor),
    creado: r.created_at,
    tareaId: relId(v.tarea),
    vistoPor: T(v.visto_por),
    vistoEn: T(v.visto_en),
    tomadoPor: T(v.tomado_por),
    escalado: ['Sí', 'true', '1', 'si'].includes(T(v.escalado).toLowerCase()) || v.escalado === true || v.escalado === 1,
  };
}

export interface Tarifa {
  id: string;
  equipo: string;
  proveedor: string;
  moneda: string;
  tarifa: number;
  etiqueta: string;
}

export function aTarifa(r: SdkRow): Tarifa {
  const v = r.values;
  return {
    id: r.id,
    equipo: T(v.equipo),
    proveedor: T(v.proveedor),
    moneda: T(v.moneda) || 'COP',
    tarifa: N(v.tarifa),
    etiqueta: T(v.etiqueta) || r.label,
  };
}

export interface Guia {
  id: string;
  guia: string;
  tipo: string;
  madre: string;
  cliente: string;
  clienteId: string;
  parciales: string;
  prealertaId: string;
  etapa: string;
  piezasEsp: number;
  kilosEsp: number;
  palletsEsp: number;
  piezasRec: number | null;
  kilosRec: number | null;
  palletsRec: number | null;
  difKilos: number | null;
  novedad: string;
  vueloId: string;
  estadoCruce: string;
  listaPrefactura: string;
  falta: string;
}

export function aGuia(r: SdkRow): Guia {
  const v = r.values;
  return {
    id: r.id,
    guia: T(v.guia) || r.label,
    tipo: T(v.tipo_guia),
    madre: T(v.guia_madre),
    cliente: T(v.cliente),
    clienteId: relId(v.cliente),
    parciales: T(v.parciales),
    prealertaId: relId(v.prealerta),
    etapa: T(v.etapa),
    piezasEsp: N(v.piezas_esperadas),
    kilosEsp: N(v.kilos_esperados),
    palletsEsp: N(v.pallets_esperados),
    piezasRec: nul(v.piezas_recibidas),
    kilosRec: nul(v.kilos_recibidos),
    palletsRec: nul(v.pallets_recibidos),
    difKilos: nul(v.dif_kilos),
    novedad: T(v.novedad_guia),
    vueloId: relId(v.vuelo),
    estadoCruce: T(v.estado_cruce),
    listaPrefactura: T(v.lista_prefactura),
    falta: T(v.falta),
  };
}

export interface Prealerta {
  id: string;
  guia: string;
  cliente: string;
  numeroVuelo: string;
  aerolinea: string;
  origen: string;
  fecha: string;
  piezas: number;
  kilos: number;
  estado: string;
  descripcion: string;
  vueloId: string;
  estadoCruce: string;
  guiaNorm: string;
  documento: Archivo[];
  canal: string;
  creada: string;
}

export function aPrealerta(r: SdkRow): Prealerta {
  const v = r.values;
  return {
    id: r.id,
    guia: T(v.guia) || r.label,
    cliente: T(v.cliente),
    numeroVuelo: T(v.numero_vuelo),
    aerolinea: T(v.aerolinea),
    origen: T(v.origen),
    fecha: T(v.fecha_estimada).slice(0, 10),
    piezas: N(v.piezas),
    kilos: N(v.kilos),
    estado: T(v.estado),
    descripcion: T(v.descripcion_carga),
    vueloId: relId(v.vuelo),
    estadoCruce: T(v.estado_cruce),
    guiaNorm: T(v.guia_normalizada),
    documento: archivos(v.documento),
    canal: T(v.canal),
    creada: r.created_at,
  };
}

/* ───────────── Lectura con sondeo ───────────── */

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export interface Carga<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/** Respaldo cuando hay tiempo real: el sondeo se alarga a esto (por si se cae la conexión en vivo). */
export const RESPALDO_VIVO_MS = 120_000;

/**
 * Carga con `fn` ahora, cuando cambian `deps` y cada `refreshMs` (solo con la pantalla visible).
 * Con `tablasVivo` (tablas que lee `fn`) además recarga en 1–2 s cuando alguna cambia; `refreshMs` queda de respaldo.
 */
export function useCarga<T>(fn: () => Promise<T>, deps: unknown[], refreshMs?: number, tablasVivo?: string[]): Carga<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const vivo = useRef(true);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const mi = ++seq.current;
    try {
      const x = await fnRef.current();
      if (!vivo.current || mi !== seq.current) return;
      setData(x);
      setError(null);
      marcarCarga();
    } catch (e) {
      if (vivo.current && mi === seq.current) setError(e instanceof Error ? e.message : 'No se pudo cargar.');
    } finally {
      if (vivo.current && mi === seq.current) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` decide cuándo se vuelve a cargar.
  useEffect(() => {
    vivo.current = true;
    setLoading(true);
    void refresh();
    const timer = refreshMs ? setInterval(() => visible() && void refresh(), refreshMs) : null;
    const onVis = () => refreshMs && visible() && void refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      vivo.current = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh, refreshMs, ...deps]);

  useRefrescoVivo(tablasVivo ?? [], () => (tablasVivo?.length ? refresh() : undefined));

  return { data, loading, error, refresh };
}

/** Trae todas las páginas de una tabla (500 por llamada) hasta `max` filas. */
export async function traerTodo(table: string, opts: QueryOptions = {}, max = 1500): Promise<SdkRow[]> {
  const out: SdkRow[] = [];
  const pagina = 500;
  for (let off = 0; off < max; off += pagina) {
    const res = await cortex.tables.query(table, { ...opts, limit: Math.min(pagina, max - off), offset: off });
    out.push(...res.rows);
    if (res.rows.length < pagina) break;
  }
  return out;
}

/**
 * Filas de `table` cuyo campo relación `campo` apunta a `id`. Primero se pide
 * por igualdad; si el servidor no filtra relaciones por id, se filtra aquí.
 */
export async function porRelacion(table: string, campo: string, id: string, extra: QueryOptions = {}): Promise<SdkRow[]> {
  const directo = await cortex.tables.query(table, { ...extra, where: { ...(extra.where ?? {}), [campo]: id }, limit: 500 });
  const ok = directo.rows.filter((r) => relId(r.values[campo]) === id);
  if (ok.length) return ok;
  const todo = await cortex.tables.query(table, { ...extra, order: extra.order ?? { field: 'created_at', dir: 'desc' }, limit: 500 });
  return todo.rows.filter((r) => relId(r.values[campo]) === id);
}

/** Vuelos recientes (los más nuevos primero). */
export async function cargarVuelos(max = 500): Promise<Vuelo[]> {
  const rows = await traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, max);
  return rows.map(aVuelo);
}

/** Acciones de flujo que el rol tiene en una tabla; null mientras no se sabe. */
export function useAcciones(table: string): { tiene: (clave: string) => boolean; lista: string[] | null } {
  const { data } = useCarga(
    async () => {
      try {
        return (await cortex.tables.listActions(table)).map((a) => a.key);
      } catch {
        return null;
      }
    },
    [table],
  );
  return {
    lista: data,
    // Si no se pudo saber, se muestran: el servidor responde claro si no corresponde.
    tiene: (clave) => (data ? data.includes(clave) : true),
  };
}

/** Rol (clave) de quien mira. */
export function useRol(): { rol: string; nombre: string; id: string; ref: string; cargando: boolean } {
  const { user, loading } = useUser();
  // `ref` (mismo formato que cortex.people.list) llega en versiones nuevas del SDK; si no, el id.
  const ref = (user as { ref?: string } | null)?.ref ?? user?.id ?? '';
  return { rol: user?.role ?? '', nombre: user?.name ?? '', id: user?.id ?? '', ref, cargando: loading };
}

/** Opciones de un campo `select` leídas de la tabla; si falla se usa el respaldo. */
export function useOpciones(table: string, campo: string, respaldo: readonly string[]): string[] {
  const { data } = useCarga(
    async () => {
      try {
        const ts = await cortex.tables.list();
        const t = ts.find((x) => x.id === table || x.name === table);
        return t?.fields.find((f) => f.key === campo)?.options ?? null;
      } catch {
        return null;
      }
    },
    [table, campo],
  );
  return data && data.length ? data : [...respaldo];
}
