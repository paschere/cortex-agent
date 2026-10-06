/**
 * LO NUEVO Y LO QUE CAMBIÓ ENTRE DOS REFRESCOS de una vista abierta. Funciones
 * puras: LiveViewCanvas las usa para titilar filas y para decidir qué avisa
 * una alerta. Sin red ni DOM, para poder probarlas.
 */

import type { ComputedBlock } from '@cortex/agent-tools';

export type AlertOn = 'new' | 'change' | 'both';

export interface AlertRowLite {
  id: string;
  label: string;
  /** Huella de la fila (su última actualización). */
  rev: string;
}

export interface AlertHit {
  row: AlertRowLite;
  kind: 'new' | 'change';
}

/**
 * Qué filas de una alerta son noticia. `known` es lo visto en el refresco
 * anterior (id → huella); sin él (primer vistazo) nada es noticia.
 */
export function detectAlertHits(
  known: Map<string, string> | undefined,
  rows: AlertRowLite[],
  on: AlertOn,
): AlertHit[] {
  if (!known) return [];
  const hits: AlertHit[] = [];
  for (const row of rows) {
    const before = known.get(row.id);
    if (before === undefined) {
      if (on !== 'change') hits.push({ row, kind: 'new' });
    } else if (before !== row.rev && on !== 'new') {
      hits.push({ row, kind: 'change' });
    }
  }
  return hits;
}

/** Huellas por clave `bloque:fila` de lo que se ve en tablas, tableros y galerías. */
export function blockFingerprints(blocks: ReadonlyArray<ComputedBlock>): Map<string, string> {
  const out = new Map<string, string>();
  for (const b of blocks) {
    if (b.type === 'table') {
      for (const r of b.rows)
        out.set(`${b.id}:${r.id}`, `${r.cells.join('\u0001')}\u0002${r.alert ? 1 : 0}`);
    } else if (b.type === 'gallery') {
      for (const c of b.cards)
        out.set(
          `${b.id}:${c.id}`,
          [
            c.title,
            c.subtitle,
            c.badge?.label,
            c.meta.map((m) => m.value).join('\u0001'),
            c.alert ? 1 : 0,
          ].join('\u0002'),
        );
    } else if (b.type === 'board' || b.type === 'zones') {
      for (const col of b.columns)
        for (const c of col.cards)
          out.set(
            `${b.id}:${c.id}`,
            [col.key, c.label, c.details.map((d) => d.value).join('\u0001'), c.alert ? 1 : 0].join(
              '\u0002',
            ),
          );
    }
  }
  return out;
}

/** Claves que llegaron o cambiaron respecto del refresco anterior. */
export function flashKeys(
  prev: Map<string, string> | null,
  next: Map<string, string>,
): Set<string> {
  const out = new Set<string>();
  if (!prev) return out;
  for (const [k, fp] of next) if (prev.get(k) !== fp) out.add(k);
  return out;
}

/** Preferencia de quien mira. */
export type WatchMode = 'off' | 'flash' | 'toast' | 'sound';
export const WATCH_MODES: Array<{ value: WatchMode; label: string }> = [
  { value: 'off', label: 'Apagados' },
  { value: 'flash', label: 'Sólo titilar' },
  { value: 'toast', label: 'Toast' },
  { value: 'sound', label: 'Toast y sonido' },
];

export function parseWatchMode(raw: string | null, hasAlerts: boolean): WatchMode {
  if (raw === 'off' || raw === 'flash' || raw === 'toast' || raw === 'sound') return raw;
  // Preferencia vieja de un interruptor: 'on' era con sonido.
  if (raw === 'on') return 'sound';
  return hasAlerts ? 'toast' : 'flash';
}
