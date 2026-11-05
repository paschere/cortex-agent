import { useMemo, useState } from 'react';
import { aAtencion, aEquipo, aVuelo, traerTodo, useCarga } from '../lib/datos';
import type { Atencion, Equipo, Vuelo } from '../lib/datos';
import { Area, Barras, Columnas, Dona } from '../lib/graficos';
import { ESTADOS_VUELO, TONO_VUELO, tono } from '../lib/estados';
import { cop, fechaCorta, kg, minTxt, num, pct, promedio } from '../lib/formato';
import { hoyBogota, inicioMes, sumarDias } from '../lib/tiempo';
import { Boton, Estado, Metrica, Pantalla, Segmentos, Tabla, Tarjeta } from '../lib/ui';

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
}

async function cargar(): Promise<Datos> {
  const [vs, as, es] = await Promise.all([
    traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 1000),
    traerTodo('atenciones', { order: { field: 'created_at', dir: 'desc' } }, 1000),
    traerTodo('equipos_usados', { order: { field: 'created_at', dir: 'desc' } }, 1500).catch(() => []),
  ]);
  return { vuelos: vs.map(aVuelo), atenciones: as.map(aAtencion), equipos: es.map(aEquipo) };
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

    return {
      vs,
      as,
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

  const vacio = !calc.vs.length;
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
        <div className="oc-kpis">
          <Metrica etiqueta="Vuelos" valor={calc.vs.length} spark={calc.dias.map((d) => d.valor)} />
          <Metrica etiqueta="Kilos recibidos" valor={kg(calc.kilos)} />
          <Metrica etiqueta="Piezas recibidas" valor={num(calc.piezas)} />
          <Metrica etiqueta="Aviso → toma (prom.)" valor={minTxt(calc.toma)} tono="info" />
          <Metrica etiqueta="Atención (prom.)" valor={minTxt(calc.atencion)} tono="info" />
          <Metrica etiqueta="Total aviso → recibido" valor={minTxt(calc.total)} tono="info" />
          <Metrica etiqueta="Atenciones fuera de margen" valor={calc.fuera === null ? '—' : pct(calc.fuera)} tono={calc.fuera && calc.fuera > 10 ? 'bad' : 'good'} />
          <Metrica etiqueta="Costo de equipos" valor={cop(calc.costo)} />
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
          <h2 style={{ marginBottom: 12 }}>Esperado vs recibido por vuelo</h2>
          <Tabla columnas={[{ t: 'Vuelo' }, { t: 'Fecha' }, { t: 'Esperado (kg)', n: true }, { t: 'Recibido (kg)', n: true }, { t: 'Diferencia', n: true }, { t: 'Aviso → toma', n: true }, { t: 'Atención', n: true }, { t: 'Estado' }]}>
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
          </Tabla>
        </div>
      </Estado>
    </Pantalla>
  );
}

const COLOR: Record<string, string> = {
  neutral: '#a39b86',
  info: '#1d5f86',
  warn: '#d9a21b',
  bad: '#a3281f',
  good: '#2f6b3e',
  accent: '#5b3f8c',
  quiet: '#c9c1ac',
};
