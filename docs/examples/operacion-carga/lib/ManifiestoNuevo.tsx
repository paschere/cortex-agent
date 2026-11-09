import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import type { SdkRow } from '@cortex/app-sdk';
import { ClipboardPaste, Download, FileSpreadsheet, FileText, Plus, Printer, Save, Trash2, X } from 'lucide-react';
import { aGuia, aPrealerta, porRelacion, relId, T, traerTodo } from './datos';
import type { Prealerta, Vuelo } from './datos';
import { AEROLINEAS_MANIFIESTO, aerolineaDe, aerolineaManifiesto, aprenderAerolineas } from './aerolineas';
import { escanearManifiesto } from './ManifiestoVuelo';
import { hayCampo, isoBogota, soloExistentes } from './documental';
import type { Esquema } from './documental';
import { N, kg, num } from './formato';
import { clienteId, leer, normGuia, normVuelo, prealertasDelVuelo } from './manifiesto';
import { MANIFIESTO_VACIO, MIME_XLSX, RENGLONES_POR_PAGINA, guiaVacia, guiasDesdeTexto, guiasUtiles, htmlManifiesto, logoDe, logoImagenDe, numeroPaginas, renglonConDatos, totalesManifiesto, xlsxManifiesto } from './manifiesto-doc';
import type { GuiaManifiesto, Manifiesto } from './manifiesto-doc';
import { fechaIso } from './encabezado';
import { hoyBogota } from './tiempo';
import { Boton, Campo, Chip, ErrorCaja, SelectorArchivo, avisar, mensajeDe, useOperacion } from './ui';
import './manifiesto.css';

/**
 * NUEVO MANIFIESTO — primer paso del documental: se arma el manifiesto de la aerolínea con el
 * formato de su plantilla, se guarda (crea o actualiza el vuelo y sus guías) y se exporta tal cual
 * (Imprimir / PDF y Excel). También reabre un vuelo para editarlo y reimprimirlo.
 */

/** Campos nuevos que el guardado usa; si faltan en el servidor se avisa qué aplicar. */
const NUEVOS: Record<string, string[]> = {
  vuelos: ['preparado_por', 'manifiesto_impreso_en'],
  prefacturacion: ['naturaleza', 'consignatario'],
};

const ALIAS_NAT = ['naturaleza', 'naturaleza de la mercancia', 'nature of goods', 'descripcion', 'description', 'mercancia', 'contenido'];
const ALIAS_CONS = ['consignatario', 'consignee', 'consignees', 'cliente', 'destinatario'];
const ALIAS_GUIA = ['guia', 'guía', 'awb', 'hawb', 'airwaybill', 'numero de guia', 'waybill'];
const ALIAS_PAQ = ['paquetes', 'piezas', 'pieces', 'pcs', 'bultos', 'number of packages'];
const ALIAS_PESO = ['peso', 'kilos', 'kg', 'weight', 'peso bruto'];

type Fila = GuiaManifiesto & { k: string };
let contador = 0;
const nuevaFila = (g: GuiaManifiesto = guiaVacia()): Fila => ({ ...g, k: `f${Date.now().toString(36)}-${contador++}` });
const conVacia = (f: Fila[]): Fila[] => (f.length && !renglonConDatos(f[f.length - 1]!) ? f : [...f, nuevaFila()]);


