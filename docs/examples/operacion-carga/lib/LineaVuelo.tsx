import { CheckCircle2, ClipboardCheck, Hand, Plane, ShieldAlert, Wrench } from 'lucide-react';
import type { Atencion, Evento, Vuelo } from './datos';
import type { Tono } from './estados';
import { hhmm } from './formato';

/** Línea de tiempo vertical del vuelo: quién, qué y cuándo, con lo crítico a la vista. */
interface Paso {
  h: string;
  titulo: string;
  quien?: string;
  detalle?: string;
  t: Tono;
  icono: React.ReactNode;
}

export function LineaVuelo({ v, atenciones, eventos }: { v: Vuelo; atenciones: Atencion[]; eventos: Evento[] }) {
  const pasos: Paso[] = [];
  if (v.llegadaHora) pasos.push({ h: hhmm(v.llegadaHora), titulo: 'Aterrizó', quien: v.posicion ? `Posición ${v.posicion}` : undefined, t: 'accent', icono: <Plane size={14} /> });
  if (v.tomadoHora) {
    const fuera = v.fueraZonaToma === 'Sí';
    pasos.push({ h: hhmm(v.tomadoHora), titulo: 'Tomado', quien: v.atendidoPor || 'Un operario', detalle: v.minToma !== null ? `${v.minToma} min después de aterrizar${fuera ? ' · fuera de zona' : ''}` : fuera ? 'Fuera de zona' : undefined, t: fuera ? 'bad' : 'info', icono: <Hand size={14} /> });
  }
  for (const e of eventos) {
    if (!e.hora) continue;
    pasos.push({ h: hhmm(e.hora), titulo: e.tipo, quien: e.operario || undefined, detalle: e.descripcion || undefined, t: e.critico ? 'bad' : 'warn', icono: e.critico ? <ShieldAlert size={14} /> : <Wrench size={14} /> });
  }
  for (const a of atenciones) {
    if (a.horaFin) pasos.push({ h: hhmm(a.horaFin), titulo: 'Fin de la atención', quien: a.operario, detalle: a.difKilos === null ? undefined : `Diferencia de kilos ${a.difKilos > 0 ? '+' : ''}${a.difKilos}`, t: 'good', icono: <ClipboardCheck size={14} /> });
  }
  if (v.cierreHora) pasos.push({ h: hhmm(v.cierreHora), titulo: 'Recibido', t: 'good', icono: <CheckCircle2 size={14} /> });
  pasos.sort((a, b) => a.h.localeCompare(b.h));
  if (!pasos.length) return <p className="oc-sub">Aún no hay movimientos. Se irán llenando cuando el vuelo aterrice y lo tomen.</p>;
  return (
    <ol className="oc-hist">
      {pasos.map((p, i) => (
        <li key={`${p.h}-${i}`} className={p.t}>
          <span className="hr">{p.h}</span>
          <span className="pt" aria-hidden="true" />
          <span className="tx">
            <b>{p.titulo}</b>
            {p.quien ? <small>{p.quien}</small> : null}
            {p.detalle ? <p>{p.detalle}</p> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
