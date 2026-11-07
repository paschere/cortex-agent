import { num } from './formato';

/** Gráficos propios en HTML/SVG, sin dependencias. */

export const ACENTO = '#17428a';
export const PALETA = [ACENTO, '#5b7fc0', '#2f6b3e', '#8a8068', '#a3281f', '#1d7f86', '#7a7060', '#b08a00'];

export interface Dato {
  etiqueta: string;
  valor: number;
  color?: string;
}

/** Barras horizontales con valor al final. */
export function Barras({ datos, formato = (n: number) => num(n), max }: { datos: Dato[]; formato?: (n: number) => string; max?: number }) {
  const tope = max ?? Math.max(1, ...datos.map((d) => d.valor));
  return (
    <div className="oc-hbar" role="list">
      {datos.map((d, i) => (
        <div key={d.etiqueta} style={{ display: 'contents' }} role="listitem">
          <span className="et" title={d.etiqueta}>
            {d.etiqueta || '—'}
          </span>
          <div className="oc-barra">
            <i style={{ width: `${Math.max(2, (d.valor / tope) * 100)}%`, background: d.color ?? ACENTO }} />
          </div>
          <span className="v">{formato(d.valor)}</span>
        </div>
      ))}
    </div>
  );
}

/** Columnas verticales (una serie) para tendencias por día. */
export function Columnas({ datos, formato = (n: number) => num(n) }: { datos: Dato[]; formato?: (n: number) => string }) {
  const alto = 150;
  const ancho = Math.max(280, datos.length * 34);
  const tope = Math.max(1, ...datos.map((d) => d.valor));
  const w = ancho / Math.max(1, datos.length);
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width="100%" style={{ minWidth: Math.min(ancho, 320), maxHeight: 260 }} viewBox={`0 0 ${ancho} ${alto + 34}`} role="img" aria-label="Gráfico de columnas">
        <line x1="0" x2={ancho} y1={alto} y2={alto} stroke="#d6cdb8" />
        {datos.map((d, i) => {
          const h = (d.valor / tope) * (alto - 18);
          return (
            <g key={d.etiqueta}>
              <rect x={i * w + w * 0.18} y={alto - h} width={w * 0.64} height={h} rx="7" fill={d.color ?? ACENTO}>
                <title>{`${d.etiqueta}: ${formato(d.valor)}`}</title>
              </rect>
              <text x={i * w + w / 2} y={alto - h - 4} textAnchor="middle" fontSize="10" fill="#4a4338">
                {d.valor ? formato(d.valor) : ''}
              </text>
              <text x={i * w + w / 2} y={alto + 16} textAnchor="middle" fontSize="11" fill="#7a7060">
                {d.etiqueta}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Dona con leyenda. */
export function Dona({ datos, centro }: { datos: Dato[]; centro?: string }) {
  const total = datos.reduce((a, d) => a + d.valor, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let acum = 0;
  return (
    <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <svg width="140" height="140" viewBox="0 0 140 140" role="img" aria-label="Gráfico de dona">
        <circle cx="70" cy="70" r={R} fill="none" stroke="#f5efe2" strokeWidth="22" />
        {total > 0 &&
          datos.map((d, i) => {
            const frac = d.valor / total;
            const el = (
              <circle
                key={d.etiqueta}
                cx="70"
                cy="70"
                r={R}
                fill="none"
                stroke={d.color ?? PALETA[i % PALETA.length]}
                strokeWidth="22"
                strokeDasharray={`${frac * C} ${C}`}
                strokeDashoffset={-acum * C}
                transform="rotate(-90 70 70)"
              >
                <title>{`${d.etiqueta}: ${num(d.valor)}`}</title>
              </circle>
            );
            acum += frac;
            return el;
          })}
        <text x="70" y="76" textAnchor="middle" fontSize="22" fontFamily="inherit" fontWeight="700" fill="#1f1b16">
          {centro ?? num(total)}
        </text>
      </svg>
      <div className="oc-leyenda" style={{ flexDirection: 'column', gap: 4 }}>
        {datos.map((d, i) => (
          <span key={d.etiqueta}>
            <i style={{ background: d.color ?? PALETA[i % PALETA.length] }} />
            {d.etiqueta}: <b>{num(d.valor)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/** Mini línea para las tarjetas de cifras. */
export function Sparkline({ valores, ancho = 84, alto = 30 }: { valores: number[]; ancho?: number; alto?: number }) {
  const max = Math.max(...valores);
  const min = Math.min(...valores);
  const r = max - min || 1;
  const pts = valores.map((v, i) => `${(i / (valores.length - 1)) * (ancho - 4) + 2},${alto - 4 - ((v - min) / r) * (alto - 8)}`);
  return (
    <svg width={ancho} height={alto} viewBox={`0 0 ${ancho} ${alto}`} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={ACENTO} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1]?.split(',')[0]} cy={pts[pts.length - 1]?.split(',')[1]} r="3" fill={ACENTO} />
    </svg>
  );
}

/** Área con degradado para tendencias (con puntos que dan su valor al pasar el cursor). */
export function Area({ datos, formato = (n: number) => num(n), alto = 170 }: { datos: Dato[]; formato?: (n: number) => string; alto?: number }) {
  const ancho = Math.max(300, datos.length * 40);
  const tope = Math.max(1, ...datos.map((d) => d.valor));
  const x = (i: number) => 14 + (i / Math.max(1, datos.length - 1)) * (ancho - 28);
  const y = (v: number) => alto - 28 - (v / tope) * (alto - 52);
  const linea = datos.map((d, i) => `${i ? 'L' : 'M'}${x(i)},${y(d.valor)}`).join(' ');
  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width="100%" style={{ minWidth: Math.min(ancho, 320), maxHeight: 260 }} viewBox={`0 0 ${ancho} ${alto}`} role="img" aria-label="Gráfico de área">
        <defs>
          <linearGradient id="oc-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#17428a" stopOpacity=".35" />
            <stop offset="1" stopColor="#17428a" stopOpacity="0" />
          </linearGradient>
        </defs>
        {datos.length > 1 ? <path d={`${linea} L${x(datos.length - 1)},${alto - 28} L${x(0)},${alto - 28} Z`} fill="url(#oc-area)" /> : null}
        <path d={linea} fill="none" stroke="#17428a" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
        {datos.map((d, i) => (
          <g key={d.etiqueta}>
            <circle cx={x(i)} cy={y(d.valor)} r="4.5" fill="#fff" stroke="#17428a" strokeWidth="2.5">
              <title>{`${d.etiqueta}: ${formato(d.valor)}`}</title>
            </circle>
            <text x={x(i)} y={alto - 8} textAnchor="middle" fontSize="11" fill="#6f6757">
              {d.etiqueta}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
