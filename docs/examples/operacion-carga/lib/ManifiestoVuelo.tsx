import { useEffect, useMemo, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { FileScan, Plane } from 'lucide-react';
import { MAX_ESCANEO, reducirImagen } from './archivos';
import { T, aGuia, aPrealerta, porRelacion, traerTodo } from './datos';
import type { Guia, Prealerta, Vuelo } from './datos';
import { ENCABEZADO_VACIO, leerEncabezado, planRelleno } from './encabezado';
import type { Encabezado } from './encabezado';
import { hayCampo, soloExistentes } from './documental';
import type { Esquema } from './documental';
import { N, kg, num } from './formato';
import { evaluar, normVuelo, renglonesDe } from './manifiesto';
import type { Renglon } from './manifiesto';
import { Boton, Campo, Chip, ErrorCaja, Hoja, SelectorArchivo, Tabla, avisar, confirmar, mensajeDe, useOperacion } from './ui';

/**
 * Del manifiesto al vuelo: «Nuevo vuelo desde manifiesto» (crea el vuelo con TODO su encabezado,
 * sus guías y guarda el archivo) y «Rellenar el vuelo» (lo vacío se llena solo; lo que ya
 * tenía algo distinto se pregunta antes de pisarlo).
 */

/** Dónde se guarda el archivo del manifiesto (el campo nuevo si existe; si no, los documentos). */
export const campoManifiesto = (esq: Esquema): string => (hayCampo(esq, 'vuelos', 'manifiesto_archivo') ? 'manifiesto_archivo' : 'documentos');

/** Foto o PDF → encabezado y renglones leídos. */
export async function escanearManifiesto(f: File): Promise<{ archivo: File; enc: Encabezado; rows: Record<string, string | number>[] }> {
  const listo = await reducirImagen(f);
  if (listo.size > MAX_ESCANEO) throw new Error('El archivo pesa más de 4 MB. Toma la foto de nuevo (más cerca, con buena luz) o comprime el PDF.');
  const r = await cortex.docs.scan(listo, { kind: 'manifiesto', rows: true });
  return { archivo: listo, enc: leerEncabezado(r.fields, r.rows), rows: r.rows };
}

/* ───────────── Rellenar un vuelo que ya existe ───────────── */

export function RellenarVuelo({
  vuelo,
  enc,
  esq,
  archivo,
  onCerrar,
  onListo,
}: {
  vuelo: Vuelo;
  enc: Encabezado;
  esq: Esquema;
  /** Si viene, también se guarda como archivo del manifiesto. */
  archivo?: File | null;
  onCerrar: () => void;
  onListo: () => void | Promise<void>;
}) {
  const plan = useMemo(() => planRelleno(vuelo, enc, esq), [vuelo, enc, esq]);
  const [pisar, setPisar] = useState<Set<string>>(new Set());
  const op = useOperacion();
  const nada = !Object.keys(plan.vacios).length && !plan.conflictos.length;

  const aplicar = async () => {
    const piso = plan.conflictos.filter((c) => pisar.has(c.campo));
    if (piso.length && !(await confirmar(`Se reemplazará lo escrito en: ${piso.map((c) => c.etiqueta).join(', ')}.`, 'Reemplazar', true))) return;
    const valores: Record<string, unknown> = { ...plan.vacios };
    for (const c of piso) valores[c.campo] = c.valor;
    const ok = await op.correr(async () => {
      if (Object.keys(valores).length) await cortex.tables.update('vuelos', vuelo.id, valores);
      if (archivo) await cortex.files.upload(archivo, { table: 'vuelos', id: vuelo.id, field: campoManifiesto(esq), name: archivo.name });
    }, 'Vuelo actualizado con el manifiesto.');
    if (ok) await onListo();
  };

  return (
    <Hoja titulo={`Manifiesto de ${vuelo.numero}`} onCerrar={onCerrar}>
      <div className="oc-form">
        {nada ? <div className="oc-ok">El manifiesto no trae datos nuevos para el encabezado del vuelo.</div> : null}
        {plan.etiquetasVacios.length ? (
          <div className="oc-ok">
            <b>Se llenará lo que estaba vacío:</b> {plan.etiquetasVacios.join(', ')}.
          </div>
        ) : null}
        {plan.conflictos.length ? (
          <div className="oc-aviso">
            <b>Esto ya tenía algo distinto.</b> Marca lo que quieres reemplazar; lo demás se queda como está.
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {plan.conflictos.map((c) => (
                <li key={c.campo}>
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      style={{ width: 22, height: 22, minHeight: 0, minWidth: 0 }}
                      checked={pisar.has(c.campo)}
                      onChange={(e) =>
                        setPisar((p) => {
                          const n = new Set(p);
                          if (e.target.checked) n.add(c.campo);
                          else n.delete(c.campo);
                          return n;
                        })
                      }
                    />
                    <span>
                      <b>{c.etiqueta}</b>: «{c.actual}» → «{c.nuevo}»
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {archivo ? <p className="oc-sub">El archivo «{archivo.name}» también se guarda en el vuelo.</p> : null}
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton tono="primario" disabled={op.ocupado || (nada && !archivo)} onClick={() => void aplicar()}>
          {op.ocupado ? 'Guardando…' : 'Aplicar al vuelo'}
        </Boton>
      </div>
    </Hoja>
  );
}

/* ───────────── Nuevo vuelo desde manifiesto ───────────── */

type Fase = 'inicio' | 'leyendo' | 'revision' | 'guardando';

interface Ctx {
  prealertas: Prealerta[];
  clientes: { id: string; label: string }[];
}

export function NuevoDesdeManifiesto({
  vuelos,
  esq,
  onCerrar,
  onListo,
}: {
  vuelos: Vuelo[];
  esq: Esquema;
  onCerrar: () => void;
  onListo: (vueloId: string) => void | Promise<void>;
}) {
  const [fase, setFase] = useState<Fase>('inicio');
  const [error, setError] = useState<string | null>(null);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [enc, setEnc] = useState<Encabezado>(ENCABEZADO_VACIO);
  const [renglones, setRenglones] = useState<Renglon[]>([]);
  const [ctx, setCtx] = useState<Ctx>({ prealertas: [], clientes: [] });
  const [modo, setModo] = useState<'actualizar' | 'nuevo'>('actualizar');
  const [pisar, setPisar] = useState<Set<string>>(new Set());
  const [yaGuias, setYaGuias] = useState<Guia[]>([]);
  const [progreso, setProgreso] = useState('');
  const op = useOperacion();

  useEffect(() => {
    void (async () => {
      const [pre, cli] = await Promise.all([
        traerTodo('prealertas', { order: { field: 'created_at', dir: 'desc' } }, 1000).catch(() => []),
        traerTodo('clientes_facturacion', {}, 1500).catch(() => []),
      ]);
      setCtx({ prealertas: pre.map(aPrealerta), clientes: cli.map((r) => ({ id: r.id, label: T(r.values.nombre) || T(r.values.razon_social) || r.label })) });
    })();
  }, []);

  const existente = useMemo(() => {
    const n = normVuelo(enc.numero);
    return n && enc.fecha ? (vuelos.find((v) => normVuelo(v.numero) === n && v.fecha === enc.fecha) ?? null) : null;
  }, [vuelos, enc.numero, enc.fecha]);

  useEffect(() => {
    if (!existente) {
      setYaGuias([]);
      return;
    }
    let vivo = true;
    void porRelacion('prefacturacion', 'vuelo', existente.id)
      .then((r) => vivo && setYaGuias(r.map(aGuia)))
      .catch(() => undefined);
    return () => {
      vivo = false;
    };
  }, [existente]);

  const usaExistente = !!existente && modo === 'actualizar';
  const plan = useMemo(() => (existente && usaExistente ? planRelleno(existente, enc, esq) : null), [existente, usaExistente, enc, esq]);
  const cruces = useMemo(() => evaluar(renglones, { prealertas: ctx.prealertas, existentes: usaExistente ? yaGuias : [], clientes: ctx.clientes }), [renglones, ctx, usaExistente, yaGuias]);

  const leer = async (f: File) => {
    setError(null);
    setFase('leyendo');
    try {
      const r = await escanearManifiesto(f);
      setArchivo(r.archivo);
      setEnc(r.enc);
      setRenglones(renglonesDe(r.rows, { prealertas: ctx.prealertas, existentes: [], clientes: ctx.clientes }));
      setFase('revision');
    } catch (e) {
      setError(mensajeDe(e));
      setFase('inicio');
    }
  };

  const e = (k: keyof Encabezado) => (v: string) => setEnc((p) => ({ ...p, [k]: v }));
  const cambiar = (k: string, c: Partial<Renglon>) => setRenglones((p) => p.map((r) => (r.k === k ? { ...r, ...c } : r)));
  const elegidos = renglones.map((r, i) => ({ r, c: cruces[i] })).filter((x) => x.r.incluir && x.c && x.c.estado !== 'ya_esta' && x.c.estado !== 'repetida');
  const sinCliente = elegidos.filter((x) => x.r.guia.trim() && !x.c?.clienteId).length;
  const falta = !enc.numero.trim() ? 'Falta el número de vuelo.' : !enc.fecha ? 'Falta la fecha del vuelo.' : sinCliente ? `Faltan clientes de la lista en ${sinCliente} guía(s).` : '';

  const crear = async () => {
    const malas: string[] = [];
    let vueloId = existente?.id ?? '';
    const ok = await op.correr(async () => {
      if (!usaExistente) {
        setProgreso('Creando el vuelo…');
        const fila = await cortex.tables.insert(
          'vuelos',
          soloExistentes(esq, 'vuelos', {
            numero_vuelo: enc.numero.trim().toUpperCase(),
            fecha: enc.fecha,
            aerolinea: enc.aerolinea.trim() || undefined,
            origen: enc.origen.trim() || undefined,
            destino: enc.destino.trim() || undefined,
            matricula: enc.matricula.trim() || undefined,
            manifiesto_numero: enc.manifiesto.trim() || undefined,
            kilos_esperados: enc.kilos ? N(enc.kilos) : undefined,
            piezas_esperadas: enc.piezas ? N(enc.piezas) : undefined,
            estado: 'Programado',
            estado_documental: 'Manifiesto cargado',
          }),
        );
        vueloId = fila.id;
      } else if (existente && plan) {
        const valores: Record<string, unknown> = { ...plan.vacios };
        for (const c of plan.conflictos) if (pisar.has(c.campo)) valores[c.campo] = c.valor;
        if (Object.keys(valores).length) await cortex.tables.update('vuelos', existente.id, valores);
      }
      let i = 0;
      for (const { r, c } of elegidos) {
        i += 1;
        setProgreso(`Creando guía ${i} de ${elegidos.length}…`);
        try {
          await cortex.tables.insert(
            'prefacturacion',
            soloExistentes(esq, 'prefacturacion', {
              guia: r.guia.trim(),
              cliente: c?.clienteId,
              vuelo: vueloId,
              prealerta: c?.prealerta?.id,
              tipo_guia: r.tipo || undefined,
              guia_madre: r.madre.trim() || undefined,
              piezas_esperadas: r.piezas ? N(r.piezas) : undefined,
              kilos_esperados: r.kilos ? N(r.kilos) : undefined,
              pallets_esperados: r.pallets ? N(r.pallets) : undefined,
              estado_cruce: c?.estado === 'diferencia' ? 'Diferencia' : c?.prealerta ? 'Coincide' : 'Sobrante',
            }),
          );
        } catch (er) {
          malas.push(`${r.guia}: ${mensajeDe(er)}`);
        }
      }
      if (archivo) {
        setProgreso('Guardando el archivo del manifiesto…');
        try {
          await cortex.files.upload(archivo, { table: 'vuelos', id: vueloId, field: campoManifiesto(esq), name: archivo.name });
        } catch (er) {
          malas.push(`Archivo: ${mensajeDe(er)}`);
        }
      }
    });
    if (!ok) return;
    avisar(`${usaExistente ? 'Vuelo actualizado' : 'Vuelo creado'}${elegidos.length ? ` con ${elegidos.length} guías` : ''}.`);
    if (malas.length) {
      setError(`El vuelo quedó listo, pero esto no se pudo crear: ${malas.join(' · ')}`);
      setFase('revision');
    }
    await onListo(vueloId);
  };

  const campoEnc = (k: keyof Encabezado, etiqueta: string, tipo = 'text', extra?: { ayuda?: string }) => (
    <Campo etiqueta={etiqueta} ayuda={extra?.ayuda}>
      <input type={tipo} value={enc[k]} onChange={(ev) => e(k)(k === 'numero' || k === 'matricula' ? ev.target.value.toUpperCase() : ev.target.value)} inputMode={k === 'piezas' || k === 'kilos' ? 'decimal' : undefined} />
    </Campo>
  );

  return (
    <Hoja titulo="Nuevo vuelo desde manifiesto" onCerrar={onCerrar}>
      {fase === 'inicio' || fase === 'leyendo' ? (
        <div className="oc-form">
          <p className="oc-sub">Fotografía el manifiesto o sube el PDF (hasta 4 MB). Se lee el encabezado y las guías; tú revisas todo antes de crear nada.</p>
          {error ? <ErrorCaja mensaje={error} /> : null}
          <div className="oc-btns">
            <SelectorArchivo etiqueta="Fotografiar manifiesto" camara="environment" tono="primario" disabled={fase === 'leyendo'} onArchivos={(f) => f[0] && void leer(f[0])} />
            <SelectorArchivo etiqueta="Subir foto o PDF" accept="image/*,application/pdf" disabled={fase === 'leyendo'} onArchivos={(f) => f[0] && void leer(f[0])} />
          </div>
          {fase === 'leyendo' ? (
            <>
              <div className="oc-escaner" aria-hidden="true" />
              <div className="oc-aviso" role="status">
                <FileScan size={16} style={{ verticalAlign: -3 }} /> Leyendo el manifiesto… puede tardar unos segundos.
              </div>
            </>
          ) : null}
        </div>
      ) : (
        <div className="oc-form">
          {error ? <ErrorCaja mensaje={error} /> : null}
          {existente ? (
            <div className="oc-aviso">
              <b>
                <Plane size={15} style={{ verticalAlign: -2 }} /> Ya existe el vuelo {existente.numero} de esa fecha.
              </b>
              <div className="oc-btns" style={{ marginTop: 8 }}>
                <Boton chico tono={modo === 'actualizar' ? 'primario' : undefined} onClick={() => setModo('actualizar')}>
                  Actualizar el existente
                </Boton>
                <Boton chico tono={modo === 'nuevo' ? 'primario' : undefined} onClick={() => setModo('nuevo')}>
                  Crear otro
                </Boton>
              </div>
              {usaExistente && plan ? (
                <div style={{ marginTop: 10 }}>
                  {plan.etiquetasVacios.length ? <p>Se llenará lo vacío: {plan.etiquetasVacios.join(', ')}.</p> : <p>No hay campos vacíos por llenar.</p>}
                  {plan.conflictos.map((c) => (
                    <label key={c.campo} style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 6 }}>
                      <input
                        type="checkbox"
                        style={{ width: 22, height: 22, minHeight: 0, minWidth: 0 }}
                        checked={pisar.has(c.campo)}
                        onChange={(ev) =>
                          setPisar((p) => {
                            const n = new Set(p);
                            if (ev.target.checked) n.add(c.campo);
                            else n.delete(c.campo);
                            return n;
                          })
                        }
                      />
                      <span>
                        Reemplazar <b>{c.etiqueta}</b>: «{c.actual}» → «{c.nuevo}»
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          <h3>Encabezado leído</h3>
          <div className="oc-fila2">
            {campoEnc('numero', 'Número de vuelo')}
            {campoEnc('fecha', 'Fecha', 'date')}
          </div>
          <div className="oc-fila2">
            {campoEnc('aerolinea', 'Aerolínea')}
            {campoEnc('matricula', 'Matrícula')}
          </div>
          <div className="oc-fila2">
            {campoEnc('origen', 'Origen')}
            {campoEnc('destino', 'Destino')}
          </div>
          <div className="oc-fila3">
            {campoEnc('manifiesto', 'N.º de manifiesto')}
            {campoEnc('piezas', 'Piezas')}
            {campoEnc('kilos', 'Kilos')}
          </div>

          <h3>
            Guías leídas <Chip tono="neutral">{renglones.length}</Chip>
          </h3>
          {!renglones.length ? (
            <p className="oc-sub">No se encontraron guías. Puedes crear el vuelo igual y cargar las guías después desde el vuelo.</p>
          ) : (
            <Tabla
              columnas={[{ t: 'Crear' }, { t: 'Cruce' }, { t: 'Guía' }, { t: 'Cliente' }, { t: 'Piezas', n: true }, { t: 'Kilos', n: true }]}
              pie={
                <tr>
                  <td colSpan={4}>{elegidos.length} guías a crear</td>
                  <td className="n" colSpan={2}>
                    {kg(elegidos.reduce((a, x) => a + N(x.r.kilos), 0))}
                  </td>
                </tr>
              }
            >
              {renglones.map((r, i) => {
                const c = cruces[i];
                const marca = c?.estado === 'coincide' ? 'Coincide' : c?.estado === 'diferencia' ? 'Difiere' : c?.estado === 'sobrante' ? 'Sobrante' : c?.estado === 'repetida' ? 'Repetida' : 'Ya cargada';
                return (
                  <tr key={r.k} className={r.incluir ? '' : 'sin'}>
                    <td>
                      <input type="checkbox" checked={r.incluir} onChange={(ev) => cambiar(r.k, { incluir: ev.target.checked })} aria-label="Crear esta guía" style={{ width: 22, height: 22, minHeight: 0, minWidth: 0 }} />
                    </td>
                    <td title={c?.nota}>
                      <Chip tono={c?.estado === 'coincide' ? 'good' : c?.estado === 'diferencia' ? 'warn' : c?.estado === 'sobrante' ? 'accent' : 'bad'}>{marca}</Chip>
                    </td>
                    <td>
                      <input type="text" value={r.guia} onChange={(ev) => cambiar(r.k, { guia: ev.target.value.toUpperCase() })} aria-label="Guía" style={{ minWidth: 140 }} />
                    </td>
                    <td>
                      <input type="text" list="oc-clientes-nv" value={r.cliente} onChange={(ev) => cambiar(r.k, { cliente: ev.target.value })} aria-label="Cliente" style={{ minWidth: 160 }} />
                      {r.incluir && r.guia && c && !c.clienteId ? <div style={{ color: 'var(--malo)', fontSize: 13 }}>Elige un cliente de la lista</div> : null}
                    </td>
                    <td className="n">
                      <input type="text" inputMode="decimal" value={r.piezas} onChange={(ev) => cambiar(r.k, { piezas: ev.target.value })} aria-label="Piezas" style={{ minWidth: 70, textAlign: 'right' }} />
                    </td>
                    <td className="n">
                      <input type="text" inputMode="decimal" value={r.kilos} onChange={(ev) => cambiar(r.k, { kilos: ev.target.value })} aria-label="Kilos" style={{ minWidth: 90, textAlign: 'right' }} />
                    </td>
                  </tr>
                );
              })}
            </Tabla>
          )}
          <datalist id="oc-clientes-nv">
            {ctx.clientes.map((c) => (
              <option key={c.id} value={c.label} />
            ))}
          </datalist>
          {renglones.length ? <p className="oc-sub">{num(renglones.length)} guías leídas · se cruzan por número con las prealertas.</p> : null}
          {falta ? <p className="oc-sub">{falta}</p> : null}
          {op.error ? <ErrorCaja mensaje={op.error} /> : null}
          <div className="oc-btns">
            <Boton tono="primario" disabled={op.ocupado || !!falta} onClick={() => void crear()}>
              {op.ocupado ? progreso || 'Guardando…' : usaExistente ? 'Actualizar vuelo y crear guías' : `Crear vuelo${elegidos.length ? ` y ${elegidos.length} guías` : ''}`}
            </Boton>
            <Boton tono="suave" disabled={op.ocupado} onClick={() => { setFase('inicio'); setRenglones([]); setArchivo(null); setEnc(ENCABEZADO_VACIO); }}>
              Empezar de nuevo
            </Boton>
          </div>
        </div>
      )}
    </Hoja>
  );
}

