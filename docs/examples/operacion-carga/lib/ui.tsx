import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, ChangeEvent } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertCircle, AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight, Camera, CheckCircle2, CircleDot, Clock3, FileText, Minus, Paperclip, RefreshCw, Search, X } from 'lucide-react';
import type { Tono } from './estados';
import type { Archivo } from './datos';
import { esImagen } from './datos';
import { reducirImagen } from './archivos';
import { Sparkline } from './graficos';
import { BarraComandos } from './Comandos';
import { textoHace, useVivo } from './vivo';
import { subirSS } from './enVivo';
import './tema.css';

/** Componentes de interfaz compartidos por todas las pantallas. */

/** «Actualizado hace Xs»: con punto vivo; en ámbar si el dato está viejo (más de 90 s). */
export function Actualizado() {
  const { hace } = useVivo();
  if (hace === null) return null;
  const viejo = hace > 90;
  return (
    <span className={`oc-vivo ${viejo ? 'viejo' : ''}`} role="status" title={viejo ? 'El dato puede estar desactualizado' : 'Los datos se actualizan solos'}>
      <span className={`oc-punto ${viejo ? '' : 'vivo'}`} aria-hidden="true" />
      {viejo ? `Dato de ${textoHace(hace).replace('hace ', 'hace ')}` : `Actualizado ${textoHace(hace)}`}
    </span>
  );
}

export function Pantalla({
  clase = '',
  titulo,
  sub,
  acciones,
  children,
}: {
  clase?: string;
  titulo: string;
  sub?: ReactNode;
  acciones?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`oc ${clase}`}>
      <div className="oc-wrap">
        <header className="oc-head">
          <div className="oc-head-t">
            <h1>{titulo}</h1>
            {sub ? <p>{sub}</p> : null}
          </div>
          <div className="oc-acciones">
            <Actualizado />
            <button type="button" className="oc-btn chico oc-cmdk" onClick={() => window.dispatchEvent(new Event('oc-comandos'))} aria-label="Buscar vuelo, guía o tarea (Ctrl o Cmd + K)">
              <Search size={15} /> Buscar <kbd>Ctrl K</kbd>
            </button>
            {acciones}
          </div>
        </header>
        {children}
      </div>
      <BarraComandos />
    </div>
  );
}

export function Tarjeta({
  titulo,
  icono,
  tono,
  chico,
  children,
  derecha,
}: {
  titulo?: ReactNode;
  icono?: ReactNode;
  tono?: 'alerta' | 'aviso' | 'ok';
  chico?: boolean;
  derecha?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className={`oc-card ${tono ?? ''} ${chico ? 'tight' : ''}`}>
      {titulo ? (
        <h2 style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            {icono}
            {titulo}
          </span>
          {derecha}
        </h2>
      ) : null}
      {children}
    </section>
  );
}

const ICONO_TONO: Record<Tono, ReactNode> = {
  good: <CheckCircle2 size={14} aria-hidden="true" />,
  warn: <AlertTriangle size={14} aria-hidden="true" />,
  bad: <AlertOctagon size={14} aria-hidden="true" />,
  info: <CircleDot size={14} aria-hidden="true" />,
  accent: <CircleDot size={14} aria-hidden="true" />,
  neutral: <Clock3 size={14} aria-hidden="true" />,
  quiet: <Minus size={14} aria-hidden="true" />,
};

export function Chip({ tono = 'neutral', vivo, children }: { tono?: Tono; vivo?: boolean; children: ReactNode }) {
  return (
    <span className={`oc-chip ${tono}`}>
      {vivo ? <span className="oc-punto vivo" aria-hidden="true" /> : ICONO_TONO[tono]}
      {children}
    </span>
  );
}

/** Estados «vivos» del vuelo: llevan un punto que pulsa. */
export const ES_VIVO = new Set(['En camino', 'Aterrizó', 'En atención', 'Por aprobar', 'Abierto']);

export function Boton({
  tono,
  chico,
  grande,
  icono,
  children,
  ...rest
}: {
  tono?: 'primario' | 'ok' | 'malo' | 'aviso' | 'suave' | 'senal';
  chico?: boolean;
  grande?: boolean;
  icono?: ReactNode;
  children?: ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`oc-btn ${tono ?? ''} ${chico ? 'chico' : ''} ${grande ? 'grande' : ''} ${rest.className ?? ''}`}>
      {icono}
      {children}
    </button>
  );
}

