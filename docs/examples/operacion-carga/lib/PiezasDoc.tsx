import type { ReactNode } from 'react';
import { DatabaseZap } from 'lucide-react';
import type { Tono } from './estados';
import { Chip } from './ui';
import { duracion, esActivo, semaforo } from './documental';
import type { Tramite } from './documental';

/** Piezas del documental: aviso de datos sin aplicar, cuenta regresiva y pestañas. */

/** «Falta aplicar datos»: la pantalla sigue funcionando con lo que sí existe. */
export function FaltaAplicar({ faltan, children }: { faltan: string[]; children?: ReactNode }) {
  if (!faltan.length) return null;
  return (
    <div className="oc-aviso" role="status" style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 14 }}>
      <DatabaseZap size={20} style={{ flex: '0 0 auto', marginTop: 2 }} />
      <div>
        <b>Falta aplicar datos.</b> Esta parte necesita tablas o campos nuevos que todavía no existen: {faltan.join(' · ')}.
        <div className="oc-sub" style={{ marginTop: 4 }}>{children ?? 'Pídele al administrador que corra el script de datos del documental. Mientras tanto, lo demás funciona normal.'}</div>
      </div>
    </div>
  );
}

/** Chip con la cuenta regresiva (o el estado) de un trámite. */
export function CuentaRegresiva({ t, ahora, avisarHoras }: { t: Tramite; ahora: number; avisarHoras?: number }) {
  const s = semaforo(t, ahora, avisarHoras);
  const tono: Tono = s.tono;
  return (
    <Chip tono={tono} vivo={esActivo(t) && !s.vencido}>
      {s.texto}
    </Chip>
  );
}

/** Para ordenar: lo vencido primero, luego lo que vence antes. */
export const porVencimiento = (a: Tramite, b: Tramite): number => (a.venceMs ?? Infinity) - (b.venceMs ?? Infinity);

export function Pestañas<T extends string>({
  valor,
  opciones,
  onChange,
}: {
  valor: T;
  opciones: { id: T; texto: string; cuenta?: number; alerta?: boolean }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="oc-seg" role="tablist" style={{ maxWidth: '100%', overflowX: 'auto' }}>
      {opciones.map((o) => (
        <button key={o.id} type="button" role="tab" aria-selected={valor === o.id} aria-pressed={valor === o.id} onClick={() => onChange(o.id)}>
          {o.texto}
          {o.cuenta ? (
            <span className={`oc-chip ${o.alerta ? 'bad' : 'neutral'}`} style={{ marginLeft: 6, padding: '0 8px', minHeight: 0 }}>
              {o.cuenta}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

export { duracion };