export function ManifiestoNuevo({
  vuelo,
  vuelos,
  esq,
  soloLectura,
  onCerrar,
  onGuardado,
}: {
  vuelo?: Vuelo | null;
  vuelos: Vuelo[];
  esq: Esquema;
  soloLectura?: boolean;
  onCerrar: () => void;
  onGuardado?: (vueloId: string) => void | Promise<void>;
}) {
  const op = useOperacion();
  const [m, setM] = useState<Manifiesto>(() => ({
    ...MANIFIESTO_VACIO,
    fecha: vuelo?.fecha ?? hoyBogota(),
    vuelo: vuelo?.numero ?? '',
    aerolinea: vuelo?.aerolinea ?? '',
    origen: vuelo?.origen ?? '',
    destino: vuelo?.destino || 'BOG',
    matricula: vuelo?.matricula ?? '',
  }));
  const [filas, setFilas] = useState<Fila[]>(() => [nuevaFila()]);
  const [vueloId, setVueloId] = useState<string>(vuelo?.id ?? '');
  const [prealertas, setPrealertas] = useState<{ p: Prealerta; clienteId: string }[]>([]);
  const [clientes, setClientes] = useState<{ id: string; label: string }[]>([]);
  const [existentes, setExistentes] = useState<Record<string, string>>({}); // guía normalizada → id
  const [tab, setTab] = useState<'datos' | 'vista'>('datos');
  const [pegando, setPegando] = useState(false);
  const [texto, setTexto] = useState('');
  const [leyendo, setLeyendo] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [verPre, setVerPre] = useState(false);
  const aeroAuto = useRef(!vuelo?.aerolinea);
  const aprendidas = useMemo(() => aprenderAerolineas(vuelos.map((v) => ({ numero: v.numero, aerolinea: v.aerolinea }))), [vuelos]);
  const nombresAero = useMemo(() => [...new Set(vuelos.map((v) => v.aerolinea).filter(Boolean))].sort(), [vuelos]);
  const bloqueado = !!soloLectura;

  // Datos de apoyo: prealertas, clientes y, si se reabre un vuelo, sus guías y encabezado.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const [pre, cli] = await Promise.all([traerTodo('prealertas', { order: { field: 'created_at', dir: 'desc' } }, 1000).catch(() => [] as SdkRow[]), traerTodo('clientes_facturacion', {}, 1500).catch(() => [] as SdkRow[])]);
      if (!vivo) return;
      setPrealertas(pre.map((r) => ({ p: aPrealerta(r), clienteId: relId(r.values.cliente) })));
      setClientes(cli.map((r) => ({ id: r.id, label: T(r.values.nombre) || T(r.values.razon_social) || r.label })));
      if (vuelo) {
        const [fila, gs] = await Promise.all([cortex.tables.get('vuelos', vuelo.id).catch(() => null), porRelacion('prefacturacion', 'vuelo', vuelo.id).catch(() => [] as SdkRow[])]);
        if (!vivo) return;
        if (fila) setM((p) => ({ ...p, preparado_por: T(fila.values.preparado_por) }));
        setExistentes(Object.fromEntries(gs.map((g) => [normGuia(aGuia(g).guia), g.id])));
        setFilas(
          conVacia(
            gs.map((g) => {
              const x = aGuia(g);
              return nuevaFila({ guia: x.guia, paquetes: x.piezasEsp ? String(x.piezasEsp) : '', peso: x.kilosEsp ? String(x.kilosEsp) : '', naturaleza: T(g.values.naturaleza), consignatario: T(g.values.consignatario) || x.cliente });
            }),
          ),
        );
      }
    })();
    return () => {
      vivo = false;
    };
  }, [vuelo]);

  // El vuelo ya existe (mismo número y fecha): se actualiza en vez de crear otro.
  const existenteVuelo = useMemo(() => {
    if (vuelo) return vuelo;
    const n = normVuelo(m.vuelo);
    return n && m.fecha ? (vuelos.find((v) => normVuelo(v.numero) === n && v.fecha === m.fecha) ?? null) : null;
  }, [vuelo, vuelos, m.vuelo, m.fecha]);

  // Logo de la aerolínea: el incrustado en la app (sin descargar nada, siempre disponible).
  useEffect(() => {
    const url = logoDe(m.aerolinea);
    const logo = logoImagenDe(m.aerolinea);
    setM((p) => (p.logoUrl === (url || undefined) && p.logo === logo ? p : { ...p, logoUrl: url || undefined, logo }));
  }, [m.aerolinea]);

  const set = <K extends keyof Manifiesto>(k: K, v: Manifiesto[K]) => setM((p) => ({ ...p, [k]: v }));
  const cambiarVuelo = (v: string) => {
    const t = v.toUpperCase();
    setM((p) => {
      const n = aeroAuto.current ? aerolineaDe(t, aprendidas) : null;
      return { ...p, vuelo: t, aerolinea: aeroAuto.current && n ? n : p.aerolinea };
    });
  };
  const elegirAero = (nombre: string) => {
    aeroAuto.current = false;
    set('aerolinea', nombre);
  };

  const cambiar = (i: number, c: keyof GuiaManifiesto, v: string) => setFilas((p) => conVacia(p.map((f, j) => (j === i ? { ...f, [c]: c === 'guia' ? v.toUpperCase() : v } : f))));
  const quitar = (i: number) => setFilas((p) => conVacia(p.filter((_, j) => j !== i)));
  const agregar = (gs: GuiaManifiesto[]) =>
    setFilas((p) => {
      const base = p.filter(renglonConDatos);
      return conVacia([...base, ...gs.map((g) => nuevaFila(g))]);
    });

  const alPegar = (e: React.ClipboardEvent, i: number) => {
    const t = e.clipboardData.getData('text');
    if (!/\t|\n/.test(t)) return;
    e.preventDefault();
    const gs = guiasDesdeTexto(t);
    if (!gs.length) return;
    setFilas((p) => {
      const antes = p.slice(0, i).filter(renglonConDatos);
      const despues = p.slice(i + 1).filter(renglonConDatos);
      return conVacia([...antes, ...gs.map((g) => nuevaFila(g)), ...(renglonConDatos(p[i]!) ? [p[i]!] : []), ...despues]);
    });
    avisar(`${gs.length} renglones pegados.`);
  };

  const leerArchivo = async (f: File) => {
    setLeyendo(true);
    setAviso(null);
    try {
      const r = await escanearManifiesto(f);
      const gs: GuiaManifiesto[] = r.rows
        .map((row) => ({ guia: leer(row, ALIAS_GUIA).toUpperCase().replace(/\s+/g, ''), paquetes: leer(row, ALIAS_PAQ), peso: leer(row, ALIAS_PESO), naturaleza: leer(row, ALIAS_NAT), consignatario: leer(row, ALIAS_CONS) }))
        .filter((g) => g.guia);
      setM((p) => ({
        ...p,
        vuelo: p.vuelo || r.enc.numero,
        aerolinea: p.aerolinea || r.enc.aerolinea,
        matricula: p.matricula || r.enc.matricula,
        origen: p.origen || r.enc.origen,
        destino: r.enc.destino || p.destino,
        fecha: p.fecha || fechaIso(r.enc.fecha) || p.fecha,
      }));
      agregar(gs);
      setAviso(gs.length ? `Se leyeron ${gs.length} guías. Revísalas antes de guardar.` : 'No se encontraron guías en el archivo.');
    } catch (e) {
      setAviso(mensajeDe(e));
    } finally {
      setLeyendo(false);
    }
  };

  const delVuelo = useMemo(() => prealertasDelVuelo(prealertas.map((x) => x.p), m.vuelo, m.fecha), [prealertas, m.vuelo, m.fecha]);
  const yaEnTabla = useMemo(() => new Set(filas.map((f) => normGuia(f.guia)).filter(Boolean)), [filas]);
  const faltantesPre = delVuelo.filter((p) => !yaEnTabla.has(normGuia(p.guia)));

  const util = useMemo(() => ({ ...m, guias: filas.map(({ k: _k, ...g }) => g) }), [m, filas]);
  const tot = useMemo(() => totalesManifiesto(util.guias), [util]);

  // Validaciones
  const problemas = useMemo(() => {
    const dup: string[] = [];
    const vistas = new Map<string, number>();
    const vacios: number[] = [];
    const filasMalas = new Set<number>();
    const filasAviso = new Set<number>();
    let pos = 0;
    filas.forEach((f, i) => {
      if (!renglonConDatos(f)) return;
      pos += 1;
      const k = normGuia(f.guia);
      if (!k) {
        filasMalas.add(i);
        vacios.push(-pos);
      } else if (vistas.has(k)) {
        dup.push(f.guia);
        filasMalas.add(i);
        filasMalas.add(vistas.get(k)!);
      } else vistas.set(k, i);
      if (!(N(f.paquetes) > 0) || !(N(f.peso) > 0)) {
        vacios.push(pos);
        if (!filasMalas.has(i)) filasAviso.add(i);
      }
    });
    return { dup: [...new Set(dup)], sinGuia: vacios.filter((x) => x < 0).length, vacios: vacios.filter((x) => x > 0), filasMalas, filasAviso };
  }, [filas]);

  const faltaEnc = !m.vuelo.trim() ? 'Escribe el número de vuelo.' : !m.aerolinea.trim() ? 'Elige o escribe la aerolínea.' : !m.fecha ? 'Elige la fecha.' : '';
  const bloqueaGuardar = !!faltaEnc || problemas.dup.length > 0 || problemas.sinGuia > 0;
  const sinAplicar = useMemo(() => {
    if (!esq.listo) return [] as string[];
    const out: string[] = [];
    for (const [t, cs] of Object.entries(NUEVOS)) for (const c of cs) if (!hayCampo(esq, t, c)) out.push(`${t}.${c}`);
    return out;
  }, [esq]);

  /* ───────── Guardar ───────── */
  const guardar = async () => {
    if (bloqueaGuardar || bloqueado) return;
    const malas: string[] = [];
    let id = vueloId || existenteVuelo?.id || '';
    const ok = await op.correr(async () => {
      const guias = guiasUtiles(util);
      const valores = soloExistentes(esq, 'vuelos', {
        numero_vuelo: m.vuelo.trim().toUpperCase(),
        fecha: m.fecha,
        aerolinea: m.aerolinea.trim(),
        origen: m.origen.trim().toUpperCase() || undefined,
        destino: m.destino.trim().toUpperCase() || undefined,
        matricula: m.matricula.trim().toUpperCase() || undefined,
        piezas_esperadas: tot.paquetes || undefined,
        kilos_esperados: tot.peso || undefined,
        preparado_por: m.preparado_por.trim() || undefined,
      });
      if (id) await cortex.tables.update('vuelos', id, valores);
      else {
        const f = await cortex.tables.insert('vuelos', soloExistentes(esq, 'vuelos', { ...valores, estado: 'Programado', estado_documental: 'Manifiesto cargado' }));
        id = f.id;
      }
      const ya = Object.keys(existentes).length ? existentes : Object.fromEntries((await porRelacion('prefacturacion', 'vuelo', id).catch(() => [] as SdkRow[])).map((g) => [normGuia(aGuia(g).guia), g.id]));
      const porGuia = new Map(prealertas.map((x) => [normGuia(x.p.guia), x] as const));
      for (const g of guias) {
        const k = normGuia(g.guia);
        const comunes = { piezas_esperadas: g.paquetes !== '' ? N(g.paquetes) : undefined, kilos_esperados: g.peso !== '' ? N(g.peso) : undefined, naturaleza: g.naturaleza.trim() || undefined, consignatario: g.consignatario.trim() || undefined };
        try {
          if (ya[k]) await cortex.tables.update('prefacturacion', ya[k]!, soloExistentes(esq, 'prefacturacion', comunes));
          else {
            const pre = porGuia.get(k);
            const cid = pre?.clienteId || clienteId(g.consignatario, clientes);
            await cortex.tables.insert('prefacturacion', soloExistentes(esq, 'prefacturacion', { ...comunes, guia: g.guia.trim(), vuelo: id, prealerta: pre?.p.id, cliente: cid || undefined, estado_cruce: pre ? 'Coincide' : 'Sobrante' }));
          }
        } catch (er) {
          malas.push(`${g.guia}: ${mensajeDe(er)}`);
        }
      }
      setVueloId(id);
    });
    if (!ok) return;
    if (malas.length) setAviso(`El vuelo quedó guardado, pero ${malas.length} guía(s) no se pudieron guardar (si piden cliente, complétalo en la ficha del vuelo). ${malas.slice(0, 2).join(' · ')}`);
    else avisar(existenteVuelo || vueloId ? 'Manifiesto actualizado en el vuelo.' : 'Vuelo y guías creados.');
    await onGuardado?.(id);
  };

  /* ───────── Exportar ───────── */
  const nombreBase = `Manifiesto ${m.vuelo.trim().replace(/\s+/g, '') || 'sin-vuelo'} ${m.fecha}`.trim();
  const imprimir = async () => {
    const html = htmlManifiesto(util);
    const ui = cortex.ui as { print?: (h: string, o?: { title?: string }) => Promise<void> };
    try {
      if (typeof ui.print !== 'function') throw new Error('sin impresión');
      await ui.print(html, { title: nombreBase });
    } catch {
      await cortex.ui.download(`${nombreBase}.html`, html, 'text/html').catch(() => undefined);
      avisar('Se descargó el manifiesto en HTML: ábrelo e imprímelo o guárdalo como PDF.');
    }
    const id = vueloId || existenteVuelo?.id;
    if (id && !bloqueado && hayCampo(esq, 'vuelos', 'manifiesto_impreso_en')) void cortex.tables.update('vuelos', id, { manifiesto_impreso_en: isoBogota(Date.now()) }).catch(() => undefined);
  };
  const excel = () =>
    void op.correr(async () => {
      const blob = await xlsxManifiesto(util);
      await cortex.ui.download(`${nombreBase}.xlsx`, blob, MIME_XLSX);
    });

  // Vista previa escalada
  const html = useMemo(() => htmlManifiesto(util), [util]);
  const paginas = numeroPaginas(util);

  return (
    <div className="oc-vel" onMouseDown={(e) => e.target === e.currentTarget && onCerrar()}>
      <div className="oc-hoja mf" role="dialog" aria-modal="true" aria-label="Nuevo manifiesto">
        <div className="oc-hoja-top">
          <h2>{vuelo ? `Manifiesto de ${vuelo.numero}` : 'Nuevo manifiesto'}</h2>
          <Boton chico tono="suave" onClick={onCerrar} aria-label="Cerrar" icono={<X size={18} />} />
        </div>
        <div className="oc-btns mf-solo-estrecho" style={{ marginBottom: 12 }}>
          <Boton chico tono={tab === 'datos' ? 'primario' : undefined} onClick={() => setTab('datos')}>Datos</Boton>
          <Boton chico tono={tab === 'vista' ? 'primario' : undefined} onClick={() => setTab('vista')}>Vista previa</Boton>
        </div>
        <div className="mf-cols">
          <div className={`oc-form ${tab === 'datos' ? '' : 'mf-oculta-estrecho'}`} data-mf="datos">
            {existenteVuelo && !vuelo ? <div className="oc-aviso">Ya existe el vuelo {existenteVuelo.numero} de esa fecha: al guardar se actualiza y se completan sus guías.</div> : null}
            <Campo etiqueta="Aerolínea">
              <div className="mf-aeros" role="group" aria-label="Aerolínea">
                {AEROLINEAS_MANIFIESTO.map((a) => (
                  <button key={a.clave} type="button" className="mf-aero" aria-pressed={aerolineaManifiesto(m.aerolinea)?.clave === a.clave} onClick={() => elegirAero(a.nombre)} disabled={bloqueado}>
                    <img src={a.logo} alt="" loading="lazy" referrerPolicy="no-referrer" />
                    {a.titulo}
                  </button>
                ))}
              </div>
              <input type="text" list="mf-aeros" placeholder="Otra aerolínea…" value={m.aerolinea} disabled={bloqueado} onChange={(e) => { aeroAuto.current = e.target.value.trim() === ''; set('aerolinea', e.target.value); }} style={{ marginTop: 8 }} />
              <datalist id="mf-aeros">
                {nombresAero.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </Campo>
            <div className="oc-fila2">
              <Campo etiqueta="Vuelo No" ayuda={aeroAuto.current && m.aerolinea ? `Aerolínea según el código: ${m.aerolinea}` : undefined}>
                <input type="text" value={m.vuelo} disabled={bloqueado} onChange={(e) => cambiarVuelo(e.target.value)} placeholder="Ej. LA 8044" autoCapitalize="characters" />
              </Campo>
              <Campo etiqueta="Fecha">
                <input type="date" value={m.fecha} disabled={bloqueado} onChange={(e) => set('fecha', e.target.value)} />
              </Campo>
            </div>
            <div className="oc-fila2">
              <Campo etiqueta="Matrícula, marca y nacionalidad">
                <input type="text" value={m.matricula} disabled={bloqueado} onChange={(e) => set('matricula', e.target.value.toUpperCase())} placeholder="Ej. N493MC" />
              </Campo>
              <Campo etiqueta="Preparado por">
                <input type="text" value={m.preparado_por} disabled={bloqueado} onChange={(e) => set('preparado_por', e.target.value)} />
              </Campo>
            </div>
            <div className="oc-fila2">
              <Campo etiqueta="Punto de carga (origen)">
                <input type="text" value={m.origen} disabled={bloqueado} onChange={(e) => set('origen', e.target.value.toUpperCase())} placeholder="Ej. MIA" />
              </Campo>
              <Campo etiqueta="Punto de descarga (destino)">
                <input type="text" value={m.destino} disabled={bloqueado} onChange={(e) => set('destino', e.target.value.toUpperCase())} />
              </Campo>
            </div>

            <h3>
              Guías <Chip tono="neutral">{tot.guias}</Chip>
              {tot.guias > RENGLONES_POR_PAGINA ? <Chip tono="info">{paginas} páginas</Chip> : null}
            </h3>
            {!bloqueado ? (
              <div className="oc-btns">
                <Boton chico onClick={() => setPegando((v) => !v)} icono={<ClipboardPaste size={15} />}>Pegar desde Excel</Boton>
                <Boton chico disabled={!faltantesPre.length} onClick={() => setVerPre((v) => !v)} icono={<Plus size={15} />}>
                  Agregar desde prealertas{faltantesPre.length ? ` (${faltantesPre.length})` : ''}
                </Boton>
                <SelectorArchivo etiqueta={leyendo ? 'Leyendo…' : 'Leer PDF o foto'} accept="image/*,application/pdf" disabled={leyendo} onArchivos={(f) => f[0] && void leerArchivo(f[0])} />
              </div>
            ) : null}
            {pegando ? (
              <div className="oc-form">
                <p className="oc-sub">Copia las celdas en Excel (guía, paquetes, peso, naturaleza, consignatario) y pégalas aquí. También puedes pegar directo sobre la tabla.</p>
                <textarea className="mf-pegar" value={texto} onChange={(e) => setTexto(e.target.value)} placeholder={'576-1234 5678\t12\t340.5\tAUTO PARTS\tTEAM LOGISTICS SAS'} />
                <div className="oc-btns">
                  <Boton chico tono="primario" disabled={!texto.trim()} onClick={() => { const gs = guiasDesdeTexto(texto); agregar(gs); setTexto(''); setPegando(false); avisar(`${gs.length} renglones agregados.`); }}>Agregar a la tabla</Boton>
                </div>
              </div>
            ) : null}
            {verPre && faltantesPre.length ? (
              <div className="oc-ok">
                <b>Prealertas de {m.vuelo || 'este vuelo'} que aún no están:</b>
                <ul className="mf-lista">
                  {faltantesPre.map((p) => (
                    <li key={p.id}>{p.guia} · {p.piezas} pzs · {kg(p.kilos)} · {p.cliente}</li>
                  ))}
                </ul>
                <div className="oc-btns" style={{ marginTop: 8 }}>
                  <Boton chico tono="primario" onClick={() => { agregar(faltantesPre.map((p) => ({ guia: p.guia, paquetes: p.piezas ? String(p.piezas) : '', peso: p.kilos ? String(p.kilos) : '', naturaleza: p.descripcion, consignatario: p.cliente }))); setVerPre(false); }}>Agregar las {faltantesPre.length}</Boton>
                </div>
              </div>
            ) : null}
            <div className="mf-hoja">
              <table className="mf-t">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Guía (airwaybill)</th>
                    <th>Paquetes</th>
                    <th>Peso</th>
                    <th>Naturaleza de la mercancía</th>
                    <th>Consignatario</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f, i) => (
                    <tr key={f.k} className={problemas.filasMalas.has(i) ? 'mal' : problemas.filasAviso.has(i) ? 'aviso' : ''}>
                      <td className="n">{i + 1}</td>
                      <td><input value={f.guia} disabled={bloqueado} onChange={(e) => cambiar(i, 'guia', e.target.value)} onPaste={(e) => alPegar(e, i)} aria-label={`Guía ${i + 1}`} /></td>
                      <td className="num"><input inputMode="decimal" value={f.paquetes} disabled={bloqueado} onChange={(e) => cambiar(i, 'paquetes', e.target.value)} onPaste={(e) => alPegar(e, i)} aria-label={`Paquetes ${i + 1}`} /></td>
                      <td className="num"><input inputMode="decimal" value={f.peso} disabled={bloqueado} onChange={(e) => cambiar(i, 'peso', e.target.value)} onPaste={(e) => alPegar(e, i)} aria-label={`Peso ${i + 1}`} /></td>
                      <td><input value={f.naturaleza} disabled={bloqueado} onChange={(e) => cambiar(i, 'naturaleza', e.target.value)} onPaste={(e) => alPegar(e, i)} aria-label={`Naturaleza ${i + 1}`} /></td>
                      <td><input value={f.consignatario} disabled={bloqueado} onChange={(e) => cambiar(i, 'consignatario', e.target.value)} onPaste={(e) => alPegar(e, i)} aria-label={`Consignatario ${i + 1}`} /></td>
                      <td className="n">{renglonConDatos(f) && !bloqueado ? <Boton chico tono="suave" onClick={() => quitar(i)} aria-label="Quitar renglón" icono={<Trash2 size={14} />} /> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="mf-tot" aria-live="polite">
              <div><span>Guías </span>{num(tot.guias)}</div>
              <div><span>Paquetes </span>{num(tot.paquetes)}</div>
              <div><span>Peso </span>{kg(tot.peso)}</div>
            </div>
            {problemas.dup.length ? <div className="oc-aviso"><b>Guía repetida:</b> {problemas.dup.join(', ')}. Quita una para poder guardar.</div> : null}
            {problemas.sinGuia ? <div className="oc-aviso">{problemas.sinGuia} renglón(es) tienen datos pero no número de guía.</div> : null}
            {problemas.vacios.length ? <div className="oc-aviso">Falta peso o paquetes en los renglones: {problemas.vacios.slice(0, 12).join(', ')}{problemas.vacios.length > 12 ? '…' : ''}. Se puede guardar e imprimir así.</div> : null}
            {aviso ? <div className="oc-aviso" role="status">{aviso}</div> : null}
            {sinAplicar.length ? <p className="oc-sub">Falta aplicar estos campos en los datos: {sinAplicar.join(', ')}. Mientras tanto no se guardan (el resto funciona igual).</p> : null}
            {faltaEnc ? <p className="oc-sub">{faltaEnc}</p> : null}
            {op.error ? <ErrorCaja mensaje={op.error} /> : null}
            <div className="oc-btns">
              {!bloqueado ? (
                <Boton tono="primario" disabled={op.ocupado || bloqueaGuardar} onClick={() => void guardar()} icono={<Save size={16} />}>
                  {op.ocupado ? 'Guardando…' : vueloId || existenteVuelo ? 'Guardar cambios' : 'Guardar'}
                </Boton>
              ) : null}
              <Boton onClick={() => void imprimir()} icono={<Printer size={16} />}>Imprimir / PDF</Boton>
              <Boton disabled={op.ocupado} onClick={excel} icono={<FileSpreadsheet size={16} />}>Descargar Excel</Boton>
            </div>
          </div>

          <VistaPrevia html={html} paginas={paginas} oculta={tab !== 'vista'} />
        </div>
      </div>
    </div>
  );
}

/** El mismo HTML de impresión, en un marco aislado y escalado al ancho disponible. */
function VistaPrevia({ html, paginas, oculta }: { html: string; paginas: number; oculta: boolean }) {
  const caja = useRef<HTMLDivElement | null>(null);
  const [esc, setEsc] = useState(0.6);
  const medir = useCallback(() => {
    const w = caja.current?.clientWidth ?? 0;
    if (w) setEsc(Math.min(1, w / 840));
  }, []);
  useEffect(() => {
    medir();
    const ro = typeof ResizeObserver !== 'undefined' && caja.current ? new ResizeObserver(medir) : null;
    if (ro && caja.current) ro.observe(caja.current);
    return () => ro?.disconnect();
  }, [medir, oculta]);
  const alto = paginas * (1056 + 18) + 36;
  return (
    <div data-mf="vista" className={oculta ? 'mf-oculta-estrecho' : ''}>
      <h3 style={{ margin: '0 0 8px' }}><FileText size={16} style={{ verticalAlign: -2 }} /> Vista previa <Chip tono="neutral">{paginas} {paginas === 1 ? 'página' : 'páginas'}</Chip></h3>
      <div className="mf-prev" ref={caja} style={{ height: alto * esc }}>
        <iframe title="Vista previa del manifiesto" srcDoc={html} sandbox="" style={{ width: 840, height: alto, transform: `scale(${esc})` }} />
      </div>
      <p className="oc-sub" style={{ marginTop: 6 }}><Download size={13} style={{ verticalAlign: -2 }} /> Así sale impreso o en PDF.</p>
    </div>
  );
}