/** Variación contra el periodo anterior. `mejorSiBaja`: para costos, tiempos y diferencias. */
export function Delta({ actual, previo, mejorSiBaja, unidad = '%' }: { actual: number; previo: number | null | undefined; mejorSiBaja?: boolean; unidad?: '%' | 'pp' }) {
  if (previo === null || previo === undefined || !Number.isFinite(previo)) return <span className="oc-delta nd">sin periodo anterior</span>;
  const d = unidad === 'pp' ? actual - previo : previo === 0 ? (actual === 0 ? 0 : 100) : ((actual - previo) / Math.abs(previo)) * 100;
  const r = Math.round(d * 10) / 10;
  if (r === 0) return <span className="oc-delta igual"><Minus size={13} /> igual que antes</span>;
  const bueno = mejorSiBaja ? r < 0 : r > 0;
  const txt = `${r > 0 ? '+' : '−'}${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(Math.abs(r))} ${unidad === 'pp' ? 'pp' : '%'}`;
  return (
    <span className={`oc-delta ${bueno ? 'bueno' : 'malo'}`}>
      {r > 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />} {txt} <span className="vs">vs. periodo anterior</span>
    </span>
  );
}

export function Metrica({
  etiqueta,
  valor,
  tono,
  pista,
  spark,
  onClick,
  activo,
  icono,
}: {
  etiqueta: string;
  valor: ReactNode;
  tono?: 'warn' | 'bad' | 'good' | 'info';
  pista?: ReactNode;
  spark?: number[];
  onClick?: () => void;
  activo?: boolean;
  icono?: ReactNode;
}) {
  const len = typeof valor === 'string' || typeof valor === 'number' ? String(valor).length : 0;
  const cuerpo = (
    <>
      <span className="et">
        {icono}
        {etiqueta}
      </span>
      <strong className={len > 12 ? 'muylargo' : len > 8 ? 'largo' : ''}>{valor}</strong>
      {pista ? <small>{pista}</small> : null}
      {spark && spark.length > 1 ? (
        <span className="spark">
          <Sparkline valores={spark} />
        </span>
      ) : null}
    </>
  );
  if (onClick)
    return (
      <button type="button" className={`oc-kpi clic ${tono ?? ''} ${activo ? 'activo' : ''}`} onClick={onClick} aria-pressed={activo}>
        {cuerpo}
      </button>
    );
  return <div className={`oc-kpi ${tono ?? ''}`}>{cuerpo}</div>;
}

/** Frase narrativa de la pantalla: una oración que dice cómo va todo, con cifras en negrita. */
export function Frase({ tono = 'neutral', icono, children }: { tono?: 'neutral' | 'bad' | 'warn' | 'good'; icono?: ReactNode; children: ReactNode }) {
  return (
    <p className={`oc-frase ${tono}`}>
      {icono}
      <span>{children}</span>
    </p>
  );
}

export function Cargando({ filas = 3 }: { filas?: number }) {
  return (
    <div className="oc-cargando" aria-busy="true">
      <span className="sr-only" style={{ position: 'absolute', left: -9999 }}>
        Cargando…
      </span>
      {Array.from({ length: filas }, (_, i) => (
        <div key={i} className="oc-sk" />
      ))}
    </div>
  );
}

export function Vacio({ titulo, children }: { titulo: string; children?: ReactNode }) {
  return (
    <div className="oc-vacio">
      <svg width="96" height="64" viewBox="0 0 96 64" fill="none" aria-hidden="true">
        <path d="M4 52h88" stroke="#c9d2de" strokeWidth="2" strokeDasharray="6 6" strokeLinecap="round" />
        <path d="M22 40l46-18 10 4-30 14-8 10-6-2 4-9-16 3z" fill="#e6eefb" stroke="#1f4ea1" strokeWidth="2" strokeLinejoin="round" />
        <circle cx="80" cy="12" r="5" fill="#1f4ea1" opacity=".85" />
      </svg>
      <strong>{titulo}</strong>
      {children}
    </div>
  );
}

