import { Check, Lock } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Pantallas de muestra para «Lo que resuelve». Son dibujos de la interfaz, no
 * capturas de una empresa real: cada una se anuncia como «Ejemplo» en pantalla
 * y como «Ejemplo ilustrativo» al lector de pantalla, y sus empresas son
 * inventadas. Se pintan en el servidor; no hidratan nada.
 */

function Mock({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <div className="pain-mock" role="img" aria-label={`Ejemplo ilustrativo: ${label}`}>
      <div className="pain-mock__bar">
        <span>{title}</span>
        <em>Ejemplo</em>
      </div>
      {children}
    </div>
  );
}

function CarteraMock() {
  const rows = [
    ['Nexa Logística', '34 días', '$8,4 M', 'Recordatorio listo'],
    ['Ferretería El Puente', '61 días', '$3,1 M', 'Escalar'],
    ['Agroandina', 'Vence hoy', '$5,0 M', 'Aviso enviado'],
  ] as const;
  return (
    <Mock label="la cartera por cobrar hoy" title="Cartera · por cobrar hoy">
      <ul className="pain-mock__rows">
        {rows.map(([who, age, amount, status]) => (
          <li key={who}>
            <span>
              {who}
              <small>{age}</small>
            </span>
            <b>{amount}</b>
            <i data-tone={status === 'Escalar' ? 'warn' : 'ok'}>{status}</i>
          </li>
        ))}
      </ul>
      <p className="pain-mock__foot">
        Abonos atados a su factura esta semana <b>3</b>
      </p>
    </Mock>
  );
}

function PulsoMock() {
  const tiles = [
    ['Ventas del mes', '$182 M', '▲ vs. mes pasado'],
    ['Cartera vencida', '$41 M', '▼ desde ayer'],
    ['Caja hoy', '$96 M', 'Sobre el mínimo'],
  ] as const;
  return (
    <Mock label="el pulso diario de la empresa" title="Pulso de hoy · 7:00 a. m.">
      <div className="pain-mock__tiles">
        {tiles.map(([name, value, delta]) => (
          <div key={name}>
            <small>{name}</small>
            <b>{value}</b>
            <span>{delta}</span>
          </div>
        ))}
      </div>
      <p className="pain-mock__foot">
        <span className="pain-mock__live" /> En vivo · 3 pendientes esperan tu decisión
      </p>
    </Mock>
  );
}

const BASE = [62, 58, 55, 49, 46, 42, 37, 40, 44, 48, 52, 56, 60];
const SCENARIO = [62, 58, 55, 45, 39, 33, 27, 31, 38, 46, 52, 56, 60];
const MINIMUM = 35;
const y = (value: number) => 96 - value * 1.25;

function CajaMock() {
  const line = SCENARIO.map((v, i) => `${i === 0 ? 'M' : 'L'}${14 + i * 19.5} ${y(v)}`).join(' ');
  return (
    <Mock
      label="proyección de caja a 13 semanas con un escenario"
      title="Caja · próximas 13 semanas"
    >
      <svg className="pain-mock__chart" viewBox="0 0 264 104" aria-hidden="true">
        <line className="pain-mock__min" x1="4" x2="260" y1={y(MINIMUM)} y2={y(MINIMUM)} />
        {BASE.map((v, i) => (
          <rect
            // biome-ignore lint/suspicious/noArrayIndexKey: las semanas son fijas y ordenadas.
            key={i}
            x={8 + i * 19.5}
            y={y(v)}
            width="12"
            height={96 - y(v)}
            rx="2"
            data-low={i === 6 ? 'true' : undefined}
          />
        ))}
        <path className="pain-mock__scenario" d={line} />
      </svg>
      <div className="pain-mock__legend">
        <span>
          <i data-kind="base" /> Proyección
        </span>
        <span>
          <i data-kind="scenario" /> ¿Y si Nexa paga 30 días tarde?
        </span>
      </div>
      <p className="pain-mock__foot">
        Semana 7 cae bajo el mínimo <b>−$8 M</b>
      </p>
    </Mock>
  );
}

function EquipoMock() {
  const days = [3, 5, 4, 6, 2];
  return (
    <Mock label="la pantalla Mi semana de una persona del equipo" title="Mi semana · Laura">
      <p className="pain-mock__lead">
        Cerraste <b>12 despachos</b>; 7 de 9 a tiempo.
      </p>
      <div className="pain-mock__days">
        {['L', 'M', 'M', 'J', 'V'].map((d, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: los días se repiten (M, M).
          <span key={i}>
            <i style={{ height: `${(days[i] ?? 0) * 6}px` }} />
            {d}
          </span>
        ))}
      </div>
      <p className="pain-mock__foot">Te esperan 4 · el primero vence mañana</p>
    </Mock>
  );
}

function RutinaMock() {
  const done = [
    'Envié 2 recordatorios de cobro',
    'Até 3 abonos del banco a sus facturas',
    'Categoricé 14 movimientos',
  ];
  const ask = [
    'Orden de compra · Tornillería',
    'Cobro a Ferretería El Puente',
    'Repartir 4 despachos de Laura',
  ];
  return (
    <Mock label="el resumen diario del piloto automático" title="Piloto automático · hoy">
      <p className="pain-mock__lead">
        Hoy hice <b>6 cosas</b>; necesito tu decisión en <b>3</b>.
      </p>
      <ul className="pain-mock__checks">
        {done.map((item) => (
          <li key={item}>
            <Check size={12} aria-hidden="true" /> {item}
          </li>
        ))}
        <li data-more="true">y 3 cosas más, cada una con su verificación</li>
        {ask.map((item) => (
          <li key={item} data-ask="true">
            <span /> {item}
          </li>
        ))}
      </ul>
    </Mock>
  );
}

function VistasMock() {
  return (
    <Mock
      label="un tablero compartido por enlace con contraseña"
      title="Despachos · Transportes del Valle"
    >
      <div className="pain-mock__view">
        <div>
          <small>En ruta</small>
          <b>18</b>
        </div>
        <div>
          <small>Entregados hoy</small>
          <b>42</b>
        </div>
        <div data-wide="true">
          <i style={{ width: '72%' }} />
        </div>
      </div>
      <p className="pain-mock__foot">
        <Lock size={11} aria-hidden="true" /> Compartido por enlace · con contraseña
      </p>
    </Mock>
  );
}

export const PAIN_MOCKS: Record<string, () => ReactNode> = {
  cartera: CarteraMock,
  pulso: PulsoMock,
  caja: CajaMock,
  equipo: EquipoMock,
  rutina: RutinaMock,
  vistas: VistasMock,
};
