import { createContext, useContext, useMemo, useState } from 'react';
import { Check, Moon, Sun } from 'lucide-react';
import { Barras } from './graficos';
import { cop, minTxt, num } from './formato';
import { resumirTareas } from './tareas';
import type { Persona, Tarea } from './tareas';
import { Metrica, Segmentos, Tabla, Tarjeta } from './ui';

/** Piezas de las tareas compartidas por asignar, costos e indicadores. */

/** Carga de cada persona (ref → cosas abiertas): la pone la pantalla Asignar y el selector la muestra. */
export const CargaCtx = createContext<Record<string, number>>({});

/**
 * Chips de operarios: los de turno abierto primero y marcados. `valor` son refs.
 * Si alguien ya asignado no aparece en la lista (cambió de rol), se muestra por su ref.
 */
export function SelectorOperarios({
  personas,
  valor,
  onChange,
  nombresPrevios = {},
}: {
  personas: Persona[];
  valor: string[];
  onChange: (refs: string[]) => void;
  nombresPrevios?: Record<string, string>;
}) {
  const carga = useContext(CargaCtx);
  const conocidos = new Set(personas.map((p) => p.ref));
  const extra = valor.filter((r) => !conocidos.has(r)).map((r) => ({ ref: r, name: nombresPrevios[r] ?? r, roleKey: '', roleName: '', onShift: false }));
  const todos = [...personas, ...extra];
  const alternar = (ref: string) => onChange(valor.includes(ref) ? valor.filter((r) => r !== ref) : [...valor, ref]);
  const deTurno = todos.filter((p) => p.onShift).length;
  return (
    <div>
      <div className="oc-ops" role="group" aria-label="Operarios">
        {todos.map((p) => {
          const on = valor.includes(p.ref);
          return (
            <button key={p.ref} type="button" className={`oc-op ${on ? 'on' : ''} ${p.onShift ? 'turno' : ''}`} aria-pressed={on} onClick={() => alternar(p.ref)}>
              <span className="av">{on ? <Check size={16} /> : p.name.trim().slice(0, 1).toUpperCase()}</span>
              <span className="tx">
                <b>{p.name}</b>
                <small>{p.onShift ? <><Sun size={11} /> En turno</> : <><Moon size={11} /> Sin turno</>}</small>
                <small className={`carga ${(carga[p.ref] ?? 0) >= 3 ? 'alta' : (carga[p.ref] ?? 0) >= 1 ? 'media' : 'libre'}`}>
                  <span className="barrita" aria-hidden="true"><i style={{ width: `${Math.min(100, (carga[p.ref] ?? 0) * 33)}%` }} /></span>
                  {(carga[p.ref] ?? 0) === 0 ? 'Libre' : `${carga[p.ref]} ${(carga[p.ref] ?? 0) === 1 ? 'pendiente' : 'pendientes'}`}
                </small>
              </span>
            </button>
          );
        })}
      </div>
      {todos.length ? (
        <p className="oc-sub" style={{ marginTop: 6 }}>
          {deTurno ? `${deTurno} con turno abierto, primero.` : 'Nadie tiene turno abierto ahora.'} Toca para escoger uno o varios.
        </p>
      ) : null}
    </div>
  );
}

/** Costo y tiempo de las tareas terminadas, por tipo y por operario. */
export function PanelTareas({ tareas, compacto }: { tareas: Tarea[]; compacto?: boolean }) {
  const [por, setPor] = useState<'tipo' | 'operario'>('tipo');
  const hechas = useMemo(() => tareas.filter((t) => t.estado === 'Terminada'), [tareas]);
  const filas = useMemo(() => resumirTareas(tareas, por), [tareas, por]);
  const total = hechas.reduce((s, t) => s + t.costoTotal, 0);
  const mins = hechas.map((t) => t.duracionMin).filter((m): m is number => m !== null);
  const prom = mins.length ? mins.reduce((a, b) => a + b, 0) / mins.length : null;
  const abiertas = tareas.filter((t) => t.estado === 'Asignada' || t.estado === 'En curso').length;
  return (
    <>
      <div className="oc-kpis">
        <Metrica etiqueta="Tareas terminadas" valor={num(hechas.length)} pista={abiertas ? `${abiertas} abiertas` : undefined} />
        <Metrica etiqueta="Costo de tareas" valor={cop(total)} pista="Equipos + otros gastos" />
        <Metrica etiqueta="Tiempo promedio" valor={minTxt(prom)} tono="info" />
        <Metrica etiqueta="Costo por tarea" valor={hechas.length ? cop(total / hechas.length) : '—'} />
      </div>
      <div style={{ margin: '18px 0 12px' }}>
        <Segmentos valor={por} onChange={setPor} opciones={[{ id: 'tipo', texto: 'Por tipo de tarea' }, { id: 'operario', texto: 'Por operario' }]} />
      </div>
      {!filas.length ? (
        <div className="oc-vacio"><strong>Todavía no hay tareas terminadas</strong>Aquí aparece el costo y el tiempo cuando los operarios cierren tareas.</div>
      ) : (
        <>
          <div className="oc-grid oc-g2">
            <Tarjeta titulo="Costo">
              <Barras datos={filas.slice(0, 10).map((f) => ({ etiqueta: f.clave, valor: f.costo }))} formato={cop} />
            </Tarjeta>
            <Tarjeta titulo="Tiempo total">
              <Barras datos={filas.slice(0, 10).map((f) => ({ etiqueta: f.clave, valor: f.minutos }))} formato={(n) => minTxt(n)} />
            </Tarjeta>
          </div>
          {compacto ? null : (
            <div style={{ marginTop: 14 }}>
              <Tabla columnas={[{ t: por === 'tipo' ? 'Tipo' : 'Operario' }, { t: 'Tareas', n: true }, { t: 'Tiempo', n: true }, { t: 'Prom. por tarea', n: true }, { t: 'Equipos', n: true }, { t: 'Otros', n: true }, { t: 'Costo', n: true }]}>
                {filas.map((f) => (
                  <tr key={f.clave}>
                    <td><b>{f.clave}</b></td>
                    <td className="n">{num(f.tareas, 1)}</td>
                    <td className="n">{minTxt(f.minutos)}</td>
                    <td className="n">{f.tareas ? minTxt(f.minutos / f.tareas) : '—'}</td>
                    <td className="n">{cop(f.costoEquipos)}</td>
                    <td className="n">{cop(f.costoOtros)}</td>
                    <td className="n"><b>{cop(f.costo)}</b></td>
                  </tr>
                ))}
              </Tabla>
            </div>
          )}
          {por === 'operario' ? <p className="oc-sub" style={{ marginTop: 8 }}>Si una tarea tuvo varios operarios, su costo se reparte en partes iguales y el tiempo cuenta completo para cada uno.</p> : null}
        </>
      )}
    </>
  );
}
