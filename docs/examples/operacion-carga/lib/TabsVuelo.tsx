import { useMemo, useRef, useState } from 'react';
import { cortex } from '@cortex/app-sdk';
import { BellRing, Check, ClipboardCopy, FileText, MessageCircle, Sparkles } from 'lucide-react';
import type { Guia, Vuelo } from './datos';
import { Adjuntos, Boton, Campo, Chip, ErrorCaja, Hoja, SelectorArchivo, Tabla, Tarjeta, avisar, confirmar, subirArchivo, useOperacion } from './ui';
import { FaltaAplicar, CuentaRegresiva, porVencimiento } from './PiezasDoc';
import { hoyBogota } from './tiempo';
import { fechaHora, hhmm, kg, num } from './formato';
import { normNombre } from './manifiesto';
import {
  CANALES_AVISO,
  ESTADOS_AVISO,
  REQUERIDO,
  TIPOS_AVISO,
  TONO_AVISO,
  TONO_CRUCE_DOC,
  TONO_TRAMITE,
  aplicarCruce,
  armarBorrador,
  asegurarTramites,
  copiar,
  enlaceWa,
  esActivo,
  faltantesDe,
  hace,
  hayCampo,
  hayTabla,
  isoBogota,
  numeroWa,
  resumenCruce,
  semaforo,
  soloExistentes,
  sugerirAvisos,
  textoPedirDocumentos,
  useAhora,
} from './documental';
import type { AvisoCliente, ClienteContacto, Esquema, FilaCruce, Plazo, Tramite } from './documental';

/**
 * Pestañas del vuelo para el documental: cruce de tres vías, trámites DIAN y avisos al cliente.
 * Cortex nunca envía nada a la DIAN ni a los clientes: arma borradores y textos, y la persona
 * los carga en MUISCA o los manda por su propio WhatsApp o correo.
 */

/* ───────────── Cruce de tres vías ───────────── */

