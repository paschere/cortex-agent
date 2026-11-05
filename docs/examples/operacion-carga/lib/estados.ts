/** Estados de la operación y el color de cada uno. */

export type Tono = 'neutral' | 'info' | 'warn' | 'bad' | 'good' | 'accent' | 'quiet';

export const ESTADOS_VUELO = [
  'Programado',
  'En camino',
  'Demorado',
  'Aterrizó',
  'En atención',
  'Recibido',
  'Cerrado',
  'Cancelado',
] as const;

export const TONO_VUELO: Record<string, Tono> = {
  Programado: 'neutral',
  'En camino': 'info',
  Demorado: 'warn',
  Aterrizó: 'accent',
  'En atención': 'good',
  Recibido: 'good',
  Cerrado: 'quiet',
  Cancelado: 'bad',
};

export const ESTADOS_ATENCION = ['En atención', 'Por aprobar', 'Aprobada', 'Rechazada'] as const;

export const TONO_ATENCION: Record<string, Tono> = {
  'En atención': 'info',
  'Por aprobar': 'warn',
  Aprobada: 'good',
  Rechazada: 'bad',
};

export const TONO_COSTO: Record<string, Tono> = {
  Probable: 'warn',
  Aprobado: 'good',
  Anulado: 'quiet',
};

export const TONO_EVENTO: Record<string, Tono> = {
  Abierto: 'warn',
  Revisado: 'info',
  Resuelto: 'good',
};

export const TONO_ETAPA: Record<string, Tono> = {
  Esperada: 'neutral',
  Recibida: 'good',
  Prefacturada: 'quiet',
};

export const TIPOS_EVENTO = [
  'Comienzo recepción',
  'Comienzo desempaque',
  'Fin desempaque',
  'Entrega de la carga',
  'Tanqueo de combustible',
  'Equipo varado',
  'Daño o incidente',
  'Novedad',
  'Otro',
] as const;

/** Tipos que se consideran críticos aunque la regla del servidor no los haya marcado todavía. */
export const TIPOS_CRITICOS = new Set(['Equipo varado', 'Daño o incidente']);

export const TIPOS_GUIA = ['Madre (MAWB)', 'Hija (HAWB)', 'Directa'] as const;

export const PARCIALES = ['No', 'P.A', 'P.B', 'P.FINAL'] as const;

/** Respaldo por si `tables.list` no responde (opciones reales del tarifario). */
export const EQUIPOS_TARIFA = [
  'Planta eléctrica 90 KVA',
  'Escalera manual',
  'Remolque avión corto',
  'Carritos porta equipaje',
  'Tractor',
  'Dollie',
  'Cargador Main Deck',
  'Conveyor',
  'Traslado avión a recinto',
  'Drenaje',
  'Montacarga 5T',
  'Montacarga 3T',
  'Barra de tiro',
  'Bodegaje carga (pallet x24h)',
  'Tractor con operario + 3 dollies fijo',
  'Tractor con operario + 3 dollies esporádico',
  'Carro escalera',
  'Arrancador',
  'Agua potable',
  'Montacarga 7 Ton',
];

export const PROVEEDORES = [
  'AEROSUCRE',
  'AEROSAN',
  'HGS',
  'AEROASOCIADOS',
  'GHI',
  'CARGOPACK',
  'MENZIES',
  'TAESCOL',
];

export function tono(mapa: Record<string, Tono>, estado: string): Tono {
  return mapa[estado] ?? 'neutral';
}

/**
 * ¿La diferencia queda fuera del margen? Kilos: porcentaje sobre lo esperado;
 * pallets: cantidad absoluta (igual que la regla del servidor, para verlo en vivo).
 */
export function fueraDeMargen(args: {
  kilosEsp: number;
  kilosRec: number | null;
  palletsEsp: number;
  palletsRec: number | null;
  margenKilosPct: number;
  margenPallets: number;
}): { kilos: boolean; pallets: boolean; difKilos: number | null; difPallets: number | null } {
  const difKilos = args.kilosRec === null ? null : args.kilosRec - args.kilosEsp;
  const difPallets = args.palletsRec === null ? null : args.palletsRec - args.palletsEsp;
  const limiteKilos = (args.kilosEsp * args.margenKilosPct) / 100;
  return {
    difKilos,
    difPallets,
    kilos: difKilos !== null && Math.abs(difKilos) > limiteKilos + 1e-9,
    pallets: difPallets !== null && Math.abs(difPallets) > args.margenPallets + 1e-9,
  };
}
