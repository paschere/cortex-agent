/**
 * LA PANTALLA DE ATENCIÓN POR WHATSAPP, SIN EL PAQUETE (0185).
 *
 * Datos puros que importa el componente de cliente. Las etiquetas viven
 * también en packages/agent-tools/src/whatsapp/customer/shape.ts, pero un
 * componente `'use client'` sólo puede hacer `import type` de
 * `@cortex/agent-tools` (arrastraría `node:dns` al bundle), así que aquí está
 * la copia que dibuja la pantalla.
 */

export const STATUS_TEXT: Record<string, string> = {
  abierta: 'Abierta',
  escalada: 'Con una persona',
  cerrada: 'Cerrada',
};

export const STATUS_TONE: Record<string, string> = {
  abierta: 'bg-sky-soft text-sky',
  escalada: 'bg-amber-soft text-amber',
  cerrada: 'bg-surface-2 text-ink-muted',
};

export const VERIFICATION_TEXT: Record<string, string> = {
  ninguna: 'Sin identificar',
  telefono: 'Identificado por su teléfono',
  pendiente: 'Esperando NIT y factura',
  verificado: 'Verificado con NIT y factura',
  bloqueada: 'Verificación bloqueada',
};

export const INTENT_TEXT: Record<string, string> = {
  saludo: 'Saludo',
  estado_pedido: 'Estado de pedido',
  saldo: 'Saldo',
  facturas: 'Facturas',
  cotizacion: 'Cotización',
  queja: 'Queja',
  persona: 'Pidió una persona',
  empresa: 'Datos de la empresa',
  faq: 'Pregunta frecuente',
  baja: 'Baja',
  alta: 'Reactivó',
  gracias: 'Gracias',
  verificacion: 'Verificación',
  fuera_horario: 'Fuera de horario',
  acuse: 'Acuse',
  otro: 'Otro',
};

export const DELIVERY_TEXT: Record<string, string> = {
  pendiente: 'En cola',
  enviando: 'Enviando…',
  enviado: 'Entregado',
  fallido: 'No se entregó',
};

export const WEEKDAY_TEXT: Array<[string, string]> = [
  ['1', 'Lunes'],
  ['2', 'Martes'],
  ['3', 'Miércoles'],
  ['4', 'Jueves'],
  ['5', 'Viernes'],
  ['6', 'Sábado'],
  ['7', 'Domingo'],
];

export interface AtencionTracker {
  id: string;
  name: string;
  fields: Array<{ key: string; label: string }>;
}

export interface AtencionPerson {
  id: string;
  name: string;
}

export type AtencionResult = { ok: true; note?: string } | { ok: false; error: string };

/** «hace 5 min», «ayer 14:20», «3 oct». */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const minutes = Math.round((now.getTime() - t) / 60_000);
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `hace ${days} d`;
  return new Date(t).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
    timeZone: 'America/Bogota',
  });
}

/** El número como lo lee una persona. */
export function phoneText(phone: string): string {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('57') && d.length === 12) {
    return `+57 ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}`;
  }
  return `+${d}`;
}