export function CruceTresVias({
  vuelo,
  filas,
  esq,
  puede,
  onCambio,
}: {
  vuelo: Vuelo;
  filas: FilaCruce[];
  esq: Esquema;
  puede: boolean;
  onCambio: () => void | Promise<void>;
}) {
  const r = useMemo(() => resumenCruce(filas), [filas]);
  const op = useOperacion();
  const sinGuardar = vuelo.inconsistencias !== r.inconsistencias || filas.some((f) => (f.g && f.g.estadoCruce !== f.estado) || (f.pre && f.pre.estadoCruce !== f.estado));
  const total = (f: (x: FilaCruce) => number | null) => filas.reduce((a, x) => a + (f(x) ?? 0), 0);

  if (!filas.length) return <p className="oc-sub">Todavía no hay prealertas ni guías para cruzar. Carga el manifiesto o enlaza prealertas al vuelo.</p>;
  return (
    <div className="oc-form">
      <div className="oc-chips">
        <Chip tono="good">{r.coinciden} coinciden</Chip>
        <Chip tono={r.faltantes ? 'warn' : 'quiet'}>{r.faltantes} faltantes</Chip>
        <Chip tono={r.sobrantes ? 'accent' : 'quiet'}>{r.sobrantes} sobrantes</Chip>
        <Chip tono={r.diferencias ? 'bad' : 'quiet'}>{r.diferencias} con diferencia</Chip>
      </div>
      <Tabla
        columnas={[{ t: 'Guía' }, { t: 'Cliente' }, { t: 'Prealerta (kg)', n: true }, { t: 'Manifiesto (kg)', n: true }, { t: 'Recibido (kg)', n: true }, { t: 'Cruce' }]}
        pie={
          <tr>
            <td colSpan={2}>{filas.length} guías</td>
            <td className="n">{num(total((f) => f.kilosPre), 1)}</td>
            <td className="n">{num(total((f) => f.kilosMan), 1)}</td>
            <td className="n">{num(total((f) => f.kilosRec), 1)}</td>
            <td />
          </tr>
        }
      >
        {filas.map((f) => (
          <tr key={f.clave}>
            <td className="oc-mono">
              <b>{f.guia}</b>
            </td>
            <td>{f.cliente || '—'}</td>
            <td className="n">{f.kilosPre === null ? '—' : num(f.kilosPre, 1)}</td>
            <td className="n">{f.kilosMan === null ? '—' : num(f.kilosMan, 1)}</td>
            <td className="n">{f.kilosRec === null ? '—' : num(f.kilosRec, 1)}</td>
            <td>
              <Chip tono={TONO_CRUCE_DOC[f.estado] ?? 'neutral'}>{f.estado}</Chip>
              {f.notas.map((n) => (
                <div key={n} className="oc-sub">
                  {n}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </Tabla>
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      {puede ? (
        <div className="oc-btns" style={{ alignItems: 'center' }}>
          <Boton
            tono={sinGuardar ? 'primario' : undefined}
            disabled={op.ocupado}
            onClick={() =>
              void op
                .correr(async () => {
                  const x = await aplicarCruce(vuelo, filas, esq);
                  avisar(x.escritos ? `Cruce guardado (${x.escritos} cambios).` : 'El cruce ya estaba guardado.');
                })
                .then(() => onCambio())
            }
          >
            {op.ocupado ? 'Guardando…' : 'Guardar el cruce'}
          </Boton>
          <span className="oc-sub">
            {sinGuardar ? 'Hay cambios sin guardar: se actualizan el estado de cada guía, si está lista para prefacturar y las inconsistencias del vuelo.' : 'El cruce guardado coincide con lo que ves.'}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/* ───────────── Trámites DIAN ───────────── */

export function TabTramites({
  vuelo,
  tramites,
  plazos,
  filas,
  esq,
  puede,
  nombre,
  onCambio,
}: {
  vuelo: Vuelo;
  tramites: Tramite[];
  plazos: Plazo[];
  filas: FilaCruce[];
  esq: Esquema;
  puede: boolean;
  nombre: string;
  onCambio: () => void | Promise<void>;
}) {
  const ahora = useAhora(15_000);
  const op = useOperacion();
  const [fecha, setFecha] = useState(vuelo.finDescargueFecha || hoyBogota());
  const [hora, setHora] = useState(hhmm(vuelo.finDescargueHora));
  const faltan = faltantesDe(esq, { tramites_dian: REQUERIDO.tramites_dian ?? [], plazos_dian: REQUERIDO.plazos_dian ?? [] });
  const avisarDe = new Map(plazos.map((p) => [normNombre(p.tramite), p]));
  const ordenados = [...tramites].sort((a, b) => Number(esActivo(b)) - Number(esActivo(a)) || porVencimiento(a, b));
  const puedeFin = hayCampo(esq, 'vuelos', 'fin_descargue_fecha') && hayCampo(esq, 'vuelos', 'fin_descargue_hora');

  const guardarFin = async (f: string, h: string) => {
    const ok = await op.correr(async () => {
      await cortex.tables.update('vuelos', vuelo.id, { fin_descargue_fecha: f, fin_descargue_hora: h });
      const n = await asegurarTramites({ ...vuelo, finDescargueFecha: f, finDescargueHora: h }, plazos, esq);
      if (n) avisar(`${n} trámite(s) creados con sus plazos.`);
    }, 'Fin de descargue guardado.');
    if (ok) await onCambio();
  };

  return (
    <div className="oc-form">
      <div className="oc-aviso">
        <b>Cortex no envía nada a la DIAN.</b> Aquí se arma el borrador y se guarda el soporte; tú lo cargas en MUISCA y marcas el trámite como presentado con su radicado.
      </div>
      <FaltaAplicar faltan={faltan} />
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}

      {hayTabla(esq, 'tramites_dian') ? (
        <Tarjeta titulo="Fin de descargue" chico>
          <p className="oc-sub" style={{ marginBottom: 10 }}>
            Algunos plazos arrancan cuando termina el descargue. Al registrarlo se crean los trámites que faltan.
          </p>
          {!puedeFin ? (
            <p className="oc-sub">Falta aplicar los campos de fin de descargue del vuelo.</p>
          ) : (
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ maxWidth: 180 }}>
                <Campo etiqueta="Fecha">
                  <input type="date" value={fecha} disabled={!puede} onChange={(e) => setFecha(e.target.value)} />
                </Campo>
              </div>
              <div style={{ maxWidth: 140 }}>
                <Campo etiqueta="Hora (Bogotá)">
                  <input type="time" value={hora} disabled={!puede} onChange={(e) => setHora(e.target.value)} />
                </Campo>
              </div>
              {puede ? (
                <>
                  <Boton tono="primario" disabled={op.ocupado || !fecha || !hora} onClick={() => void guardarFin(fecha, hora)}>
                    Guardar
                  </Boton>
                  <Boton
                    disabled={op.ocupado}
                    onClick={() => {
                      const iso = isoBogota(Date.now());
                      const f = iso.slice(0, 10);
                      const h = iso.slice(11, 16);
                      setFecha(f);
                      setHora(h);
                      void guardarFin(f, h);
                    }}
                  >
                    Terminó ahora
                  </Boton>
                </>
              ) : null}
            </div>
          )}
        </Tarjeta>
      ) : null}

      {puede && hayTabla(esq, 'tramites_dian') ? (
        <div>
          <Boton
            chico
            disabled={op.ocupado}
            onClick={() =>
              void op
                .correr(async () => {
                  const n = await asegurarTramites(vuelo, plazos, esq);
                  avisar(n ? `${n} trámite(s) creados.` : 'No faltaba ningún trámite (o su evento todavía no ocurre).');
                })
                .then(() => onCambio())
            }
          >
            Revisar si faltan trámites
          </Boton>
        </div>
      ) : null}

      {!ordenados.length ? (
        <p className="oc-sub">Este vuelo no tiene trámites todavía. Se crean cuando el vuelo aterriza o termina el descargue.</p>
      ) : (
        ordenados.map((t) => (
          <TarjetaTramite key={t.id} t={t} plazo={avisarDe.get(normNombre(t.tramite))} vuelo={vuelo} filas={filas} ahora={ahora} plazos={plazos} esq={esq} puede={puede} nombre={nombre} onCambio={onCambio} />
        ))
      )}
    </div>
  );
}

function TarjetaTramite({
  t,
  plazo,
  vuelo,
  filas,
  ahora,
  plazos,
  esq,
  puede,
  nombre,
  onCambio,
}: {
  t: Tramite;
  plazo: Plazo | undefined;
  vuelo: Vuelo;
  filas: FilaCruce[];
  ahora: number;
  plazos: Plazo[];
  esq: Esquema;
  puede: boolean;
  nombre: string;
  onCambio: () => void | Promise<void>;
}) {
  const s = semaforo(t, ahora, plazo?.avisarHorasAntes ?? 3);
  const op = useOperacion();
  const [borrador, setBorrador] = useState(t.borrador);
  const [notas, setNotas] = useState(t.notas);
  const [armando, setArmando] = useState(false);
  const [marcando, setMarcando] = useState(false);
  const cerrado = t.estado === 'Presentado' || t.estado === 'No aplica';

  const armar = async () => {
    if (borrador.trim() && !(await confirmar('Ya hay un borrador. ¿Armar uno nuevo y reemplazarlo?', 'Reemplazar'))) return;
    setArmando(true);
    const r = await armarBorrador(vuelo, filas, t.tramite);
    setBorrador(r.texto);
    const ok = await op.correr(() => cortex.tables.update('tramites_dian', t.id, { borrador: r.texto }), r.conIa ? 'Borrador armado y guardado.' : 'Borrador armado con la plantilla (la IA no respondió).');
    setArmando(false);
    if (ok) await onCambio();
  };

  return (
    <Tarjeta
      titulo={t.tramite}
      icono={<FileText size={18} />}
      tono={s.vencido && !cerrado ? 'alerta' : s.porVencer && !cerrado ? 'aviso' : t.estado === 'Presentado' ? 'ok' : undefined}
      derecha={
        <span className="oc-chips">
          <CuentaRegresiva t={t} ahora={ahora} avisarHoras={plazo?.avisarHorasAntes} />
          <Chip tono={TONO_TRAMITE[t.estado] ?? 'neutral'}>{t.estado}</Chip>
        </span>
      }
    >
      <dl className="oc-pares">
        <dt>Desde</dt>
        <dd>{t.desdeEvento || '—'}</dd>
        <dt>Inicio</dt>
        <dd>{t.inicio ? fechaHora(t.inicio) : '—'}</dd>
        <dt>Vence</dt>
        <dd>{t.vence ? fechaHora(t.vence) : '—'}</dd>
        {t.estado === 'Presentado' ? (
          <>
            <dt>Presentado</dt>
            <dd>
              {t.presentadoEn ? fechaHora(t.presentadoEn) : '—'} · {t.presentadoPor || '—'}
            </dd>
            <dt>Radicado</dt>
            <dd className="oc-mono">{t.radicado || '—'}</dd>
          </>
        ) : null}
      </dl>
      {plazo?.descripcion ? <p className="oc-sub" style={{ marginTop: 8 }}>{plazo.descripcion}</p> : null}
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}

      <div className="oc-form" style={{ marginTop: 12 }}>
        <Campo etiqueta="Borrador para MUISCA" ayuda="Es solo un borrador: cópialo, revísalo y cárgalo tú en MUISCA. Cortex no lo envía.">
          <textarea rows={8} value={borrador} disabled={!puede} onChange={(e) => setBorrador(e.target.value)} placeholder="Aún no hay borrador. Usa «Armar borrador» para generarlo con las inconsistencias del cruce." />
        </Campo>
        <div className="oc-btns">
          {puede && !cerrado ? (
            <Boton tono="primario" disabled={armando || op.ocupado} onClick={() => void armar()} icono={<Sparkles size={16} />}>
              {armando ? 'Armando…' : 'Armar borrador'}
            </Boton>
          ) : null}
          {puede && borrador !== t.borrador ? (
            <Boton disabled={op.ocupado} onClick={() => void op.correr(() => cortex.tables.update('tramites_dian', t.id, { borrador }), 'Borrador guardado.').then((ok) => (ok ? onCambio() : undefined))}>
              Guardar cambios
            </Boton>
          ) : null}
          {borrador.trim() ? (
            <Boton
              onClick={() =>
                void copiar(borrador).then((ok) => avisar(ok ? 'Borrador copiado.' : 'No se pudo copiar: selecciona el texto y cópialo a mano.'))
              }
              icono={<ClipboardCopy size={16} />}
            >
              Copiar
            </Boton>
          ) : null}
        </div>

        <h3>Soporte</h3>
        <Adjuntos lista={t.soporte} />
        {!t.soporte.length ? <p className="oc-sub">Sin soportes. Sube aquí el acuse o el pantallazo de MUISCA.</p> : null}
        {puede ? (
          <div className="oc-btns">
            <SelectorArchivo
              etiqueta="Subir soporte"
              accept="image/*,application/pdf"
              multiple
              disabled={op.ocupado}
              onArchivos={(fs) =>
                void op
                  .correr(async () => {
                    for (const f of fs) await subirArchivo(f, { table: 'tramites_dian', id: t.id, field: 'soporte' });
                  }, 'Soporte guardado.')
                  .then((ok) => (ok ? onCambio() : undefined))
              }
            />
          </div>
        ) : null}

        {puede ? (
          <Campo etiqueta="Notas">
            <textarea rows={2} value={notas} onChange={(e) => setNotas(e.target.value)} onBlur={() => notas !== t.notas && void op.correr(() => cortex.tables.update('tramites_dian', t.id, { notas }))} />
          </Campo>
        ) : null}

        {puede && !cerrado ? (
          <div className="oc-btns">
            {t.estado === 'Pendiente' ? (
              <Boton disabled={op.ocupado} onClick={() => void op.correr(() => cortex.tables.update('tramites_dian', t.id, { estado: 'En curso' }), 'En curso.').then((ok) => (ok ? onCambio() : undefined))}>
                Marcar en curso
              </Boton>
            ) : null}
            <Boton tono="ok" disabled={op.ocupado} onClick={() => setMarcando(true)} icono={<Check size={16} />}>
              Marcar presentado
            </Boton>
          </div>
        ) : null}
      </div>

      {marcando ? (
        <Presentar
          t={t}
          nombre={nombre}
          onCerrar={() => setMarcando(false)}
          onListo={async () => {
            setMarcando(false);
            try {
              // Presentar el informe arranca el reloj de lo que depende de él (p. ej. la justificación).
              const n = await asegurarTramites(vuelo, plazos, esq);
              if (n) avisar(`${n} trámite(s) nuevos por el informe presentado.`);
            } catch {
              /* el siguiente ciclo lo reintenta al abrir el vuelo */
            }
            await onCambio();
          }}
        />
      ) : null}
    </Tarjeta>
  );
}

function Presentar({ t, nombre, onCerrar, onListo }: { t: Tramite; nombre: string; onCerrar: () => void; onListo: () => void | Promise<void> }) {
  const [radicado, setRadicado] = useState(t.radicado);
  const op = useOperacion();
  return (
    <Hoja titulo={`Presentado: ${t.tramite}`} onCerrar={onCerrar}>
      <div className="oc-form">
        <p className="oc-sub">Confirma que ya lo cargaste en MUISCA. Cortex solo deja constancia: no envía nada.</p>
        <Campo etiqueta="Número de radicado" ayuda="El que te dio MUISCA al presentar.">
          <input type="text" value={radicado} onChange={(e) => setRadicado(e.target.value)} autoFocus />
        </Campo>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        <Boton
          tono="ok"
          disabled={op.ocupado || !radicado.trim()}
          onClick={async () => {
            const ok = await op.correr(
              () => cortex.tables.update('tramites_dian', t.id, { estado: 'Presentado', numero_radicado: radicado.trim(), presentado_por: nombre || undefined, presentado_en: isoBogota(Date.now()) }),
              'Trámite marcado como presentado.',
            );
            if (ok) await onListo();
          }}
        >
          {op.ocupado ? 'Guardando…' : 'Marcar presentado'}
        </Boton>
      </div>
    </Hoja>
  );
}

/* ───────────── Avisos al cliente ───────────── */

export function TabAvisos({
  vuelo,
  filas,
  avisos,
  contactos,
  esq,
  puede,
  nombre,
  onCambio,
}: {
  vuelo: Vuelo;
  filas: FilaCruce[];
  avisos: AvisoCliente[];
  contactos: ClienteContacto[];
  esq: Esquema;
  puede: boolean;
  nombre: string;
  onCambio: () => void | Promise<void>;
}) {
  const sugerencias = useMemo(() => sugerirAvisos(filas, vuelo, contactos), [filas, vuelo, contactos]);
  const faltan = faltantesDe(esq, { avisos_cliente: REQUERIDO.avisos_cliente ?? [] });
  const ahora = useAhora(60_000);
  const op = useOperacion();

  return (
    <div className="oc-form">
      <div className="oc-aviso">
        <b>Los mensajes los envías tú.</b> Cortex arma el texto según el cruce; al abrir WhatsApp o copiarlo queda registrado el aviso.
      </div>
      <FaltaAplicar faltan={faltan} />
      {op.error ? <ErrorCaja mensaje={op.error} /> : null}
      {!sugerencias.length ? (
        <p className="oc-sub">Cuando el vuelo tenga guías con cliente, aquí aparecerá un mensaje por cliente.</p>
      ) : (
        sugerencias.map((s) => (
          <AvisoPorCliente
            key={s.clienteId || s.cliente}
            s={s}
            vuelo={vuelo}
            contacto={contactos.find((c) => c.id === s.clienteId) ?? contactos.find((c) => normNombre(c.nombre) === normNombre(s.cliente))}
            previos={avisos.filter((a) => (s.clienteId ? a.clienteId === s.clienteId : normNombre(a.cliente) === normNombre(s.cliente)))}
            esq={esq}
            puede={puede}
            nombre={nombre}
            onCambio={onCambio}
          />
        ))
      )}

      {avisos.length ? (
        <>
          <h3>Avisos registrados</h3>
          <ul className="oc-lista">
            {avisos.map((a) => (
              <li key={a.id} className="oc-item">
                <div className="oc-item-top">
                  <span>
                    <b>{a.cliente || 'Cliente'}</b> <span className="oc-sub">· {a.tipo} · {a.canal}</span>
                  </span>
                  <Chip tono={TONO_AVISO[a.estado] ?? 'neutral'}>{a.estado}</Chip>
                </div>
                <p className="oc-sub" style={{ whiteSpace: 'pre-wrap' }}>{a.mensaje}</p>
                <div className="oc-meta">
                  {a.enviadoPor ? <span>Por {a.enviadoPor}</span> : null}
                  {a.enviadoEn ? <span>{fechaHora(a.enviadoEn)} · {hace(a.enviadoEn, ahora)}</span> : null}
                </div>
                {puede ? (
                  <div className="oc-btns">
                    {ESTADOS_AVISO.filter((e) => e !== a.estado).map((e) => (
                      <Boton
                        key={e}
                        chico
                        disabled={op.ocupado}
                        onClick={() =>
                          void op
                            .correr(
                              () =>
                                cortex.tables.update('avisos_cliente', a.id, {
                                  estado: e,
                                  ...(e === 'Enviado' && !a.enviadoEn ? { enviado_por: nombre || undefined, enviado_en: isoBogota(Date.now()) } : {}),
                                }),
                              `Aviso: ${e}.`,
                            )
                            .then((ok) => (ok ? onCambio() : undefined))
                        }
                      >
                        Marcar {e.toLowerCase()}
                      </Boton>
                    ))}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

function AvisoPorCliente({
  s,
  vuelo,
  contacto,
  previos,
  esq,
  puede,
  nombre,
  onCambio,
}: {
  s: ReturnType<typeof sugerirAvisos>[number];
  vuelo: Vuelo;
  contacto: ClienteContacto | undefined;
  previos: AvisoCliente[];
  esq: Esquema;
  puede: boolean;
  nombre: string;
  onCambio: () => void | Promise<void>;
}) {
  const [mensaje, setMensaje] = useState(s.mensaje);
  const [tipo, setTipo] = useState<string>(s.tipo);
  const [canal, setCanal] = useState<string>('Correo');
  const [enlace, setEnlace] = useState(previos.find((p) => p.enlace)?.enlace ?? '');
  const [whatsapp, setWhatsapp] = useState(contacto?.whatsapp ?? '');
  const op = useOperacion();
  const registrado = useRef<string>('');
  const numero = numeroWa(whatsapp);
  const tablaOk = hayTabla(esq, 'avisos_cliente');
  const conProblema = s.guias.filter((g) => g.estado !== 'Coincide');

  /** Registra (o actualiza) el aviso de este cliente. */
  const registrar = async (canalUso: string, estado: 'Por enviar' | 'Enviado', texto = mensaje, tipoUso = tipo) => {
    if (!tablaOk) return;
    const valores = soloExistentes(esq, 'avisos_cliente', {
      vuelo: vuelo.id,
      guia: s.guias.length === 1 ? s.guias[0]?.g?.id : undefined,
      cliente: s.clienteId || undefined,
      tipo: tipoUso,
      canal: canalUso,
      mensaje: texto,
      estado,
      enviado_por: estado === 'Enviado' ? nombre || undefined : undefined,
      enviado_en: estado === 'Enviado' ? isoBogota(Date.now()) : undefined,
      enlace_documentos: enlace.trim() || undefined,
    });
    if (registrado.current) await cortex.tables.update('avisos_cliente', registrado.current, valores);
    else registrado.current = (await cortex.tables.insert('avisos_cliente', valores)).id;
    await onCambio();
  };

  const guardarWhatsapp = async () => {
    if (!contacto || whatsapp.trim() === contacto.whatsapp || !hayCampo(esq, 'clientes_facturacion', 'whatsapp')) return;
    await op.correr(() => cortex.tables.update('clientes_facturacion', contacto.id, { whatsapp: whatsapp.trim() }), 'WhatsApp del cliente guardado.');
  };

  const pedirDocs = async () => {
    const texto = textoPedirDocumentos(s.cliente, vuelo, (conProblema.length ? conProblema : s.guias).map((g) => g.guia), enlace.trim());
    const ok = await copiar(texto);
    avisar(ok ? 'Texto copiado: pégalo en tu mensaje.' : 'No se pudo copiar. Selecciona el texto del mensaje.');
    if (!ok) setMensaje(texto);
    await op.correr(() => registrar('WhatsApp', 'Por enviar', texto, 'Documento faltante'));
  };

  return (
    <Tarjeta
      titulo={s.cliente}
      icono={<BellRing size={18} />}
      tono={s.tipo === 'Llegada' ? undefined : 'aviso'}
      derecha={<Chip tono={s.tipo === 'Llegada' ? 'good' : 'warn'}>{s.tipo}</Chip>}
    >
      <p className="oc-sub" style={{ marginBottom: 8 }}>
        {s.guias.length} guía(s): {s.guias.map((g) => g.guia).join(', ')} · {kg(s.guias.reduce((a, g) => a + (g.kilosRec ?? g.kilosMan ?? 0), 0))}
      </p>
      <div className="oc-form">
        <div className="oc-fila2">
          <Campo etiqueta="Tipo de aviso">
            <select value={tipo} disabled={!puede} onChange={(e) => setTipo(e.target.value)}>
              {TIPOS_AVISO.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </Campo>
          <Campo etiqueta="Canal al copiar">
            <select value={canal} disabled={!puede} onChange={(e) => setCanal(e.target.value)}>
              {CANALES_AVISO.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Campo>
        </div>
        <Campo etiqueta="WhatsApp del cliente" ayuda={numero ? `Se abrirá el chat con +${numero}.` : 'Escribe el número con indicativo (ej. 3001234567 o 573001234567).'}>
          <input type="tel" value={whatsapp} disabled={!puede} onChange={(e) => setWhatsapp(e.target.value)} onBlur={() => void guardarWhatsapp()} placeholder="300 123 4567" />
        </Campo>
        <Campo etiqueta="Mensaje" ayuda="Puedes editarlo antes de enviarlo.">
          <textarea rows={7} value={mensaje} disabled={!puede} onChange={(e) => setMensaje(e.target.value)} />
        </Campo>
        <Campo etiqueta="Enlace para que el cliente suba documentos (opcional)" ayuda="Por ahora se guarda el enlace en el aviso y se incluye en el texto que pide los documentos.">
          <input type="url" value={enlace} disabled={!puede} onChange={(e) => setEnlace(e.target.value)} placeholder="https://…" />
        </Campo>
        {op.error ? <ErrorCaja mensaje={op.error} /> : null}
        {puede ? (
          <div className="oc-btns">
            {numero ? (
              <a
                className="oc-btn ok"
                href={enlaceWa(numero, mensaje)}
                target="_blank"
                rel="noreferrer"
                onClick={() => void op.correr(() => registrar('WhatsApp', 'Enviado'))}
              >
                <MessageCircle size={18} /> Abrir WhatsApp
              </a>
            ) : null}
            <Boton
              onClick={async () => {
                const ok = await copiar(mensaje);
                avisar(ok ? 'Mensaje copiado. Cuando lo envíes, márcalo como enviado.' : 'No se pudo copiar: selecciona el texto y cópialo a mano.');
                await op.correr(() => registrar(canal, 'Por enviar'));
              }}
              icono={<ClipboardCopy size={16} />}
            >
              Copiar mensaje
            </Boton>
            <Boton onClick={() => void pedirDocs()} icono={<FileText size={16} />}>
              Copiar pedido de documentos
            </Boton>
          </div>
        ) : null}
        {previos.length ? <p className="oc-sub">Ya hay {previos.length} aviso(s) registrado(s) a este cliente en este vuelo.</p> : null}
      </div>
    </Tarjeta>
  );
}

export type { Guia };
