import { useMemo, useState } from 'react';
import { TrendingUp } from 'lucide-react';
import { aAtencion, aEquipo, aVuelo, traerTodo, useCarga } from '../lib/datos';
import type { Atencion, Equipo, Vuelo } from '../lib/datos';
import { Area, Barras, Columnas, Dona } from '../lib/graficos';
import { ESTADOS_VUELO, TONO_VUELO, tono } from '../lib/estados';
import { cop, fechaCorta, kg, minTxt, num, pct, promedio } from '../lib/formato';
import { hoyBogota, inicioMes, sumarDias } from '../lib/tiempo';
import { PanelTareas } from '../lib/PiezasTareas';
import { cargarTareas } from '../lib/tareas';
import type { Tarea } from '../lib/tareas';
import { Boton, Delta, Estado, Frase, Metrica, Pantalla, Segmentos, Tabla, Tarjeta } from '../lib/ui';

/**
 * INDICADORES — tiempos (llegada→toma, atención, total), kilos y piezas, % fuera de margen,
 * por aerolínea, por día y por operario. Gráficos propios en SVG.
 */

type Periodo = 'mes' | 'mespasado' | '30' | '7' | 'todo';
type Agrupar = 'aerolinea' | 'operario';

interface Datos {
  vuelos: Vuelo[];
  atenciones: Atencion[];
  equipos: Equipo[];
  tareas: Tarea[];
}

async function cargar(): Promise<Datos> {
  const [vs, as, es, tareas] = await Promise.all([
    traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 1000),
    traerTodo('atenciones', { order: { field: 'created_at', dir: 'desc' } }, 1000),
    traerTodo('equipos_usados', { order: { field: 'created_at', dir: 'desc' } }, 1500).catch(() => []),
    cargarTareas(1000),
  ]);
  return { vuelos: vs.map(aVuelo), atenciones: as.map(aAtencion), equipos: es.map(aEquipo), tareas };
}

function rango(p: Periodo, hoy: string): [string, string] {
  if (p === 'mes') return [inicioMes(hoy), hoy];
  if (p === 'mespasado') {
    const fin = sumarDias(inicioMes(hoy), -1);
    return [inicioMes(fin), fin];
  }
  if (p === '30') return [sumarDias(hoy, -29), hoy];
  if (p === '7') return [sumarDias(hoy, -6), hoy];
  return ['0000-01-01', '9999-12-31'];
}

/** El periodo inmediatamente anterior, de la misma duración (para comparar). null = no hay con qué. */
function rangoPrevio(p: Periodo, hoy: string): { r: [string, string]; nombre: string } | null {
  if (p === 'todo') return null;
  if (p === 'mes') {
    const fin = sumarDias(inicioMes(hoy), -1);
    // Mismo tramo del mes anterior, para que la comparación sea justa.
    const dia = Number(hoy.slice(8));
    const ini = inicioMes(fin);
    const tope = sumarDias(ini, Math.min(dia, Number(fin.slice(8))) - 1);
    return { r: [ini, tope], nombre: 'el mes pasado a la misma fecha' };
  }
  if (p === 'mespasado') {
    const fin = sumarDias(inicioMes(hoy), -1);
    const finAnt = sumarDias(inicioMes(fin), -1);
    return { r: [inicioMes(finAnt), finAnt], nombre: 'el mes anterior' };
  }
  const n = p === '30' ? 30 : 7;
  return { r: [sumarDias(hoy, -(2 * n - 1)), sumarDias(hoy, -n)], nombre: `los ${n} días anteriores` };
}

function resumen(data: Datos | null, d: string, h: string) {
  const vs = (data?.vuelos ?? []).filter((v) => v.fecha >= d && v.fecha <= h);
  const ids = new Set(vs.map((v) => v.id));
  const as = (data?.atenciones ?? []).filter((a) => (a.vueloId ? ids.has(a.vueloId) : a.fecha >= d && a.fecha <= h));
  const idsAt = new Set(as.map((a) => a.id));
  const es = (data?.equipos ?? []).filter((e) => idsAt.has(e.atencionId));
  return {
    n: vs.length,
    kilos: vs.reduce((t, v) => t + (v.kilosRec ?? 0), 0),
    toma: promedio(vs.map((v) => v.minToma)),
    atencion: promedio(vs.map((v) => v.minAtencion)),
    fuera: as.length ? (as.filter((a) => a.fueraDeMargen).length / as.length) * 100 : null,
    costo: es.reduce((t, e) => t + (e.costoCop || e.porPagar), 0),
  };
}

