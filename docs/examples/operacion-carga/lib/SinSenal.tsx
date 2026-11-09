import { useEffect, useState } from 'react';
import { CloudOff, RefreshCw, Wifi } from 'lucide-react';
import { horaAhora } from './tiempo';
import { useBuzon, useSinRed } from './enVivo';
import { Boton, Chip } from './ui';
import './centro.css';

/**
 * Operario sin señal: lo que se escribe queda guardado en el aparato (cola del SDK) y se envía solo.
 * Aquí viven (1) el almacén de «pendientes» que las listas muestran con su chip y (2) la barra
 * «3 cambios esperando señal · Reintentar».
 */

export interface Pendiente {
  localId: string;
  tabla: string;
  /** Fila padre (atención, tarea, vuelo) a la que pertenece. */
  clave: string;
  titulo: string;
  detalle?: string;
  hora: string;
}

let lista: Pendiente[] = [];
const oyentes = new Set<() => void>();
const avisar = () => {
  for (const f of oyentes) f();
};

export function agregarPendiente(p: Omit<Pendiente, 'hora'>): void {
  lista = [...lista, { ...p, hora: horaAhora() }];
  avisar();
}
export function limpiarPendientes(): void {
  if (!lista.length) return;
  lista = [];
  avisar();
}

/** Pendientes de una tabla (y de una fila padre, si se dice). */
export function usePendientes(tabla: string, clave?: string): Pendiente[] {
  const [, setN] = useState(0);
  useEffect(() => {
    const f = () => setN((n) => n + 1);
    oyentes.add(f);
    return () => {
      oyentes.delete(f);
    };
  }, []);
  return lista.filter((p) => p.tabla === tabla && (clave === undefined || p.clave === clave));
}

/** Tarjeta de una fila que todavía no llegó al servidor. */
export function FilaPendiente({ p }: { p: Pendiente }) {
  return (
    <li className="oc-item hot oc-pendiente">
      <div className="oc-item-top">
        <b>{p.titulo}</b>
        <Chip tono="warn">Pendiente de enviar</Chip>
      </div>
      {p.detalle ? <p>{p.detalle}</p> : null}
      <div className="oc-meta"><span>Anotado a las {p.hora}</span></div>
    </li>
  );
}

/**
 * Barra fija arriba: sin señal, cambios esperando y fallidos. `alVaciar` se llama cuando la cola
 * queda en cero (para recargar los datos).
 */
export function BarraSinSenal({ alVaciar }: { alVaciar?: () => void }) {
  const buzon = useBuzon();
  const sinRed = useSinRed();
  const [reintentando, setReintentando] = useState(false);
  const esperando = buzon.pending;
  // Cuando la cola se vacía y hay red, los «pendientes» ya son filas reales.
  useEffect(() => {
    if (esperando === 0 && !sinRed) {
      limpiarPendientes();
      alVaciar?.();
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: solo cuando cambia el conteo o la red.
  }, [esperando, sinRed]);

  if (!sinRed && esperando === 0 && !buzon.failed) return null;
  const falla = buzon.failed > 0;
  const texto = esperando
    ? `${esperando} ${esperando === 1 ? 'cambio esperando' : 'cambios esperando'} señal`
    : falla
      ? `${buzon.failed} ${buzon.failed === 1 ? 'cambio no se pudo enviar' : 'cambios no se pudieron enviar'}`
      : 'Sin señal';
  return (
    <div className={`oc-sinsenal ${sinRed ? 'sin' : ''} ${falla ? 'falla' : ''}`} role="status" aria-live="polite">
      <span className="ic">{sinRed ? <CloudOff size={22} /> : <Wifi size={22} />}</span>
      <span className="tx">
        <b>{texto}</b>
        <small>
          {sinRed
            ? 'Sin señal: sigue trabajando, todo queda guardado en tu celular y se envía solo.'
            : esperando
              ? 'Hay señal. Enviando lo guardado…'
              : 'Toca Reintentar.'}
        </small>
      </span>
      <Boton
        chico
        disabled={reintentando || (sinRed && !esperando && !falla)}
        icono={<RefreshCw size={15} />}
        onClick={async () => {
          setReintentando(true);
          try {
            await buzon.retry();
          } finally {
            setReintentando(false);
          }
        }}
      >
        Reintentar
      </Boton>
    </div>
  );
}