export function ErrorCaja({ mensaje, reintentar }: { mensaje: string; reintentar?: () => void }) {
  return (
    <div className="oc-error" role="alert">
      <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <AlertCircle size={18} /> {mensaje}
      </span>
      {reintentar ? (
        <Boton chico onClick={reintentar} icono={<RefreshCw size={15} />}>
          Reintentar
        </Boton>
      ) : null}
    </div>
  );
}

/** Estado de carga estándar para una lista: cargando, error o vacío. */
export function Estado({
  cargando,
  error,
  vacio,
  tituloVacio,
  textoVacio,
  reintentar,
  children,
}: {
  cargando: boolean;
  error: string | null;
  vacio: boolean;
  tituloVacio: string;
  textoVacio?: ReactNode;
  reintentar?: () => void;
  children: ReactNode;
}) {
  if (error && vacio) return <ErrorCaja mensaje={error} reintentar={reintentar} />;
  if (cargando && vacio) return <Cargando />;
  if (vacio) return <Vacio titulo={tituloVacio}>{textoVacio}</Vacio>;
  return <>{children}</>;
}

export function Campo({
  etiqueta,
  ayuda,
  children,
}: {
  etiqueta: string;
  ayuda?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="oc-campo">
      <span className="oc-label">{etiqueta}</span>
      {children}
      {ayuda ? <small>{ayuda}</small> : null}
    </div>
  );
}

export function Segmentos<T extends string>({
  valor,
  opciones,
  onChange,
}: {
  valor: T;
  opciones: { id: T; texto: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="oc-seg" role="group">
      {opciones.map((o) => (
        <button key={o.id} type="button" aria-pressed={valor === o.id} onClick={() => onChange(o.id)}>
          {o.texto}
        </button>
      ))}
    </div>
  );
}

/** Hoja que sube desde abajo (modal). Se cierra con Escape o tocando fuera. */
export function Hoja({
  titulo,
  onCerrar,
  children,
}: {
  titulo: string;
  onCerrar: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onCerrar();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onCerrar]);
  return (
    <div className="oc-vel" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="oc-hoja" role="dialog" aria-modal="true" aria-label={titulo}>
        <div className="oc-hoja-top">
          <h2>{titulo}</h2>
          <Boton chico tono="suave" onClick={onCerrar} aria-label="Cerrar" icono={<X size={18} />} />
        </div>
        {children}
      </div>
    </div>
  );
}

/** Botón que abre el selector de archivos o la cámara (el iframe usa su propio <input type=file>). */
export function SelectorArchivo({
  etiqueta,
  accept = 'image/*',
  camara,
  multiple,
  disabled,
  grande,
  tono,
  onArchivos,
}: {
  etiqueta: string;
  accept?: string;
  camara?: 'environment' | 'user';
  multiple?: boolean;
  disabled?: boolean;
  grande?: boolean;
  tono?: 'primario' | 'ok';
  onArchivos: (f: File[]) => void;
}) {
  const alCambiar = (e: ChangeEvent<HTMLInputElement>) => {
    const fs = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (fs.length) onArchivos(fs);
  };
  return (
    <label className={`oc-btn oc-sel-arch ${tono ?? ''} ${grande ? 'grande' : ''}`} aria-disabled={disabled}>
      {camara ? <Camera size={20} /> : <Paperclip size={20} />}
      {etiqueta}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        {...(camara ? { capture: camara } : {})}
        onChange={alCambiar}
      />
    </label>
  );
}

/** Miniaturas (imágenes) y enlaces (otros documentos) de un campo de archivos. */
export function Adjuntos({ lista }: { lista: Archivo[] }) {
  const [grande, setGrande] = useState<Archivo | null>(null);
  if (!lista.length) return null;
  return (
    <>
      <div className="oc-fotos">
        {lista.map((a) =>
          esImagen(a) ? (
            <img key={a.url} className="oc-foto" src={a.url} alt={a.name} loading="lazy" onClick={() => setGrande(a)} />
          ) : (
            <a key={a.url} className="oc-doc" href={a.url} target="_blank" rel="noreferrer">
              <FileText size={16} /> {a.name}
            </a>
          ),
        )}
      </div>
      {grande ? (
        <Hoja titulo={grande.name} onCerrar={() => setGrande(null)}>
          <img className="oc-foto grande" src={grande.url} alt={grande.name} />
        </Hoja>
      ) : null}
    </>
  );
}

