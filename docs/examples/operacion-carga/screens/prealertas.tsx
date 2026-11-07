import { useMemo, useState } from 'react';
import type { DragEvent } from 'react';
import { cortex } from '@cortex/app-sdk';
import { ArrowRight, ClipboardPaste, Copy, FileScan, Link2, Plane, Search, Trash2, UploadCloud } from 'lucide-react';
import { MAX_ESCANEO, reducirImagen } from '../lib/archivos';
import { aPrealerta, cargarVuelos, traerTodo, useCarga, useRol } from '../lib/datos';
import type { Prealerta, Vuelo } from '../lib/datos';
import { fechaCorta, kg, num, N } from '../lib/formato';
import { desdeTexto, leer, normGuia, normNombre, normVuelo } from '../lib/manifiesto';
import { fechaIso } from '../lib/encabezado';
import { CANALES_PREALERTA, ESTADOS_CRUCE, TONO_CRUCE_DOC, faltantesDe, hayCampo, leerEsquema, puedeEditarDoc, soloExistentes, hace } from '../lib/documental';
import { FaltaAplicar } from '../lib/PiezasDoc';
import { parametro } from '../lib/ruta';
import { Boton, Campo, Chip, ErrorCaja, Estado, Hoja, Metrica, Pantalla, SelectorArchivo, Tabla, Tarjeta, avisar, mensajeDe, useOperacion } from '../lib/ui';
import { useGuardado } from '../lib/guardado';

/**
 * PREALERTAS — la entrada del documental. Soltar varias fotos o PDF, o pegar el texto de un
 * correo: se leen las guías, se revisan en una tabla y recién ahí se crean las prealertas con
 * su canal y su documento, enlazadas al vuelo cuando hay uno con ese número y fecha.
 */

interface Borrador {
  k: string;
  incluir: boolean;
  guia: string;
  cliente: string;
  numeroVuelo: string;
  aerolinea: string;
  origen: string;
  fecha: string;
  piezas: string;
  kilos: string;
  canal: string;
  duplicada: boolean;
  vueloId: string;
  fuente: string;
  archivo: File | null;
}

const A = {
  guia: ['guia', 'guía', 'awb', 'hawb', 'mawb', 'numero_guia', 'numero de guia', 'waybill', 'documento'],
  cliente: ['cliente', 'consignatario', 'consignee', 'destinatario', 'importador', 'shipper'],
  vuelo: ['numero_vuelo', 'vuelo', 'flight', 'flight_number', 'numero de vuelo'],
  aerolinea: ['aerolinea', 'airline', 'carrier'],
  origen: ['origen', 'origin', 'procedencia'],
  fecha: ['fecha_estimada', 'fecha', 'date', 'eta', 'fecha de llegada'],
  piezas: ['piezas', 'pieces', 'pcs', 'bultos'],
  kilos: ['kilos', 'kg', 'peso', 'weight', 'gross_weight'],
};

let SEQ = 0;
const nuevaClave = () => `b${Date.now().toString(36)}${SEQ++}`;

/** Lo que más pide acción va primero. */
const PRIORIDAD = (p: Prealerta): number => (p.estado === 'Duplicada' ? 5 : p.estadoCruce === 'Diferencia' ? 0 : p.estadoCruce === 'Faltante' || p.estadoCruce === 'Sobrante' ? 1 : p.estadoCruce === 'Sin vuelo' || !p.vueloId ? 2 : p.estadoCruce === 'En vuelo' ? 3 : 4);

/** Siguiente acción de una prealerta. */
const SIGUIENTE = (p: Prealerta): string =>
  p.estado === 'Duplicada' ? '' : p.estadoCruce === 'Diferencia' ? 'Siguiente: aclarar la diferencia con el cliente' : p.estadoCruce === 'Faltante' ? 'Siguiente: confirmar si llegó o avisar al cliente' : p.estadoCruce === 'Sobrante' ? 'Siguiente: pedir la prealerta que falta' : !p.vueloId ? 'Siguiente: enlazarla a un vuelo' : p.estadoCruce === 'En vuelo' ? 'Siguiente: esperar el recibo del vuelo' : '';

