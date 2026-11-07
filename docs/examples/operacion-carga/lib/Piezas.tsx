import { useEffect, useMemo, useRef, useState } from 'react';
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

const ENCABEZADO_G = 112; // ancho de la columna de nombres (px)

/**
 * Gantt del día: una fila por vuelo, barra desde que llega (o su hora estimada) hasta que cierra
 * (o su duración prevista), línea de «ahora» que avanza y barras que cambian de color al atrasarse.
 */
export function Pista({ vuelos, onAbrir }: { vuelos: Vuelo[]; onAbrir: (v: Vuelo) => void }) {
  const [ahora, setAhora] = useState(horaAhora());
  useEffect(() => {
    const t = setInterval(() => setAhora(horaAhora()), 30_000);
    return () => clearInterval(t);
  }, []);
  const PX = 104; // píxeles por hora
  const a = aMin(ahora) ?? 720;
  const filas = useMemo(() => {
    return [...vuelos]
      .filter((v) => aMin(v.horaActual) !== null)
      .sort((p, q) => (aMin(p.horaActual) ?? 0) - (aMin(q.horaActual) ?? 0))
      .map((v) => {
        const est = aMin(v.horaActual) ?? 0;
        const llego = v.llegadaHora ? aMin(v.llegadaHora) : null;
        const ini = llego ?? est;
        const cierre = v.cierreHora ? aMin(v.cierreHora) : null;
        const enCurso = v.estado === 'Aterrizó' || v.estado === 'En atención';
        const fin = cierre ?? (enCurso ? Math.max(ini + 60, a + 12) : ini + 90);
        const atraso = v.hora && v.horaActual ? (aMin(v.horaActual) ?? 0) - (aMin(v.hora) ?? 0) : 0;
        const sinLlegar = ['Programado', 'En camino', 'Demorado'].includes(v.estado);
        const tarde = sinLlegar && (a - est >= 15 || atraso >= 15 || v.estado === 'Demorado');
        const sinTomar = v.estado === 'Aterrizó' && a - ini >= 10;
        const riesgo = !tarde && ((sinLlegar && est - a <= 20 && est - a >= -15) || (v.estado === 'Aterrizó' && !sinTomar));
        return { v, ini, fin: Math.max(fin, ini + 70), tarde: tarde || sinTomar, riesgo, hecho: ['Recibido', 'Cerrado'].includes(v.estado) };
      });
  }, [vuelos, a]);
  const ini = Math.max(0, Math.floor((Math.min(a, ...filas.map((f) => f.ini)) - 30) / 60)) * 60;
  const fin = Math.min(24 * 60, Math.ceil((Math.max(a + 60, ...filas.map((f) => f.fin)) + 30) / 60) * 60);
  const horas = Array.from({ length: Math.max(1, (fin - ini) / 60) }, (_, i) => ini / 60 + i);
  const x = (m: number) => ((m - ini) / 60) * PX;
  const ancho = horas.length * PX;
  const refScroll = useRef<HTMLDivElement>(null);
  // Al abrir, deja «ahora» visible (un poco a la derecha del borde).
  useEffect(() => {
    const el = refScroll.current;
    if (el) el.scrollLeft = Math.max(0, x(a) - el.clientWidth * 0.3);
    // biome-ignore lint/correctness/useExhaustiveDependencies: solo al montar.
  }, []);
  return (
    <div className="oc-gantt" role="group" aria-label="Gantt del día">
      <div className="oc-gantt-sc" ref={refScroll}>
        <div className="oc-gantt-in" style={{ width: ancho + ENCABEZADO_G, ['--px' as string]: `${PX}px` }}>
          <div className="oc-g-regla">
            <span className="rl" style={{ width: ENCABEZADO_G, padding: '7px 0 0 10px' }}>Vuelo</span>
            {horas.map((h) => (
              <span key={h} className="h" style={{ width: PX }}>
                {String(h).padStart(2, '0')}:00
              </span>
            ))}
          </div>
          {a >= ini && a <= fin ? <div className="oc-g-ahora" style={{ left: ENCABEZADO_G + x(a) }} /> : null}
          {filas.map(({ v, ini: i0, fin: f0, tarde, riesgo, hecho }) => {
            const t: Tono = tarde ? 'bad' : tono(TONO_VUELO, v.estado);
            return (
              <div className="oc-g-fila" key={v.id}>
                <button type="button" className="oc-g-lab" style={{ width: ENCABEZADO_G }} onClick={() => onAbrir(v)}>
                  <b>{v.numero}</b>
                  <small>{v.aerolinea.replace(/ Cargo| Airlines/g, '')} · {v.origen}</small>
                </button>
                <div className="oc-g-pista" style={{ width: ancho }}>
                  <button
                    type="button"
                    className={`oc-g-barra ${t} ${riesgo ? 'riesgo' : ''} ${hecho ? 'hecho' : ''}`}
                    style={{ left: x(i0), width: Math.max(122, x(f0) - x(i0)) }}
                    onClick={() => onAbrir(v)}
                    title={`${v.numero} · ${v.estado}${tarde ? ' · atrasado' : ''}`}
                    aria-label={`${v.numero}, ${v.estado}${tarde ? ', atrasado' : ''}, ${hhmm(v.horaActual)}`}
                  >
                    {ES_VIVO.has(v.estado) ? <span className="oc-punto vivo" aria-hidden="true" /> : null}
                    {hhmm(v.llegadaHora || v.horaActual)} · {tarde && v.estado !== 'Aterrizó' ? 'Atrasado' : v.estado}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="oc-g-leyenda" aria-hidden="true">
        {([['#efeadb', '#b9b098', 'Programado'], ['#dce7fa', '#6d8fd0', 'En camino'], ['#ebe3f6', '#8d6fc2', 'Aterrizó'], ['#dff0e2', '#4f9a62', 'En atención / recibido'], ['#fde4e0', '#d9534a', 'Atrasado o sin tomar']] as const).map(([bg, bd, t]) => (
          <span key={t}><i style={{ background: bg, borderColor: bd }} />{t}</span>
        ))}
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
            <b style={cambio ? { color: 'var(--aviso)' } : undefined}>{hhmm(v.horaActual) || '—'}</b>
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
