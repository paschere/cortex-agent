import { useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { Check, Eye, Plus } from 'lucide-react';
import { Dictado } from '../lib/dictado';
import { aAtencion, aEvento, cargarVuelos, porRelacion, traerTodo, useAcciones, useCarga, useRol } from '../lib/datos';
import type { Evento } from '../lib/datos';
import { TIPOS_EVENTO, TONO_EVENTO, tono } from '../lib/estados';
import { N, cop, fechaCorta, hhmm } from '../lib/formato';
import { parametro } from '../lib/ruta';
import { Adjuntos, Boton, Campo, Chip, ES_VIVO, ErrorCaja, Estado, Hoja, Numero, Pantalla, SelectorArchivo, Segmentos, subirArchivo, useOperacion } from '../lib/ui';

/**
 * EVENTOS — lo que pasa en plataforma, con o sin vuelo: registrar (con voz y fotos)
 * y, para el supervisor, marcar Revisado / Resuelto y dejar una nota.
 */

type Filtro = 'abiertos' | 'todos' | 'criticos';

export default function Eventos() {
  const { rol } = useRol();
  const acc = useAcciones('eventos_operacion');
  const { data, loading, error, refresh } = useCarga(async () => (await traerTodo('eventos_operacion', { order: { field: 'created_at', dir: 'desc' } }, 300)).map(aEvento), [], 30_000);
  const [filtro, setFiltro] = useState<Filtro>('abiertos');
  const [q, setQ] = useState('');
  const [nuevo, setNuevo] = useState(false);
  const [abierto, setAbierto] = useState<Evento | null>(null);
  const op = useOperacion();
  const puedeCrear = rol !== 'gerencia';

  const lista = useMemo(() => {
    const qn = q.trim().toLowerCase();
    return (data ?? [])
      .filter((e) => (filtro === 'abiertos' ? e.estado !== 'Resuelto' : filtro === 'criticos' ? e.critico : true))
      .filter((e) => !qn || `${e.tipo} ${e.descripcion} ${e.vuelo} ${e.operario} ${e.equipo} ${e.proveedor}`.toLowerCase().includes(qn));
  }, [data, filtro, q]);

  const marcar = async (e: Evento, clave: 'ev_revisado' | 'ev_resuelto', texto: string) => {
    const ok = await op.correr(() => cortex.tables.action('eventos_operacion', e.id, clave), texto);
    if (ok) await refresh();
  };

  return (
    <Pantalla
      titulo="Eventos"
      sub="Comienzos y fines de recepción, tanqueos, equipos varados, daños y novedades."
      acciones={
        puedeCrear ? (
          <Boton tono="primario" onClick={() => setNuevo(true)} icono={<Plus size={18} />}>
            Registrar evento
          </Boton>
        ) : undefined
      }
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16, alignItems: 'center' }}>
        <Segmentos
          valor={filtro}
          onChange={setFiltro}
          opciones={[{ id: 'abiertos', texto: 'Por atender' }, { id: 'criticos', texto: 'Críticos' }, { id: 'todos', texto: 'Todos' }]}
        />
        <div style={{ flex: '1 1 220px', maxWidth: 340 }}>
          <input type="search" placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      <Estado
        cargando={loading}
        error={error}
        vacio={!lista.length}
        tituloVacio={filtro === 'abiertos' ? 'No hay eventos por atender' : 'No hay eventos con ese filtro'}
        textoVacio={<p>{puedeCrear ? 'Cuando pase algo en plataforma, regístralo con «Registrar evento».' : 'Aquí aparecerá lo que registren los operarios.'}</p>}
        reintentar={() => void refresh()}
      >
        <ul className="oc-lista" style={{ marginTop: op.error ? 14 : 0 }}>
          {lista.map((e) => (
            <li key={e.id} className={`oc-item ${e.critico ? 'bad' : ''}`}>
              <div className="oc-item-top">
                <strong>{e.tipo}</strong>
                <span className="oc-chips">
                  {e.critico ? <Chip tono="bad">Crítico</Chip> : null}
                  {e.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}
                  <Chip tono={tono(TONO_EVENTO, e.estado)} vivo={ES_VIVO.has(e.estado)}>{e.estado}</Chip>
                </span>
              </div>
              <p>{e.descripcion}</p>
              <div className="oc-meta">
                <span>{fechaCorta(e.fecha)} {hhmm(e.hora)}</span>
                {e.operario ? <span>{e.operario}</span> : null}
                {e.vuelo ? <span className="oc-mono">{e.vuelo}</span> : null}
                {e.equipo ? <span>{e.equipo}{e.proveedor ? ` (${e.proveedor})` : ''}</span> : null}
                {e.costo ? <span>{cop(e.costo)}</span> : null}
              </div>
              <Adjuntos lista={[...e.fotos, ...e.documentos]} />
              {e.nota ? <div className="oc-aviso">Nota del supervisor: {e.nota}</div> : null}
              <div className="oc-btns">
                <Boton chico onClick={() => setAbierto(e)} icono={<Eye size={15} />}>Detalle</Boton>
                {acc.lista && acc.tiene('ev_revisado') && e.estado === 'Abierto' ? (
                  <Boton chico disabled={op.ocupado} onClick={() => void marcar(e, 'ev_revisado', 'Marcado como revisado.')}>Revisado</Boton>
                ) : null}
                {acc.lista && acc.tiene('ev_resuelto') && e.estado !== 'Resuelto' ? (
                  <Boton chico tono="ok" disabled={op.ocupado} onClick={() => void marcar(e, 'ev_resuelto', 'Marcado como resuelto.')} icono={<Check size={15} />}>Resuelto</Boton>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      </Estado>

      {nuevo ? (
        <NuevoEvento
          onCerrar={() => setNuevo(false)}
          onListo={async () => {
            setNuevo(false);
            await refresh();
          }}
        />
      ) : null}
      {abierto ? <Detalle e={abierto} puedeNota={!!acc.lista && acc.tiene('ev_revisado')} onCerrar={() => setAbierto(null)} onListo={async () => { setAbierto(null); await refresh(); }} /> : null}
    </Pantalla>
  );
}

function Detalle({ e, puedeNota, onCerrar, onListo }: { e: Evento; puedeNota: boolean; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [nota, setNota] = useState(e.nota);
  const op = useOperacion();
  return (
    <Hoja titulo={e.tipo} onCerrar={onCerrar}>
      <div className="oc-form">
        <p>{e.descripcion}</p>
        <dl className="oc-pares">
          <dt>Cuándo</dt><dd>{fechaCorta(e.fecha)} {hhmm(e.hora)}</dd>
          <dt>Quién</dt><dd>{e.operario || '—'}</dd>
          <dt>Vuelo</dt><dd>{e.vuelo || '—'}</dd>
          <dt>Equipo</dt><dd>{e.equipo || '—'} {e.proveedor ? `· ${e.proveedor}` : ''}</dd>
          <dt>Costo</dt><dd>{e.costo ? cop(e.costo) : '—'}</dd>
          <dt>Zona</dt><dd>{e.zona || '—'} {e.fueraDeZona ? <Chip tono="bad">Fuera de zona</Chip> : null}</dd>
        </dl>
        <Adjuntos lista={[...e.fotos, ...e.documentos]} />
        {puedeNota ? (
          <>
            <Campo etiqueta="Nota del supervisor"><textarea value={nota} onChange={(x) => setNota(x.target.value)} rows={3} /></Campo>
            {op.error ? <ErrorCaja mensaje={op.error} /> : null}
            <Boton tono="primario" disabled={op.ocupado || nota.trim() === e.nota.trim()} onClick={async () => {
              const ok = await op.correr(() => cortex.tables.update('eventos_operacion', e.id, { nota_supervisor: nota.trim() }), 'Nota guardada.');
              if (ok) await onListo();
            }}>Guardar nota</Boton>
          </>
        ) : null}
      </div>
    </Hoja>
  );
}

function NuevoEvento({ onCerrar, onListo }: { onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [tipo, setTipo] = useState<string>(TIPOS_EVENTO[0]);
  const [desc, setDesc] = useState('');
  const [vueloId, setVueloId] = useState(parametro('vuelo'));
  const [atencionId, setAtencionId] = useState('');
  const [equipo, setEquipo] = useState('');
  const [proveedor, setProveedor] = useState('');
  const [costo, setCosto] = useState('');
  const [fotos, setFotos] = useState<File[]>([]);
  const [docs, setDocs] = useState<File[]>([]);
  const op = useOperacion();
  const vuelos = useCarga(() => cargarVuelos(80), []);
  const atenciones = useCarga(async () => (vueloId ? (await porRelacion('atenciones', 'vuelo', vueloId)).map(aAtencion) : []), [vueloId]);

  const registrar = async () => {
    const ok = await op.correr(async () => {
      const fila = await cortex.tables.insert('eventos_operacion', {
        tipo,
        descripcion: desc.trim(),
        ...(vueloId ? { vuelo: vueloId } : {}),
        ...(atencionId ? { atencion: atencionId } : {}),
        ...(equipo.trim() ? { equipo: equipo.trim() } : {}),
        ...(proveedor.trim() ? { proveedor: proveedor.trim() } : {}),
        ...(costo.trim() ? { costo: N(costo) } : {}),
      });
      for (const f of fotos) await subirArchivo(f, { table: 'eventos_operacion', id: fila.id, field: 'fotos' });
      for (const f of docs) await subirArchivo(f, { table: 'eventos_operacion', id: fila.id, field: 'documentos' });
    }, 'Evento registrado.');
    if (ok) await onListo();
  };

  return (
    <Hoja titulo="Registrar un evento" onCerrar={onCerrar}>
      <div className="oc-form">
        <Campo etiqueta="Tipo">
          <select value={tipo} onChange={(e) => setTipo(e.target.value)}>
            {TIPOS_EVENTO.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Campo>
        <Campo etiqueta="¿Qué pasó?">
          <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} />
        </Campo>
        <div><Dictado onTexto={(t) => setDesc((d) => (d ? `${d} ${t}` : t))} /></div>
        <div className="oc-fila2">
          <Campo etiqueta="Vuelo (opcional)">
            <select value={vueloId} onChange={(e) => { setVueloId(e.target.value); setAtencionId(''); }}>
              <option value="">Sin vuelo</option>
              {(vuelos.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.numero} · {fechaCorta(v.fecha)}</option>)}
            </select>
          </Campo>
          <Campo etiqueta="Atención (opcional)">
            <select value={atencionId} onChange={(e) => setAtencionId(e.target.value)} disabled={!vueloId}>
              <option value="">Ninguna</option>
              {(atenciones.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.operario || 'Atención'} · {a.estado}</option>)}
            </select>
          </Campo>
        </div>
        <div className="oc-fila3">
          <Campo etiqueta="Equipo"><input type="text" value={equipo} onChange={(e) => setEquipo(e.target.value)} /></Campo>
          <Campo etiqueta="Proveedor"><input type="text" value={proveedor} onChange={(e) => setProveedor(e.target.value)} /></Campo>
          <Campo etiqueta="Costo (COP)"><Numero valor={costo} onChange={setCosto} /></Campo>
        </div>
        <div className="oc-btns">
          <SelectorArchivo etiqueta={fotos.length ? `${fotos.length} foto(s)` : 'Fotos'} camara="environment" multiple onArchivos={(f) => setFotos((p) => [...p, ...f])} />
          <SelectorArchivo etiqueta={docs.length ? `${docs.length} documento(s)` : 'Documentos'} accept="application/pdf,image/*" multiple onArchivos={(f) => setDocs((p) => [...p, ...f])} />
        </div>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" disabled={op.ocupado || !desc.trim()} onClick={() => void registrar()}>
          {op.ocupado ? 'Registrando…' : 'Registrar evento'}
        </Boton>
        {!desc.trim() ? <p className="oc-sub">Cuenta brevemente qué pasó para poder registrarlo.</p> : null}
      </div>
    </Hoja>
  );
}