const irA = (screen: string, prefill?: Record<string, string | number>) => void cortex.nav.go({ screen, prefill }).catch(() => undefined);

interface Datos {
  pre: Prealerta[];
  vuelos: Vuelo[];
  esq: Awaited<ReturnType<typeof leerEsquema>>;
}

async function cargar(): Promise<Datos> {
  const [esq, filas, vuelos] = await Promise.all([leerEsquema(), traerTodo('prealertas', { order: { field: 'created_at', dir: 'desc' } }, 800), cargarVuelos(300)]);
  return { esq, pre: filas.map(aPrealerta), vuelos };
}

/** El vuelo que corresponde a un número y fecha (si la fecha viene, debe coincidir). */
function buscarVuelo(vuelos: Vuelo[], numero: string, fecha: string): Vuelo | null {
  const n = normVuelo(numero);
  if (!n) return null;
  return vuelos.find((v) => normVuelo(v.numero) === n && (!fecha || v.fecha === fecha)) ?? null;
}

export default function Prealertas() {
  const { rol } = useRol();
  const { data, loading, error, refresh } = useCarga(cargar, [], 60_000);
  const [borradores, setBorradores] = useState<Borrador[]>([]);
  const [leyendo, setLeyendo] = useState('');
  const [errorLectura, setErrorLectura] = useState<string | null>(null);
  const [texto, setTexto] = useState('');
  const [canalTexto, setCanalTexto] = useState<string>('Correo');
  const [filtroG, setFiltroG] = useGuardado<string>('prealertas-filtro', 'todas');
  const [filtroU, setFiltroU] = useState<string>(parametro('estado'));
  const filtro = filtroU || filtroG;
  const setFiltro = (v: string) => {
    setFiltroU(v);
    setFiltroG(v);
  };
  const [q, setQ] = useState('');
  const [enlazar, setEnlazar] = useState<Prealerta | null>(null);
  const [arrastrando, setArrastrando] = useState(false);
  const op = useOperacion();
  const lista = data?.pre ?? [];
  const vuelos = data?.vuelos ?? [];
  const esq = data?.esq;
  const puede = puedeEditarDoc(rol);
  const [progreso, setProgreso] = useState('');

  const faltan = esq ? faltantesDe(esq, { prealertas: ['vuelo', 'estado_cruce', 'guia_normalizada', 'documento', 'canal'] }) : [];

  const existentes = useMemo(() => {
    const s = new Set<string>();
    for (const p of lista) if (p.estado !== 'Duplicada') s.add(normGuia(p.guia));
    return s;
  }, [lista]);

  /** Convierte lo leído (renglones o encabezado) en borradores revisables. */
  const aBorradores = (rows: Record<string, string | number>[], base: { canal: string; fuente: string; archivo: File | null }): Borrador[] => {
    const out: Borrador[] = [];
    for (const r of rows) {
      const guia = leer(r, A.guia).toUpperCase().replace(/\s+/g, '');
      if (!guia) continue;
      const numero = leer(r, A.vuelo).toUpperCase().replace(/\s+/g, '');
      const fecha = fechaIso(leer(r, A.fecha));
      const v = buscarVuelo(vuelos, numero, fecha);
      out.push({
        k: nuevaClave(),
        incluir: true,
        guia,
        cliente: leer(r, A.cliente),
        numeroVuelo: numero || v?.numero || '',
        aerolinea: leer(r, A.aerolinea) || v?.aerolinea || '',
        origen: leer(r, A.origen) || v?.origen || '',
        fecha: fecha || v?.fecha || '',
        piezas: leer(r, A.piezas),
        kilos: leer(r, A.kilos),
        canal: base.canal,
        duplicada: false,
        vueloId: v?.id ?? '',
        fuente: base.fuente,
        archivo: base.archivo,
      });
    }
    return out;
  };

  /** Marca duplicadas: ya existe como prealerta o se repite entre los borradores. */
  const conDuplicadas = (bs: Borrador[]): Borrador[] => {
    const vistos = new Set<string>();
    return bs.map((b) => {
      const k = normGuia(b.guia);
      const repetida = !!k && (existentes.has(k) || vistos.has(k));
      if (k) vistos.add(k);
      return repetida ? { ...b, duplicada: true } : b;
    });
  };

  const leerArchivos = async (files: File[]) => {
    if (!puede) return;
    setErrorLectura(null);
    const nuevos: Borrador[] = [];
    const fallos: string[] = [];
    let i = 0;
    for (const f of files) {
      i += 1;
      setLeyendo(`Leyendo ${f.name} (${i} de ${files.length})…`);
      try {
        const listo = await reducirImagen(f);
        if (listo.size > MAX_ESCANEO) throw new Error('pesa más de 4 MB');
        let r = await cortex.docs.scan(listo, { kind: 'general', rows: true });
        let rows = r.rows.length ? r.rows : [r.fields];
        let bs = aBorradores(rows, { canal: 'Escaneo', fuente: f.name, archivo: listo });
        if (!bs.length) {
          r = await cortex.docs.scan(listo, { kind: 'guia' });
          rows = r.rows.length ? r.rows : [r.fields];
          bs = aBorradores(rows, { canal: 'Escaneo', fuente: f.name, archivo: listo });
        }
        if (!bs.length) fallos.push(`${f.name}: no se encontró ninguna guía`);
        nuevos.push(...bs);
      } catch (e) {
        fallos.push(`${f.name}: ${mensajeDe(e)}`);
      }
    }
    setLeyendo('');
    if (fallos.length) setErrorLectura(fallos.join(' · '));
    setBorradores((p) => conDuplicadas([...p, ...nuevos]));
  };

  const leerTexto = async () => {
    if (!texto.trim() || !puede) return;
    setErrorLectura(null);
    setLeyendo('Leyendo el texto…');
    let rows: Record<string, string | number>[] = [];
    try {
      const resp = await cortex.ai.ask(
        'Del siguiente texto (un correo o mensaje de prealerta de carga aérea) extrae TODAS las guías aéreas. Responde SOLO un arreglo JSON, sin comentarios, donde cada elemento tenga las claves: guia, cliente, numero_vuelo, aerolinea, origen, fecha (AAAA-MM-DD), piezas, kilos. Usa "" si un dato no aparece. No inventes guías.',
        { texto: texto.slice(0, 12_000) },
      );
      const i = resp.indexOf('[');
      const j = resp.lastIndexOf(']');
      const arr = JSON.parse(resp.slice(i, j + 1)) as unknown;
      if (Array.isArray(arr)) rows = arr.filter((x): x is Record<string, string | number> => !!x && typeof x === 'object');
    } catch {
      rows = desdeTexto(texto);
    }
    let bs = aBorradores(rows, { canal: canalTexto, fuente: 'Texto pegado', archivo: null });
    if (!bs.length) bs = aBorradores(desdeTexto(texto), { canal: canalTexto, fuente: 'Texto pegado', archivo: null });
    setLeyendo('');
    if (!bs.length) {
      setErrorLectura('No se reconoció ninguna guía en el texto. Escribe una por línea: guía, piezas y kilos.');
      return;
    }
    setBorradores((p) => conDuplicadas([...p, ...bs]));
    setTexto('');
  };

  const cambiar = (k: string, c: Partial<Borrador>) =>
    setBorradores((p) =>
      p.map((b) => {
        if (b.k !== k) return b;
        const n = { ...b, ...c };
        if ('numeroVuelo' in c || 'fecha' in c) {
          const v = buscarVuelo(vuelos, n.numeroVuelo, n.fecha);
          n.vueloId = v?.id ?? '';
        }
        return n;
      }),
    );

  const elegidos = borradores.filter((b) => b.incluir && b.guia.trim());

  const crear = async () => {
    if (!esq) return;
    let hechas = 0;
    const malas: string[] = [];
    const ok = new Set<string>();
    for (const b of elegidos) {
      setProgreso(`Creando ${hechas + malas.length + 1} de ${elegidos.length}…`);
      try {
        const v = b.vueloId ? vuelos.find((x) => x.id === b.vueloId) : undefined;
        const fila = await cortex.tables.insert(
          'prealertas',
          soloExistentes(esq, 'prealertas', {
            guia: b.guia.trim(),
            cliente: b.cliente.trim() || undefined,
            numero_vuelo: b.numeroVuelo.trim() || undefined,
            aerolinea: b.aerolinea.trim() || undefined,
            origen: b.origen.trim() || undefined,
            fecha_estimada: b.fecha || undefined,
            piezas: b.piezas ? N(b.piezas) : undefined,
            kilos: b.kilos ? N(b.kilos) : undefined,
            estado: b.duplicada ? 'Duplicada' : undefined,
            canal: b.canal || undefined,
            guia_normalizada: normGuia(b.guia),
            vuelo: v?.id,
            estado_cruce: v ? 'En vuelo' : 'Sin vuelo',
          }),
        );
        if (b.archivo && hayCampo(esq, 'prealertas', 'documento')) {
          try {
            await cortex.files.upload(b.archivo, { table: 'prealertas', id: fila.id, field: 'documento', name: b.archivo.name });
          } catch (e) {
            malas.push(`${b.guia} (documento): ${mensajeDe(e)}`);
          }
        }
        hechas += 1;
        ok.add(b.k);
      } catch (e) {
        malas.push(`${b.guia}: ${mensajeDe(e)}`);
      }
    }
    setProgreso('');
    setBorradores((p) => p.filter((b) => !ok.has(b.k)));
    if (hechas) avisar(`${hechas} prealertas creadas.`);
    if (malas.length) throw new Error(`No se pudo crear: ${malas.join(' · ')}`);
    await refresh();
  };

  const filtradas = useMemo(() => {
    const qn = normNombre(q);
    return lista
      .filter((p) => (filtro === 'todas' ? true : filtro === 'duplicadas' ? p.estado === 'Duplicada' : p.estadoCruce === filtro || (filtro === 'Sin vuelo' && !p.estadoCruce && !p.vueloId)))
      .filter((p) => !qn || normNombre(`${p.guia} ${p.cliente} ${p.numeroVuelo}`).includes(qn))
      .sort((a, b) => PRIORIDAD(a) - PRIORIDAD(b))
      .slice(0, 150);
  }, [lista, filtro, q]);

  const merflex = useMemo(() => {
    const m = lista.filter((p) => p.canal === 'Hoja MERFLEX');
    const base = m.length ? m : lista.filter((p) => !p.canal);
    return base.length ? base.reduce((a, b) => (a.creada > b.creada ? a : b)) : null;
  }, [lista]);

  const conteo = (e: string) => lista.filter((p) => p.estadoCruce === e || (e === 'Sin vuelo' && !p.estadoCruce && !p.vueloId)).length;

  const soltar = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setArrastrando(false);
    const fs = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/') || f.type === 'application/pdf');
    if (fs.length) void leerArchivos(fs);
  };

  return (
    <Pantalla titulo="Prealertas" sub="Lo que anuncian los clientes antes de que llegue el vuelo: se lee, se revisa y se cruza.">
      <FaltaAplicar faltan={faltan} />

      <div className="oc-kpis">
        <Metrica etiqueta="Prealertas" valor={num(lista.length)} />
        <Metrica etiqueta="Sin vuelo" valor={conteo('Sin vuelo')} tono={conteo('Sin vuelo') ? 'warn' : undefined} />
        <Metrica etiqueta="Coinciden" valor={conteo('Coincide')} tono="good" />
        <Metrica etiqueta="Con problema" valor={conteo('Faltante') + conteo('Sobrante') + conteo('Diferencia')} tono={conteo('Faltante') + conteo('Sobrante') + conteo('Diferencia') ? 'bad' : undefined} />
        <Metrica etiqueta="Última fila de MERFLEX" valor={merflex ? hace(merflex.creada).replace('hace ', '') : '—'} pista={merflex ? `${merflex.guia} · ${merflex.creada.slice(0, 10)}` : 'La hoja todavía no ha traído filas'} />
      </div>

      {puede ? (
        <div className="oc-sec">
          <h2>Entrada</h2>
          <Tarjeta>
            <div className="oc-form">
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setArrastrando(true);
                }}
                onDragLeave={() => setArrastrando(false)}
                onDrop={soltar}
                style={{ border: `2px dashed ${arrastrando ? 'var(--acento)' : 'var(--linea2)'}`, borderRadius: 16, padding: 18, textAlign: 'center', background: arrastrando ? 'var(--acento-fondo)' : 'transparent' }}
              >
                <UploadCloud size={30} style={{ color: 'var(--acento)' }} />
                <p style={{ margin: '6px 0 12px' }}>
                  <b>Suelta aquí fotos o PDF</b> de las prealertas, o elígelos.
                </p>
                <div className="oc-btns" style={{ justifyContent: 'center' }}>
                  <SelectorArchivo etiqueta="Subir fotos o PDF" accept="image/*,application/pdf" multiple tono="primario" disabled={!!leyendo || op.ocupado} onArchivos={(fs) => void leerArchivos(fs)} />
                  <SelectorArchivo etiqueta="Fotografiar" camara="environment" disabled={!!leyendo || op.ocupado} onArchivos={(fs) => void leerArchivos(fs)} />
                </div>
              </div>
              <Campo etiqueta="O pega el correo o el mensaje" ayuda="Se leen las guías del texto; revisas antes de crear nada.">
                <textarea className="oc-pegar" rows={5} value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'Asunto y cuerpo del correo, o una guía por línea:\n176-12345678  12  340,5'} />
              </Campo>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <div style={{ maxWidth: 220 }}>
                  <select aria-label="Canal del texto" value={canalTexto} onChange={(e) => setCanalTexto(e.target.value)}>
                    {CANALES_PREALERTA.filter((c) => c !== 'Escaneo').map((c) => (
                      <option key={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <Boton onClick={() => void leerTexto()} disabled={!texto.trim() || !!leyendo} icono={<ClipboardPaste size={18} />}>
                  Leer el texto
                </Boton>
              </div>
              {leyendo ? (
                <>
                  <div className="oc-escaner" aria-hidden="true" />
                  <div className="oc-aviso" role="status">
                    <FileScan size={16} style={{ verticalAlign: -3 }} /> {leyendo}
                  </div>
                </>
              ) : null}
              {errorLectura ? <ErrorCaja mensaje={errorLectura} /> : null}
            </div>
          </Tarjeta>
        </div>
      ) : null}

      {borradores.length ? (
        <div className="oc-sec">
          <h2>Revisar antes de crear</h2>
          <Tarjeta>
            <div className="oc-form">
              <Tabla
                columnas={[{ t: 'Crear' }, { t: 'Guía' }, { t: 'Cliente' }, { t: 'Vuelo' }, { t: 'Fecha' }, { t: 'Piezas', n: true }, { t: 'Kilos', n: true }, { t: 'Canal' }, { t: 'Duplicada' }, { t: '' }]}
                pie={
                  <tr>
                    <td colSpan={10}>{elegidos.length} de {borradores.length} prealertas a crear</td>
                  </tr>
                }
              >
                {borradores.map((b) => (
                  <tr key={b.k} className={b.incluir ? '' : 'sin'}>
                    <td>
                      <input type="checkbox" checked={b.incluir} onChange={(e) => cambiar(b.k, { incluir: e.target.checked })} aria-label="Crear esta prealerta" style={{ width: 22, height: 22, minHeight: 0, minWidth: 0 }} />
                    </td>
                    <td>
                      <input type="text" value={b.guia} onChange={(e) => cambiar(b.k, { guia: e.target.value.toUpperCase() })} aria-label="Guía" style={{ minWidth: 140 }} />
                      <div className="oc-sub">{b.fuente}</div>
                    </td>
                    <td>
                      <input type="text" value={b.cliente} onChange={(e) => cambiar(b.k, { cliente: e.target.value })} aria-label="Cliente" style={{ minWidth: 150 }} />
                    </td>
                    <td>
                      <input type="text" value={b.numeroVuelo} onChange={(e) => cambiar(b.k, { numeroVuelo: e.target.value.toUpperCase() })} aria-label="Número de vuelo" style={{ minWidth: 90 }} />
                      <div>{b.vueloId ? <Chip tono="info">En vuelo</Chip> : <Chip tono="warn">Sin vuelo</Chip>}</div>
                    </td>
                    <td>
                      <input type="date" value={b.fecha} onChange={(e) => cambiar(b.k, { fecha: e.target.value })} aria-label="Fecha" />
                    </td>
                    <td className="n">
                      <input type="text" inputMode="decimal" value={b.piezas} onChange={(e) => cambiar(b.k, { piezas: e.target.value })} aria-label="Piezas" style={{ minWidth: 70, textAlign: 'right' }} />
                    </td>
                    <td className="n">
                      <input type="text" inputMode="decimal" value={b.kilos} onChange={(e) => cambiar(b.k, { kilos: e.target.value })} aria-label="Kilos" style={{ minWidth: 90, textAlign: 'right' }} />
                    </td>
                    <td>
                      <select value={b.canal} onChange={(e) => cambiar(b.k, { canal: e.target.value })} aria-label="Canal">
                        {CANALES_PREALERTA.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <input type="checkbox" checked={b.duplicada} onChange={(e) => cambiar(b.k, { duplicada: e.target.checked })} aria-label="Marcar duplicada" style={{ width: 22, height: 22, minHeight: 0, minWidth: 0 }} />
                      {b.duplicada ? <div className="oc-sub">Ya existe</div> : null}
                    </td>
                    <td>
                      <Boton chico tono="suave" aria-label="Quitar" onClick={() => setBorradores((p) => p.filter((x) => x.k !== b.k))} icono={<Trash2 size={16} />} />
                    </td>
                  </tr>
                ))}
              </Tabla>
              {op.error ? <ErrorCaja mensaje={op.error} /> : null}
              <div className="oc-btns">
                <Boton tono="primario" disabled={!elegidos.length || op.ocupado} onClick={() => void op.correr(crear)}>
                  {op.ocupado ? progreso || 'Creando…' : `Crear ${elegidos.length} prealertas`}
                </Boton>
                <Boton tono="suave" disabled={op.ocupado} onClick={() => setBorradores([])}>
                  Descartar todo
                </Boton>
              </div>
            </div>
          </Tarjeta>
        </div>
      ) : null}

      <div className="oc-sec">
        <h2>Prealertas registradas</h2>
        <div className="oc-form" style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ maxWidth: 230 }}>
              <select aria-label="Filtrar por cruce" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
                <option value="todas">Todas</option>
                {ESTADOS_CRUCE.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
                <option value="duplicadas">Duplicadas</option>
              </select>
            </div>
            <div style={{ flex: '1 1 200px', position: 'relative', maxWidth: 340 }}>
              <input type="search" placeholder="Buscar guía, cliente o vuelo" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 38 }} />
              <Search size={16} style={{ position: 'absolute', left: 12, top: 15, color: 'var(--suave)' }} />
            </div>
          </div>
        </div>
        <Estado cargando={loading} error={error} vacio={!filtradas.length} tituloVacio="No hay prealertas con ese filtro" textoVacio={<p>Suelta una foto o pega un correo arriba para crear la primera.</p>} reintentar={() => void refresh()}>
          <ul className="oc-lista">
            {filtradas.map((p) => (
              <li key={p.id} className={`oc-item ${p.estadoCruce === 'Diferencia' ? 'bad' : p.estadoCruce === 'Sin vuelo' || p.estadoCruce === 'Faltante' ? 'hot' : ''}`}>
                <div className="oc-item-top">
                  <span>
                    <b className="oc-mono">{p.guia}</b> <span className="oc-sub">{p.cliente}</span>
                  </span>
                  <span className="oc-chips">
                    {p.estado === 'Duplicada' ? <Chip tono="bad">Duplicada</Chip> : null}
                    {p.estadoCruce ? <Chip tono={TONO_CRUCE_DOC[p.estadoCruce] ?? 'neutral'}>{p.estadoCruce}</Chip> : !p.vueloId ? <Chip tono="warn">Sin vuelo</Chip> : null}
                    {p.canal ? <Chip tono="quiet">{p.canal}</Chip> : null}
                  </span>
                </div>
                <div className="oc-meta">
                  {p.numeroVuelo ? <span>Vuelo {p.numeroVuelo}</span> : null}
                  {p.fecha ? <span>{fechaCorta(p.fecha)}</span> : null}
                  {p.kilos ? <span>{kg(p.kilos)}</span> : null}
                  {p.piezas ? <span>{num(p.piezas)} piezas</span> : null}
                  {p.documento.length ? (
                    <a href={p.documento[0]?.url} target="_blank" rel="noreferrer">
                      Ver documento
                    </a>
                  ) : null}
                </div>
                {SIGUIENTE(p) ? <p className="oc-siguiente"><ArrowRight size={14} /> {SIGUIENTE(p)}</p> : null}
                <div className="oc-btns">
                  {p.vueloId ? (
                    <Boton chico onClick={() => irA('vuelo', { vuelo: p.vueloId, tab: 'guias' })} icono={<Plane size={15} />}>
                      Abrir vuelo
                    </Boton>
                  ) : null}
                  {puede && p.estado !== 'Duplicada' ? (
                    <Boton chico onClick={() => setEnlazar(p)} icono={<Link2 size={15} />}>
                      {p.vueloId ? 'Cambiar vuelo' : 'Enlazar a vuelo'}
                    </Boton>
                  ) : null}
                  {puede && p.estado !== 'Duplicada' ? (
                    <Boton
                      chico
                      tono="suave"
                      disabled={op.ocupado}
                      onClick={() => void op.correr(() => cortex.tables.update('prealertas', p.id, { estado: 'Duplicada' }), 'Marcada como duplicada.').then((ok) => (ok ? refresh() : undefined))}
                      icono={<Copy size={15} />}
                    >
                      Marcar duplicada
                    </Boton>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {lista.length > filtradas.length && filtro === 'todas' && !q ? <p className="oc-sub" style={{ marginTop: 8 }}>Se muestran las 150 más recientes; usa la búsqueda para encontrar otras.</p> : null}
        </Estado>
      </div>

      {enlazar ? (
        <EnlazarVuelo
          prealerta={enlazar}
          vuelos={vuelos}
          onCerrar={() => setEnlazar(null)}
          onListo={async () => {
            setEnlazar(null);
            await refresh();
          }}
        />
      ) : null}
    </Pantalla>
  );
}

function EnlazarVuelo({ prealerta, vuelos, onCerrar, onListo }: { prealerta: Prealerta; vuelos: Vuelo[]; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [id, setId] = useState(prealerta.vueloId);
  const [q, setQ] = useState('');
  const op = useOperacion();
  const opciones = vuelos
    .filter((v) => !['Cancelado'].includes(v.estado))
    .filter((v) => !q.trim() || normNombre(`${v.numero} ${v.aerolinea} ${v.fecha}`).includes(normNombre(q)))
    .slice(0, 40);
  return (
    <Hoja titulo={`Enlazar ${prealerta.guia}`} onCerrar={onCerrar}>
      <div className="oc-form">
        <p className="oc-sub">
          Prealerta con vuelo «{prealerta.numeroVuelo || '—'}» {prealerta.fecha ? `del ${fechaCorta(prealerta.fecha)}` : ''}. Elige el vuelo al que pertenece.
        </p>
        <input type="search" placeholder="Buscar vuelo, aerolínea o fecha" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="oc-lista" style={{ maxHeight: 300, overflow: 'auto' }}>
          {opciones.map((v) => (
            <li key={v.id} className={`oc-item ${id === v.id ? 'hot' : ''}`} style={{ cursor: 'pointer' }} onClick={() => setId(v.id)}>
              <div className="oc-item-top">
                <span>
                  <b>{v.numero}</b> <span className="oc-sub">{fechaCorta(v.fecha)} · {v.aerolinea}</span>
                </span>
                {id === v.id ? <Chip tono="info">Elegido</Chip> : null}
              </div>
            </li>
          ))}
        </ul>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton
          tono="primario"
          disabled={!id || op.ocupado}
          onClick={async () => {
            const v = vuelos.find((x) => x.id === id);
            const ok = await op.correr(
              () =>
                cortex.tables.update('prealertas', prealerta.id, {
                  vuelo: id,
                  estado_cruce: 'En vuelo',
                  ...(prealerta.numeroVuelo ? {} : { numero_vuelo: v?.numero }),
                }),
              'Prealerta enlazada al vuelo.',
            );
            if (ok) await onListo();
          }}
        >
          {op.ocupado ? 'Guardando…' : 'Enlazar'}
        </Boton>
      </div>
    </Hoja>
  );
}
