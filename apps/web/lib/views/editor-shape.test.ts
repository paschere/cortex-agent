import {
  AGGREGATES as CANONICAL_AGGREGATES,
  BLOCK_ID_RE as CANONICAL_BLOCK_ID_RE,
  BLOCK_LABEL as CANONICAL_BLOCK_LABEL,
  FILTER_OPS as CANONICAL_FILTER_OPS,
  MAX_VIEW_BLOCKS as CANONICAL_MAX_BLOCKS,
  REFRESH_CHOICES as CANONICAL_REFRESH,
  TONES as CANONICAL_TONES,
  VALUELESS_OPS as CANONICAL_VALUELESS,
  WIDTHS as CANONICAL_WIDTHS,
  chartBlockSchema,
  isReadOnlySource,
  metricBlockSchema,
  viewSpecSchema,
} from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';
import {
  AGGREGATES,
  BLOCK_ID_RE,
  BLOCK_LABEL,
  BUCKETS,
  CHART_KINDS,
  EDITING_MODES,
  FILTER_OPS,
  FILTER_OP_LABEL,
  FORMATS,
  KNOWN_BLOCK_TYPES,
  MAX_VIEW_BLOCKS,
  REFRESH_CHOICES,
  TONES,
  VALUELESS_OPS,
  WIDTHS,
  isReadOnlySourceId,
} from './editor-shape';

/**
 * `editor-shape.ts` repite el vocabulario de las vistas para el lienzo, porque
 * importarlo del paquete arrastra `node:dns` al bundle del navegador. Esta
 * prueba corre en Node, importa el de verdad y falla si las dos copias dejan de
 * coincidir: sin ella, un operador nuevo en el contrato nunca aparecería en el
 * menú y nada se pondría rojo.
 */

// biome-ignore lint/suspicious/noExplicitAny: se leen las opciones de un ZodDefault<ZodEnum>.
const enumOf = (schema: any): string[] => [...schema._def.innerType.options];

describe('vocabulario del lienzo', () => {
  it('ofrece exactamente los operadores de filtro del contrato, cada uno con nombre', () => {
    expect([...FILTER_OPS]).toEqual([...CANONICAL_FILTER_OPS]);
    expect([...VALUELESS_OPS].sort()).toEqual([...CANONICAL_VALUELESS].sort());
    for (const op of FILTER_OPS) expect(FILTER_OP_LABEL[op]).toBeTruthy();
  });

  it('agregados, anchos, tonos, refresco y tope de bloques', () => {
    expect([...AGGREGATES]).toEqual([...CANONICAL_AGGREGATES]);
    expect([...WIDTHS].sort()).toEqual([...CANONICAL_WIDTHS].sort());
    expect([...TONES]).toEqual([...CANONICAL_TONES]);
    expect([...REFRESH_CHOICES]).toEqual([...CANONICAL_REFRESH]);
    expect(MAX_VIEW_BLOCKS).toBe(CANONICAL_MAX_BLOCKS);
    expect(BLOCK_ID_RE.source).toBe(CANONICAL_BLOCK_ID_RE.source);
  });

  it('tipos de gráfico, cubetas, formatos y modos de edición', () => {
    expect([...CHART_KINDS]).toEqual(enumOf(chartBlockSchema.shape.chart));
    expect([...BUCKETS]).toEqual(enumOf(chartBlockSchema.shape.bucket));
    expect([...FORMATS]).toEqual(enumOf(metricBlockSchema.shape.format));
    // biome-ignore lint/suspicious/noExplicitAny: el objeto vive dentro de un ZodEffects.
    const shape = (viewSpecSchema as any)._def.schema.shape;
    expect([...EDITING_MODES]).toEqual(enumOf(shape.editing));
  });

  it('nombra igual cada tipo de bloque que el contrato conoce', () => {
    // Los seis que el lienzo arma. Un tipo nuevo (p. ej. «zones») trae su nombre
    // del contrato cuando exista; aquí sólo se exige que los conocidos coincidan.
    for (const type of KNOWN_BLOCK_TYPES)
      expect(BLOCK_LABEL[type]).toBe((CANONICAL_BLOCK_LABEL as Record<string, string>)[type]);
  });

  it('distingue las fuentes de sólo lectura igual que el contrato', () => {
    const uuid = '0b6f7c1e-2a3b-4c5d-8e9f-0123456789ab';
    for (const ref of [
      'remates',
      'guias_carga',
      'cortex.ventas',
      'cortex.rutinas',
      `feed.${uuid}.0`,
      `feedsrc.${uuid}.3`,
      `feedview.${uuid}`,
    ])
      expect(isReadOnlySourceId(ref)).toBe(isReadOnlySource(ref));
  });
});
