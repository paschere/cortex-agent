import type { ConstellationDoc, ConstellationSpace } from '../types';

/**
 * La geometría de la constelación, sin React y sin three.
 *
 * TODO AQUÍ ES PURO Y SEMBRADO POR ID, por la misma razón que el relieve 2D
 * (`field-math.ts`): la gente navega recordando dónde estaban las cosas, y un
 * cielo que se reordena en cada visita es un cielo que no se puede aprender.
 * Nada de física en tiempo real: las posiciones se calculan una vez por cambio
 * de datos, y lo único que se anima después es una rotación lenta que no
 * cambia la forma del cúmulo.
 *
 * Es un módulo aparte porque es la única parte de la escena que vale la pena
 * probar en unit tests — que sea determinista, que el tamaño crezca con los
 * fragmentos, que nada se salga de su cúmulo — sin arrastrar WebGL al runner.
 */

/* ------------------------------------------------------------------ semilla */

/**
 * Un número estable en [0,1) a partir de un id. El mismo FNV que usa el mapa
 * de relieve: barato, sin dependencias, y suficiente para esparcir — aquí no
 * se necesita calidad criptográfica, se necesita que mañana dé lo mismo.
 */
export function hashUnit(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/* -------------------------------------------------------------------- formas */

export interface PlacedDocNode extends ConstellationDoc {
  /** Posición local al centro del cúmulo, en unidades de escena. */
  position: [number, number, number];
  /** Radio de la esfera. Raíz cuadrada del peso, no lineal — ver abajo. */
  radius: number;
}

export interface PlacedCluster {
  id: string;
  name: string;
  color?: string;
  /** Índice en la paleta de tokens de marca, sembrado por id. */
  paletteIndex: number;
  /** Ángulo base de la órbita alrededor del núcleo, en radianes. */
  phase: number;
  /** Distancia del centro del cúmulo al núcleo. */
  orbitRadius: number;
  /** Desnivel vertical, para que el organismo no sea un plato plano. */
  yOffset: number;
  /** Radianes por segundo. MUY lento a propósito. */
  speed: number;
  /** Sentido de giro, sembrado — que no todos roten en fila. */
  direction: 1 | -1;
  /** Radio del cúmulo: hasta dónde llegan sus documentos. */
  radius: number;
  docs: PlacedDocNode[];
}

/** Cuántos colores de marca reparte la escena entre cúmulos. */
export const PALETTE_SIZE = 4;

/**
 * Los mismos cuatro colores, dichos dos veces: como token CSS para el DOM
 * (leyenda, tooltip) y como var para que la escena lea su RGB en runtime.
 * Se omite el rose a propósito — en este design system es el color de «se
 * venció / falló», y un cúmulo no está fallando por existir.
 */
export const PALETTE_VARS = ['--primary', '--sky', '--emerald', '--amber'] as const;
export const PALETTE_CSS = PALETTE_VARS.map((v) => `rgb(var(${v}))`);
/** Respaldo por si un token no se puede leer: los valores de globals.css. */
export const PALETTE_FALLBACK = ['#5850ec', '#0e85c8', '#0d946f', '#be8014'] as const;

/** Ángulo áureo: reparte puntos sin que dos índices vecinos queden pegados. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/* -------------------------------------------------------------------- layout */

export function placeConstellation(spaces: ConstellationSpace[]): PlacedCluster[] {
  if (spaces.length === 0) return [];

  // Orden por id antes de repartir: así el resultado no depende del orden en
  // que llegó el array, solo de QUÉ espacios hay.
  const sorted = [...spaces].sort((a, b) => a.id.localeCompare(b.id));
  const n = sorted.length;

  // El documento más gordo de todo el corpus fija la escala de radios: una
  // esfera es grande RESPECTO A las demás, no en absoluto.
  const maxChunks = Math.max(
    1,
    ...sorted.flatMap((s) => s.documents.map((d) => Math.max(0, d.chunkCount))),
  );

  return sorted.map((space, i) => {
    // Ranura angular pareja + jitter sembrado DENTRO de la ranura: con pocos
    // espacios no se amontonan, y el jitter nunca alcanza para invadir a la
    // vecina. Un reparto 100% por hash puede poner dos cúmulos en el mismo
    // grado; una ranura no.
    const slot = (i / n) * Math.PI * 2;
    const phase = slot + (hashUnit(space.id, 1) - 0.5) * (Math.PI / n);

    const docCount = space.documents.length;
    // Raíz cuadrada, no lineal: un espacio con cien documentos ocupa diez
    // veces el radio de uno con uno, no cien — o un corpus se traga la escena.
    const radius = Math.min(3.2, 0.9 + 0.5 * Math.sqrt(docCount));

    const orbitRadius = 6 + hashUnit(space.id, 2) * 4.5;
    const yOffset = (hashUnit(space.id, 3) - 0.5) * 3;
    const speed = 0.015 + hashUnit(space.id, 4) * 0.02;
    const direction: 1 | -1 = hashUnit(space.id, 5) < 0.5 ? 1 : -1;
    const paletteIndex = Math.floor(hashUnit(space.id, 6) * PALETTE_SIZE) % PALETTE_SIZE;

    // Docs ordenados por id por lo mismo que los espacios; la espiral de
    // Fibonacci reparte direcciones sobre la esfera sin que dos consecutivos
    // queden juntos, y el jitter por id rompe la regularidad para que se lea
    // orgánico en vez de cristalino.
    const docs = [...space.documents]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((doc, j, all) => {
        const y = all.length === 1 ? 0 : 1 - (2 * (j + 0.5)) / all.length;
        const ring = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = j * GOLDEN + hashUnit(doc.id, 1) * 0.7;
        const dist = radius * (0.45 + 0.5 * hashUnit(doc.id, 2));
        const share = Math.max(0, doc.chunkCount) / maxChunks;
        return {
          ...doc,
          position: [
            Math.cos(theta) * ring * dist,
            y * dist * 0.8,
            Math.sin(theta) * ring * dist,
          ] as [number, number, number],
          // Piso de 0.1: un documento aún sin fragmentos embebidos existe y se
          // toca, solo que no abulta.
          radius: 0.1 + 0.28 * Math.sqrt(share),
        };
      });

    return {
      id: space.id,
      name: space.name,
      ...(space.color ? { color: space.color } : {}),
      paletteIndex,
      phase,
      orbitRadius,
      yOffset,
      speed,
      direction,
      radius,
      docs,
    };
  });
}