/** Aviso breve arriba del marco. */
export const avisar = (texto: string): void => {
  void cortex.ui.toast(texto).catch(() => undefined);
};

export const mensajeDe = (e: unknown): string => (e instanceof Error ? e.message : 'No se pudo completar. Intenta de nuevo.');

/**
 * Ejecuta una operación con «ocupado» y error visible. Devuelve true si salió bien.
 * Evita doble toque: mientras corre, `ocupado` es true.
 */
export function useOperacion(): {
  ocupado: boolean;
  error: string | null;
  limpiar: () => void;
  correr: (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
} {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);
  const correr = useCallback(async (fn: () => Promise<unknown>, ok?: string) => {
    setOcupado(true);
    setError(null);
    try {
      await fn();
      if (ok) avisar(ok);
      return true;
    } catch (e) {
      if (vivo.current) setError(mensajeDe(e));
      return false;
    } finally {
      if (vivo.current) setOcupado(false);
    }
  }, []);
  return { ocupado, error, limpiar: () => setError(null), correr };
}

/** Pregunta con la confirmación del marco; si no responde, no se hace nada. */
export async function confirmar(texto: string, etiqueta = 'Confirmar', peligro = false): Promise<boolean> {
  try {
    return await cortex.ui.confirm(texto, { confirmLabel: etiqueta, danger: peligro });
  } catch {
    return false;
  }
}

/** Sube una foto/archivo reduciéndola antes si es imagen grande. */
export async function subirArchivo(
  file: File,
  destino: { table: string; id: string; field: string },
  opts: { sinSenal?: boolean } = {},
): Promise<void> {
  const f = await reducirImagen(file);
  // `sinSenal`: si no hay red, la foto queda en la cola del aparato y se sube sola (id = localId de la fila que espera).
  if (opts.sinSenal) await subirSS(f, { ...destino, name: f.name });
  else await cortex.files.upload(f, { ...destino, name: f.name });
}

/** Campo numérico que acepta coma o punto; entrega el texto tal cual para no pelear con el cursor. */
export function Numero({
  valor,
  onChange,
  onBlur,
  placeholder,
  disabled,
  id,
}: {
  valor: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      value={valor}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value.replace(/[^\d.,\-]/g, ''))}
      onBlur={onBlur}
    />
  );
}

/** Cantidad con − / + grandes (≥ 64 px) y teclado numérico: para guantes y sol. */
export function Paso({
  etiqueta,
  valor,
  onChange,
  onBlur,
  paso = 1,
  unidad,
  esperado,
}: {
  etiqueta: string;
  valor: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  paso?: number;
  unidad?: string;
  esperado?: string;
}) {
  const n = Number(valor.replace(',', '.'));
  const mover = (d: number) => {
    const base = Number.isFinite(n) ? n : 0;
    const nuevo = Math.max(0, Math.round((base + d) * 100) / 100);
    onChange(String(nuevo));
  };
  return (
    <div className="oc-paso-b">
      <span className="oc-label">
        {etiqueta}
        {esperado ? <small> · esperado {esperado}</small> : null}
      </span>
      <div className="oc-paso">
        <button type="button" aria-label={`Quitar ${paso} a ${etiqueta}`} onClick={() => mover(-paso)}>
          −
        </button>
        <input type="text" inputMode="decimal" autoComplete="off" aria-label={etiqueta} value={valor} placeholder="0" onChange={(e) => onChange(e.target.value.replace(/[^\d.,]/g, ''))} onBlur={onBlur} />
        <button type="button" aria-label={`Sumar ${paso} a ${etiqueta}`} onClick={() => mover(paso)}>
          +
        </button>
        {unidad ? <span className="oc-sub">{unidad}</span> : null}
      </div>
    </div>
  );
}

export function Tabla({
  columnas,
  children,
  pie,
}: {
  columnas: { t: string; n?: boolean }[];
  children: ReactNode;
  pie?: ReactNode;
}) {
  return (
    <div className="oc-tabla-w">
      <table className="oc-tabla">
        <thead>
          <tr>
            {columnas.map((c) => (
              <th key={c.t} className={c.n ? 'n' : ''}>
                {c.t}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
        {pie ? <tfoot>{pie}</tfoot> : null}
      </table>
    </div>
  );
}
