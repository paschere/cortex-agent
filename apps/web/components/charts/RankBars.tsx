'use client';

import { clsx } from 'clsx';
import Link from 'next/link';
import { useState } from 'react';
import { ChartEmpty } from './ChartEmpty';

export interface RankItem {
  label: string;
  value: number;
  display: string;
  color?: string;
  /** Texto bajo la etiqueta («2 facturas · 41 días vencida»). */
  sub?: string;
  /** Con destino, la fila entera abre esa pantalla. */
  href?: string;
  /** La fila pide atención: la etiqueta y la cifra no cambian, pero lleva un punto rosa. */
  alert?: boolean;
  /** Pronóstico: la barra va rayada y apagada, y la etiqueta lo dice. */
  projected?: boolean;
}

const PCT = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });

/**
 * Barras horizontales para comparar categorías con nombres largos: la etiqueta
 * y la cifra arriba, la barra (con la punta redondeada) debajo y el peso de
 * cada una en el total. Al pasar por una se apagan las demás.
 */
export function RankBars({
  items,
  color,
  name,
  showShare = true,
  className,
}: {
  items: RankItem[];
  color: string;
  name: string;
  showShare?: boolean;
  className?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  if (items.length === 0 || items.every((i) => i.value === 0)) {
    return <ChartEmpty note="Sin datos suficientes" height={96} className={className} />;
  }
  const max = Math.max(...items.map((p) => Math.abs(p.value)), 1);
  const sum = items.reduce((a, p) => a + Math.max(p.value, 0), 0) || 1;
  return (
    <ul className={clsx('space-y-3.5', className)} aria-label={name}>
      {items.map((p, i) => (
        <li
          key={p.label}
          title={p.projected ? `${p.label}: ${p.display} (pronóstico)` : `${p.label}: ${p.display}`}
          onPointerEnter={() => setHover(i)}
          onPointerLeave={() => setHover(null)}
          className="transition-opacity duration-150"
          style={{ opacity: hover === null || hover === i ? 1 : 0.45 }}
        >
          <div className="mb-1.5 flex items-baseline justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-1.5">
              {p.alert && (
                <>
                  <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-pill bg-rose" />
                  <span className="sr-only">(pide atención) </span>
                </>
              )}
              {p.href ? (
                <Link
                  href={p.href}
                  className="min-w-0 truncate font-medium text-ink hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary/40"
                >
                  {p.label}
                </Link>
              ) : (
                <span className="min-w-0 truncate font-medium text-ink">{p.label}</span>
              )}
              {p.projected && (
                <span className="shrink-0 rounded-pill bg-surface-2 px-1.5 text-micro text-ink-faint">
                  Pronóstico
                </span>
              )}
            </span>
            <span className="shrink-0">
              <span className="tabular tabular-nums font-semibold text-ink">{p.display}</span>
              {showShare && (
                <span className="tabular ml-2 inline-block w-9 text-right tabular-nums text-micro text-ink-faint">
                  {PCT.format((Math.max(p.value, 0) / sum) * 100)} %
                </span>
              )}
            </span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-pill bg-surface-2">
            <div
              className="cx-grow-x h-full rounded-pill"
              style={{
                width: `${Math.max((Math.abs(p.value) / max) * 100, p.value ? 2 : 0)}%`,
                background: p.projected
                  ? `repeating-linear-gradient(135deg, ${p.color ?? color} 0 4px, transparent 4px 7px)`
                  : (p.color ?? color),
                opacity: p.projected ? 0.55 : i === 0 ? 1 : 0.8,
                animationDelay: `${i * 40}ms`,
              }}
            />
          </div>
          {p.sub && <p className="mt-1 text-micro text-ink-faint">{p.sub}</p>}
        </li>
      ))}
    </ul>
  );
}