const variacion = (a: number | null, b: number | null | undefined): string => {
  if (a === null || b === null || b === undefined || b === 0) return '';
  const r = Math.round(((a - b) / Math.abs(b)) * 100);
  return r === 0 ? 'igual que antes' : `${r > 0 ? '+' : '−'}${Math.abs(r)} %`;
};

export default function Indicadores() {
  const hoy = hoyBogota();
  const { data, loading, error, refresh } = useCarga(cargar, [], 60_000);
  const [periodo, setPeriodo] = useState<Periodo>('mes');
  const [agrupar, setAgrupar] = useState<Agrupar>('aerolinea');

  const calc = useMemo(() => {
    const [d, h] = rango(periodo, hoy);
    const vs = (data?.vuelos ?? []).filter((v) => v.fecha >= d && v.fecha <= h);
    const idsVuelo = new Set(vs.map((v) => v.id));
    const as = (data?.atenciones ?? []).filter((a) => (a.vueloId ? idsVuelo.has(a.vueloId) : a.fecha >= d && a.fecha <= h));
    const idsAt = new Set(as.map((a) => a.id));
    const es = (data?.equipos ?? []).filter((e) => idsAt.has(e.atencionId));

    const porDia = new Map<string, number>();
    for (const v of vs) porDia.set(v.fecha, (porDia.get(v.fecha) ?? 0) + (v.kilosRec ?? 0));
    const dias = [...porDia.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-30).map(([f, k]) => ({ etiqueta: f.slice(8), valor: k }));

    const porEstado = ESTADOS_VUELO.map((e) => ({ etiqueta: e, valor: vs.filter((v) => v.estado === e).length })).filter((x) => x.valor);

    const clave = (v: Vuelo) => (agrupar === 'aerolinea' ? v.aerolinea || 'Sin aerolínea' : v.atendidoPor || 'Sin operario');
    const grupos = new Map<string, Vuelo[]>();
    for (const v of vs) grupos.set(clave(v), [...(grupos.get(clave(v)) ?? []), v]);
    const filas = [...grupos.entries()]
      .map(([k, xs]) => {
        const ats = as.filter((a) => xs.some((v) => v.id === a.vueloId));
        return {
          k,
          vuelos: xs.length,
          kilos: xs.reduce((s, v) => s + (v.kilosRec ?? 0), 0),
          toma: promedio(xs.map((v) => v.minToma)),
          atencion: promedio(xs.map((v) => v.minAtencion)),
          total: promedio(xs.map((v) => v.minTotal)),
          fuera: ats.length ? (ats.filter((a) => a.fueraDeMargen).length / ats.length) * 100 : null,
        };
      })
      .sort((a, b) => b.kilos - a.kilos);

    const ts = (data?.tareas ?? []).filter((t) => {
      const f = (t.fin || t.inicio || t.creado).slice(0, 10);
      return f >= d && f <= h;
    });

    return {
      vs,
      as,
      ts,
      kilos: vs.reduce((s, v) => s + (v.kilosRec ?? 0), 0),
      piezas: vs.reduce((s, v) => s + (v.piezasRec ?? 0), 0),
      toma: promedio(vs.map((v) => v.minToma)),
      atencion: promedio(vs.map((v) => v.minAtencion)),
      total: promedio(vs.map((v) => v.minTotal)),
      fuera: as.length ? (as.filter((a) => a.fueraDeMargen).length / as.length) * 100 : null,
      costo: es.reduce((s, e) => s + (e.costoCop || e.porPagar), 0),
      dias,
      porEstado,
      filas,
    };
  }, [data, periodo, agrupar, hoy]);

  const previo = useMemo(() => {
    const pr = rangoPrevio(periodo, hoy);
    return pr ? { ...resumen(data, pr.r[0], pr.r[1]), nombre: pr.nombre } : null;
  }, [data, periodo, hoy]);
  const [verTabla, setVerTabla] = useState(false);
  const vacio = !calc.vs.length && !calc.ts.length;
  const nombrePeriodo = { mes: 'Este mes', mespasado: 'El mes pasado', '30': 'En 30 días', '7': 'En 7 días', todo: 'En total' }[periodo];
  return (
    <Pantalla
      titulo="Indicadores"
      sub="Cómo va la operación: tiempos, kilos y diferencias."
      acciones={<Boton onClick={() => void refresh()}>Actualizar</Boton>}
    >
      <div style={{ marginBottom: 18 }}>
        <Segmentos
          valor={periodo}
          onChange={setPeriodo}
          opciones={[
            { id: 'mes', texto: 'Este mes' },
            { id: 'mespasado', texto: 'Mes pasado' },
            { id: '30', texto: '30 días' },
            { id: '7', texto: '7 días' },
            { id: 'todo', texto: 'Todo' },
          ]}
        />
      </div>
      <Estado
        cargando={loading}
        error={error}
        vacio={!data || vacio}
        tituloVacio="Sin vuelos en este periodo"
        textoVacio={<p>Prueba con otro periodo. Los indicadores aparecen cuando hay vuelos atendidos.</p>}
        reintentar={() => void refresh()}
      >
        <Frase icono={<TrendingUp size={20} />} tono={calc.fuera !== null && calc.fuera > 10 ? 'warn' : 'neutral'}>
          {nombrePeriodo}: <b>{calc.vs.length} vuelos</b> y <b>{kg(calc.kilos)}</b> recibidos
          {calc.atencion !== null ? <>; la atención tarda <b>{minTxt(calc.atencion)}</b> en promedio{previo && variacion(calc.atencion, previo.atencion) ? ` (${variacion(calc.atencion, previo.atencion)} frente a ${previo.nombre})` : ''}</> : null}
          {calc.fuera !== null ? <>, y <b>{pct(calc.fuera)}</b> de las atenciones salió fuera de margen</> : null}
          {calc.costo ? <>. Los equipos costaron <b>{cop(calc.costo)}</b></> : null}.
        </Frase>
        <div className="oc-kpis oc-kpis-q">
          <Metrica etiqueta="¿Cuánta carga recibimos?" valor={kg(calc.kilos)} pista={<><span>{calc.vs.length} vuelos · {num(calc.piezas)} piezas</span><br /><Delta actual={calc.kilos} previo={previo?.kilos} /></>} spark={calc.dias.map((d) => d.valor)} />
          <Metrica etiqueta="¿Qué tan rápido tomamos los vuelos?" valor={minTxt(calc.toma)} tono="info" pista={<Delta actual={calc.toma ?? 0} previo={previo?.toma} mejorSiBaja />} />
          <Metrica etiqueta="¿Cuánto dura la atención?" valor={minTxt(calc.atencion)} tono="info" pista={<><span>Aviso → recibido: {minTxt(calc.total)}</span><br /><Delta actual={calc.atencion ?? 0} previo={previo?.atencion} mejorSiBaja /></>} />
          <Metrica etiqueta="¿Cuántas salen fuera de margen?" valor={calc.fuera === null ? '—' : pct(calc.fuera)} tono={calc.fuera && calc.fuera > 10 ? 'bad' : 'good'} pista={calc.fuera === null ? undefined : <><span>Meta: menos de 10 %</span><br /><Delta actual={calc.fuera} previo={previo?.fuera} mejorSiBaja unidad="pp" /></>} />
          <Metrica etiqueta="¿Cuánto cuestan los equipos?" valor={cop(calc.costo)} pista={<Delta actual={calc.costo} previo={previo?.costo} mejorSiBaja />} />
        </div>

        <div className="oc-grid oc-g2 oc-sec">
          <Tarjeta titulo="Kilos recibidos por día">
            {calc.dias.length > 1 ? <Area datos={calc.dias} formato={(n) => kg(n)} /> : calc.dias.length ? <Columnas datos={calc.dias} formato={(n) => kg(n)} /> : <p className="oc-sub">Aún no hay kilos recibidos en el periodo.</p>}
          </Tarjeta>
          <Tarjeta titulo="Vuelos por estado">
            <Dona datos={calc.porEstado.map((e) => ({ ...e, color: COLOR[tono(TONO_VUELO, e.etiqueta)] }))} />
          </Tarjeta>
        </div>

        <div className="oc-sec">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <h2>Comparativo</h2>
            <Segmentos valor={agrupar} onChange={setAgrupar} opciones={[{ id: 'aerolinea', texto: 'Por aerolínea' }, { id: 'operario', texto: 'Por operario' }]} />
          </div>
          <div className="oc-grid oc-g2">
            <Tarjeta titulo="Kilos recibidos">
              <Barras datos={calc.filas.slice(0, 10).map((f) => ({ etiqueta: f.k, valor: f.kilos }))} formato={(n) => kg(n)} />
            </Tarjeta>
            <Tarjeta titulo="Minutos totales (promedio)">
              <Barras datos={calc.filas.filter((f) => f.total !== null).slice(0, 10).map((f) => ({ etiqueta: f.k, valor: f.total ?? 0 }))} formato={(n) => minTxt(n)} />
            </Tarjeta>
          </div>
          <div style={{ marginTop: 14 }}>
            <Tabla columnas={[{ t: agrupar === 'aerolinea' ? 'Aerolínea' : 'Operario' }, { t: 'Vuelos', n: true }, { t: 'Kilos', n: true }, { t: 'Aviso → toma', n: true }, { t: 'Atención', n: true }, { t: 'Total', n: true }, { t: 'Fuera de margen', n: true }]}>
              {calc.filas.map((f) => (
                <tr key={f.k}>
                  <td><b>{f.k}</b></td>
                  <td className="n">{f.vuelos}</td>
                  <td className="n">{num(f.kilos, 1)}</td>
                  <td className="n">{minTxt(f.toma)}</td>
                  <td className="n">{minTxt(f.atencion)}</td>
                  <td className="n">{minTxt(f.total)}</td>
                  <td className="n">{f.fuera === null ? '—' : pct(f.fuera)}</td>
                </tr>
              ))}
            </Tabla>
          </div>
        </div>

        <div className="oc-sec">
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 12 }}>
            <h2>Esperado vs recibido por vuelo</h2>
            <Boton chico onClick={() => setVerTabla((x) => !x)} aria-expanded={verTabla}>{verTabla ? 'Ocultar detalle' : `Ver los ${Math.min(60, calc.vs.length)} vuelos`}</Boton>
          </div>
          {verTabla ? <Tabla columnas={[{ t: 'Vuelo' }, { t: 'Fecha' }, { t: 'Esperado (kg)', n: true }, { t: 'Recibido (kg)', n: true }, { t: 'Diferencia', n: true }, { t: 'Aviso → toma', n: true }, { t: 'Atención', n: true }, { t: 'Estado' }]}>
            {calc.vs.slice(0, 60).map((v) => {
              const dif = v.kilosRec === null ? null : v.kilosRec - v.kilosEsp;
              return (
                <tr key={v.id}>
                  <td className="oc-mono"><b>{v.numero}</b></td>
                  <td>{fechaCorta(v.fecha)}</td>
                  <td className="n">{num(v.kilosEsp, 1)}</td>
                  <td className="n">{v.kilosRec === null ? '—' : num(v.kilosRec, 1)}</td>
                  <td className="n">{dif === null ? '—' : <span className={`oc-dif ${Math.abs(dif) > (v.kilosEsp * v.margenKilos) / 100 ? 'bad' : 'ok'}`}>{dif > 0 ? '+' : ''}{num(dif, 1)}</span>}</td>
                  <td className="n">{minTxt(v.minToma)}</td>
                  <td className="n">{minTxt(v.minAtencion)}</td>
                  <td>{v.estado}</td>
                </tr>
              );
            })}
          </Tabla> : null}
        </div>

        <div className="oc-sec">
          <h2 style={{ marginBottom: 12 }}>Tareas</h2>
          <PanelTareas tareas={calc.ts} />
        </div>
      </Estado>
    </Pantalla>
  );
}

const COLOR: Record<string, string> = {
  neutral: '#a39b86',
  info: '#17428a',
  warn: '#d9a21b',
  bad: '#a3281f',
  good: '#2f6b3e',
  accent: '#5b3f8c',
  quiet: '#c9c1ac',
};
