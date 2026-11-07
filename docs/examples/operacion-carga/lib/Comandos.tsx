import { useEffect, useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { ClipboardList, FileText, Plane, Search } from 'lucide-react';
import { aGuia, aVuelo, traerTodo } from './datos';
import type { Guia, Vuelo } from './datos';
import { aTarea } from './tareas';
import type { Tarea } from './tareas';
import { fechaCorta } from './formato';

/**
 * Barra de comandos (Ctrl/Cmd + K): salta a un vuelo, una guía o una tarea, o a otra pantalla.
 * Carga los datos solo al abrirla y navega con `cortex.nav.go`.
 */

interface Item {
  id: string;
  tipo: 'Vuelo' | 'Guía' | 'Tarea' | 'Pantalla';
  titulo: string;
  sub: string;
  ir: () => void;
}

const PANTALLAS: [string, string][] = [
  ['tablero', 'Tablero'], ['bandeja', 'Bandeja documental'], ['asignar', 'Asignar'], ['prealertas', 'Prealertas'], ['vuelos', 'Vuelos'],
  ['tramites', 'Trámites DIAN'], ['aprobar', 'Por aprobar'], ['eventos', 'Eventos'], ['indicadores', 'Indicadores'], ['costos', 'Costos'], ['torre', 'Torre de control'],
];

const go = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s-]/g, '');

export function BarraComandos() {
  const [abierta, setAbierta] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [datos, setDatos] = useState<{ vuelos: Vuelo[]; guias: Guia[]; tareas: Tarea[] } | null>(null);
  const cargado = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setAbierta((a) => !a);
      }
    };
    const abrir = () => setAbierta(true);
    window.addEventListener('keydown', k);
    window.addEventListener('oc-comandos', abrir);
    return () => {
      window.removeEventListener('keydown', k);
      window.removeEventListener('oc-comandos', abrir);
    };
  }, []);

  useEffect(() => {
    if (!abierta) return;
    setQ('');
    setSel(0);
    setTimeout(() => input.current?.focus(), 30);
    if (cargado.current) return;
    cargado.current = true;
    void (async () => {
      const [vs, gs, ts] = await Promise.all([
        traerTodo('vuelos', { order: { field: 'fecha', dir: 'desc' } }, 200).catch(() => []),
        traerTodo('prefacturacion', {}, 400).catch(() => []),
        traerTodo('tareas_operacion', { order: { field: 'created_at', dir: 'desc' } }, 150).catch(() => []),
      ]);
      setDatos({ vuelos: vs.map(aVuelo), guias: gs.map(aGuia), tareas: ts.map(aTarea) });
    })();
  }, [abierta]);

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const [s, t] of PANTALLAS) out.push({ id: `p-${s}`, tipo: 'Pantalla', titulo: t, sub: 'Ir a la pantalla', ir: () => go(s) });
    for (const v of datos?.vuelos ?? []) out.push({ id: `v-${v.id}`, tipo: 'Vuelo', titulo: v.numero, sub: `${fechaCorta(v.fecha)} · ${v.aerolinea} · ${v.estado}`, ir: () => go('vuelo', { vuelo: v.id }) });
    for (const g of datos?.guias ?? []) out.push({ id: `g-${g.id}`, tipo: 'Guía', titulo: g.guia, sub: `${g.cliente || 'Sin cliente'} · ${g.etapa || 'Esperada'}`, ir: () => (g.vueloId ? go('vuelo', { vuelo: g.vueloId, tab: 'guias' }) : go('prealertas')) });
    for (const t of datos?.tareas ?? []) out.push({ id: `t-${t.id}`, tipo: 'Tarea', titulo: t.titulo, sub: `${t.tipo} · ${t.estado}${t.asignados ? ` · ${t.asignados}` : ''}`, ir: () => go('asignar', { tarea: t.id }) });
    return out;
  }, [datos]);

  const lista = useMemo(() => {
    const n = norm(q);
    if (!n) return items.filter((i) => i.tipo === 'Pantalla' || i.tipo === 'Vuelo').slice(0, 9);
    return items.filter((i) => norm(`${i.titulo} ${i.sub}`).includes(n)).slice(0, 12);
  }, [items, q]);

  if (!abierta) return null;
  const cerrar = () => setAbierta(false);
  const elegir = (i?: Item) => {
    if (!i) return;
    cerrar();
    i.ir();
  };
  const icono = (t: Item['tipo']) => (t === 'Vuelo' ? <Plane size={16} /> : t === 'Guía' ? <FileText size={16} /> : t === 'Tarea' ? <ClipboardList size={16} /> : <Search size={16} />);
  return (
    <div className="oc-vel oc-cmd-vel" onMouseDown={(e) => e.target === e.currentTarget && cerrar()}>
      <div className="oc-cmd" role="dialog" aria-modal="true" aria-label="Buscar y saltar">
        <div className="oc-cmd-in">
          <Search size={18} aria-hidden="true" />
          <input
            ref={input}
            type="search"
            placeholder="Busca un vuelo, una guía o una tarea…"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cerrar();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(lista.length - 1, s + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === 'Enter') elegir(lista[sel]);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <ul className="oc-cmd-lista" role="listbox">
          {lista.map((i, k) => (
            <li key={i.id} role="option" aria-selected={k === sel}>
              <button type="button" className={k === sel ? 'on' : ''} onMouseEnter={() => setSel(k)} onClick={() => elegir(i)}>
                <span className="ic">{icono(i.tipo)}</span>
                <span className="tx">
                  <b>{i.titulo}</b>
                  <small>{i.sub}</small>
                </span>
                <span className="tp">{i.tipo}</span>
              </button>
            </li>
          ))}
          {!lista.length ? <li className="oc-cmd-vacio">{datos ? 'Nada coincide con eso.' : 'Buscando…'}</li> : null}
        </ul>
        <div className="oc-cmd-pie"><span><kbd>↑</kbd><kbd>↓</kbd> moverse</span><span><kbd>Enter</kbd> abrir</span></div>
      </div>
    </div>
  );
}
