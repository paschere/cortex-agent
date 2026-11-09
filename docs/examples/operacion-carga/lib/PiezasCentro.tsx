import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Radio, WifiOff } from 'lucide-react';
import { cortex } from '@cortex/app-sdk';
import type { Atencion, Evento, Vuelo } from './datos';
import type { EstadoVivo } from './enVivo';
import { Etapas, TarjetaEmbarque } from './Piezas';
import { LineaVuelo } from './LineaVuelo';
import { ETAPAS, reloj, tonoCrono } from './centro';
import type { Activa } from './centro';
import { Boton } from './ui';
import './centro.css';

/** Piezas visuales del centro de atención. */

const sinMovimiento = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Número que sube o baja contando (700 ms) y da un saltito al cambiar. */
export function Cifra({ n }: { n: number }) {
  const [mostrado, setMostrado] = useState(n);
  const [salto, setSalto] = useState(0);
  const previo = useRef(n);
  useEffect(() => {
    const desde = previo.current;
    if (desde === n) return;
    previo.current = n;
    setSalto((x) => x + 1);
    if (sinMovimiento()) {
      setMostrado(n);
      return;
    }
    const t0 = performance.now();
    let raf = 0;
    const paso = (t: number) => {
      const k = Math.min(1, (t - t0) / 700);
      const e = 1 - (1 - k) ** 3;
      setMostrado(Math.round(desde + (n - desde) * e));
      if (k < 1) raf = requestAnimationFrame(paso);
    };
    raf = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(raf);
  }, [n]);
  return (
    <span key={salto} className={`cn-cifra ${salto ? 'salto' : ''}`} aria-label={String(n)}>
      {mostrado}
    </span>
  );
}

/** «En vivo» con punto latiendo / «Reconectando…» / «Sin conexión en vivo». */
export function IndicadorConexion({ estado, hayVivo }: { estado: EstadoVivo; hayVivo: boolean }) {
  if (estado === 'live') {
    return (
      <span className="cn-conex en-vivo" role="status" title="Los cambios llegan en 1 o 2 segundos">
        <span className="oc-punto vivo" aria-hidden="true" /> En vivo
      </span>
    );
  }
  if (estado === 'reconnecting') {
    return (
      <span className="cn-conex reconectando" role="status">
        <Radio size={15} className="gira" aria-hidden="true" /> Reconectando…
      </span>
    );
  }
  return (
    <span className="cn-conex apagado" role="status" title={hayVivo ? 'Sin conexión en vivo' : 'Esta versión actualiza por sondeo'}>
      <WifiOff size={15} aria-hidden="true" /> {hayVivo ? 'Sin conexión en vivo' : 'Actualiza cada pocos minutos'}
    </span>
  );
}

/** Cronómetro vivo de la etapa actual, en verde / ámbar / rojo frente a su objetivo. */
export function Crono({ desde, objetivoMin, ahora }: { desde: number; objetivoMin: number; ahora: number }) {
  const seg = Math.max(0, (ahora - desde) / 1000);
  const t = tonoCrono(seg / 60, objetivoMin);
  return (
    <span className={`cn-crono ${t}`} title={`Objetivo: ${objetivoMin} min`}>
      {reloj(seg)}
    </span>
  );
}

/** Tarjeta de una atención activa: riel de etapas llegó → tomado → en proceso → cerrado con cronómetros. */
export function TarjetaActiva({ a, ahora, onAbrir }: { a: Activa; ahora: number; onAbrir?: () => void }) {
  const t = tonoCrono((ahora - a.desde) / 60_000, a.objetivoMin);
  const dur = (s: number | null) => (s === null ? '' : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);
  return (
    <li className={`cn-activa ${t}`}>
      <button type="button" className="cn-activa-top" onClick={onAbrir} disabled={!onAbrir}>
        <span className="tt">
          <small>{a.tipo === 'vuelo' ? 'Vuelo' : 'Tarea'}</small>
          <b>{a.titulo}</b>
          {a.sub ? <em>{a.sub}</em> : null}
        </span>
        <Crono desde={a.desde} objetivoMin={a.objetivoMin} ahora={ahora} />
      </button>
      <ol className="cn-riel" aria-label="Etapas">
        {a.tramos.map((tr, i) => (
          <li key={ETAPAS[i]} className={tr.estado === 'actual' ? `actual ${t}` : tr.estado}>
            <span className="pt" aria-hidden="true" />
            <b>{tr.etapa}</b>
            <small>{tr.estado === 'actual' ? <Crono desde={a.desde} objetivoMin={a.objetivoMin} ahora={ahora} /> : tr.estado === 'hecha' ? dur(tr.segundos) || 'listo' : ''}</small>
          </li>
        ))}
      </ol>
      <p className="cn-siguiente">
        <ArrowRight size={14} /> {a.siguiente}
        {a.quien ? ` · ${a.quien}` : ''}
        {t === 'bad' ? ` · pasó el objetivo de ${a.objetivoMin} min` : ''}
      </p>
    </li>
  );
}

/** Vista rápida de un vuelo (la misma tarjeta de embarque, etapas y línea de tiempo del panel de Vuelos). */
export function VistaVuelo({ v, atenciones, eventos }: { v: Vuelo; atenciones: Atencion[]; eventos: Evento[] }) {
  return (
    <div className="oc-form">
      <TarjetaEmbarque v={v} />
      <Etapas estado={v.estado} />
      <div className="oc-btns">
        <Boton tono="primario" onClick={() => void cortex.nav.go({ screen: 'vuelo', prefill: { vuelo: v.id } }).catch(() => undefined)} icono={<ArrowRight size={16} />}>
          Abrir ficha completa
        </Boton>
      </div>
      <div>
        <h3 style={{ marginBottom: 6 }}>Qué ha pasado</h3>
        <LineaVuelo v={v} atenciones={atenciones} eventos={eventos} />
      </div>
    </div>
  );
}
