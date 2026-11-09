/**
 * Piezas visuales mínimas del portal de clientes. Copian el aspecto de ui.tsx (mismas clases de tema.css)
 * pero no lo importan: ui.tsx arrastra la barra de comandos y las lecturas internas (vuelos, tareas),
 * que un cliente de fuera no tiene por qué cargar ni puede leer.
 */
import { useEffect } from 'react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cortex } from '@cortex/app-sdk';
import { AlertCircle, AlertOctagon, AlertTriangle, CheckCircle2, CircleDot, Clock3, Minus, RefreshCw, X } from 'lucide-react';
import type { Tono } from './portal-datos';
import './tema.css';

const ICONO: Record<Tono, ReactNode> = {
  good: <CheckCircle2 size={14} aria-hidden="true" />,
  warn: <AlertTriangle size={14} aria-hidden="true" />,
  bad: <AlertOctagon size={14} aria-hidden="true" />,
  info: <CircleDot size={14} aria-hidden="true" />,
  neutral: <Clock3 size={14} aria-hidden="true" />,
  quiet: <Minus size={14} aria-hidden="true" />,
};

export function Chip({ tono = 'neutral', children }: { tono?: Tono; children: ReactNode }) {
  return (
    <span className={`oc-chip ${tono}`}>
      {ICONO[tono]}
      {children}
    </span>
  );
}

export function Boton({
  tono,
  chico,
  grande,
  icono,
  children,
  ...rest
}: {
  tono?: 'primario' | 'suave';
  chico?: boolean;
  grande?: boolean;
  icono?: ReactNode;
  children?: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`oc-btn ${tono ?? ''} ${chico ? 'chico' : ''} ${grande ? 'grande' : ''} ${rest.className ?? ''}`}>
      {icono}
      {children}
    </button>
  );
}

export function Campo({ etiqueta, ayuda, children }: { etiqueta: string; ayuda?: ReactNode; children: ReactNode }) {
  return (
    <div className="oc-campo">
      <span className="oc-label">{etiqueta}</span>
      {children}
      {ayuda ? <small>{ayuda}</small> : null}
    </div>
  );
}

export function Cargando({ filas = 3 }: { filas?: number }) {
  return (
    <div className="oc-cargando" aria-busy="true">
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
    <div className="oc-error" role="alert" style={{ margin: '10px 0' }}>
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

/** Hoja que sube desde abajo. Escape o tocar fuera la cierra. */
export function Hoja({ titulo, onCerrar, children }: { titulo: string; onCerrar: () => void; children: ReactNode }) {
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

export const avisar = (texto: string): void => {
  void cortex.ui.toast(texto).catch(() => undefined);
};

export const mensajeDe = (e: unknown): string => (e instanceof Error ? e.message : 'No se pudo completar. Intenta de nuevo.');
