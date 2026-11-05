import { useEffect, useMemo, useState } from 'react';
import type { Vuelo } from './datos';
import { ESTADOS_VUELO, TONO_VUELO, tono } from './estados';
import type { Tono } from './estados';
import { hhmm, kg, num } from './formato';
import { horaAhora } from './tiempo';
import { Chip, ES_VIVO } from './ui';

/** Piezas visuales compartidas: pista del día, etapas, medidor y tarjeta de embarque. */

const aMin = (h: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})/.exec(h);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Línea de tiempo horizontal del día: cada vuelo es una píldora puesta por su hora estimada. */
export function Pista({ vuelos, onAbrir }: { vuelos: Vuelo[]; onAbrir: (v: Vuelo) => void }) {
  const [ahora, setAhora] = useState(horaAhora());
  useEffect(() => {
    const t = setInterval(() => setAhora(horaAhora()), 30_000);
    return () => clearInterval(t);
  }, []);
  const PX = 96; // píxeles por hora
  const datos = useMemo(() => {
    const mins = vuelos.map((v) => aMin(v.horaActual)).filter((m): m is number => m !== null);
    const a = aMin(ahora) ?? 720;
    const ini = Math.max(0, Math.floor((Math.min(a, ...(mins.length ? mins : [a])) - 60) / 60)) * 60;
    const fin = Math.min(24 * 60, Math.ceil((Math.max(a, ...(mins.length ? mins : [a])) + 120) / 60) * 60);
    return { ini, fin, a };
  }, [vuelos, ahora]);
  const horas = Array.from({ length: (datos.fin - datos.ini) / 60 }, (_, i) => datos.ini / 60 + i);
  const x = (m: number) => ((m - datos.ini) / 60) * PX;
  // Reparto en carriles para que no se encimen.
  const puestos = useMemo(() => {
    const fin: number[] = [];
    return [...vuelos]
      .filter((v) => aMin(v.horaActual) !== null)
      .sort((p, q) => (aMin(p.horaActual) ?? 0) - (aMin(q.horaActual) ?? 0))
      .map((v) => {
        const ini = x(aMin(v.horaActual) ?? 0);
        let c = fin.findIndex((f) => f + 8 < ini);
        if (c < 0) c = fin.length;
        fin[c] = ini + 150;
        return { v, ini, c };
      });
    // biome-ignore lint/correctness/useExhaustiveDependencies: x depende de datos.
  }, [vuelos, datos]);
  const carriles = Math.max(1, ...puestos.map((p) => p.c + 1));
  const ancho = horas.length * PX;
  return (
    <div className="oc-pista" role="group" aria-label="Línea de tiempo del día">
      <div className="oc-pista-in" style={{ width: Math.max(ancho + 40, 320), paddingLeft: 20 }}>
        <div className="regla" style={{ width: ancho }}>
          {horas.map((h) => (
            <span key={h} style={{ width: PX }}>
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        <div style={{ position: 'relative', height: carriles * 50, width: ancho }}>
          {datos.a >= datos.ini && datos.a <= datos.fin ? <div className="oc-ahora" style={{ left: x(datos.a) }} /> : null}
          {Array.from({ length: carriles }, (_, i) => (
            <div key={i} className="carril" style={{ position: 'absolute', top: i * 50, left: 0, right: 0 }} />
          ))}
          {puestos.map(({ v, ini, c }) => (
            <button key={v.id} type="button" className={`oc-pill ${tono(TONO_VUELO, v.estado)}`} style={{ left: ini, top: c * 50 + 7 }} onClick={() => onAbrir(v)} title={`${v.numero} · ${v.estado}`}>
              {ES_VIVO.has(v.estado) ? <span className="oc-punto vivo" aria-hidden="true" /> : null}
              {hhmm(v.horaActual)} {v.numero}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Barra de etapas del vuelo: Programado → … → Cerrado. */
export function Etapas({ estado }: { estado: string }) {
  const flujo = ESTADOS_VUELO.filter((e) => e !== 'Cancelado' && e !== 'Demorado');
  const i = flujo.findIndex((e) => e === estado || (estado === 'Demorado' && e === 'En camino'));
  return (
    <ol className="oc-etapas" aria-label="Etapas del vuelo">
      {flujo.map((e, k) => (
        <li key={e} className={k < i ? 'hecho' : k === i ? 'actual' : ''}>
          {e}
        </li>
      ))}
    </ol>
  );
}

/** Real contra esperado: riel con la banda del margen y la marca de lo recibido. */
export function Medidor({
  titulo,
  esperado,
  real,
  margen,
  formato = (n: number) => num(n, 1),
}: {
  titulo: string;
  esperado: number;
  real: number | null;
  /** Diferencia tolerada en las mismas unidades. */
  margen: number;
  formato?: (n: number) => string;
}) {
  const tope = Math.max(esperado * 1.5, (real ?? 0) * 1.1, 1);
  const pos = (n: number) => `${Math.min(100, Math.max(0, (n / tope) * 100))}%`;
  const dif = real === null ? null : real - esperado;
  const fuera = dif !== null && Math.abs(dif) > margen + 1e-9;
  return (
    <div className="oc-medidor">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <b>{titulo}</b>
        {dif === null ? (
          <span className="oc-sub">Sin registrar</span>
        ) : (
          <span className={`oc-dif ${fuera ? 'bad' : 'ok'}`}>
            {dif > 0 ? '+' : dif < 0 ? '-' : ''}
            {formato(Math.abs(dif))} {fuera ? '· fuera del margen' : '· dentro del margen'}
          </span>
        )}
      </div>
      <div className="riel">
        <div className="banda" style={{ left: pos(Math.max(0, esperado - margen)), width: `${((Math.min(tope, esperado + margen) - Math.max(0, esperado - margen)) / tope) * 100}%` }} />
        {real !== null ? <div className={`marca ${fuera ? 'bad' : 'ok'}`} style={{ left: pos(real) }} /> : null}
      </div>
      <div className="pie">
        <span>Esperado {formato(esperado)}</span>
        <span>{real === null ? '—' : `Real ${formato(real)}`}</span>
      </div>
    </div>
  );
}

/** Cabecera estilo tarjeta de embarque. */
export function TarjetaEmbarque({ v, acciones }: { v: Vuelo; acciones?: React.ReactNode }) {
  const cambio = v.hora && v.horaActual && hhmm(v.hora) !== hhmm(v.horaActual);
  const t: Tono = tono(TONO_VUELO, v.estado);
  return (
    <div className="oc-pase">
      <div className="oc-pase-main">
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="oc-sub" style={{ textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>
            {v.aerolinea || 'Aerolínea sin definir'}
          </span>
          <Chip tono={t} vivo={ES_VIVO.has(v.estado)}>
            {v.estado}
          </Chip>
        </div>
        <div className="oc-pase-num">{v.numero}</div>
        <div className="oc-ruta">
          <span>{v.origen || '—'}</span>
          <i />
          <span>BOG</span>
        </div>
        <div className="oc-horas">
          <div>
            <small>Programada</small>
            <b>{hhmm(v.hora) || '—'}</b>
          </div>
          <div>
            <small>Estimada</small>
            <b style={cambio ? { color: 'var(--senal)' } : undefined}>{hhmm(v.horaActual) || '—'}</b>
          </div>
          {v.horaReal ? (
            <div>
              <small>Real</small>
              <b>{hhmm(v.horaReal)}</b>
            </div>
          ) : null}
        </div>
        {acciones}
      </div>
      <div className="oc-pase-talon">
        <small className="oc-sub">POSICIÓN</small>
        <b className="mono" style={{ fontSize: 30 }}>{v.posicion || '—'}</b>
        <small className="oc-sub">ESPERADO</small>
        <b>
          {kg(v.kilosEsp)} · {num(v.palletsEsp)} pallets · {num(v.piezasEsp)} piezas
        </b>
        {v.atendidoPor ? (
          <>
            <small className="oc-sub">ATIENDE</small>
            <b>{v.atendidoPor}</b>
          </>
        ) : null}
      </div>
    </div>
  );
}
