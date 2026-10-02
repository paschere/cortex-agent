import { normalizePhone } from '@cortex/agent-tools';

/**
 * VINCULAR EL NÚMERO CUANDO ALGUIEN LO PIDE (migración 0169).
 *
 * El puente de WhatsApp sin sesión ya no abre conexiones por su cuenta: se queda
 * quieto hasta que un administrador pide vincular desde Integraciones →
 * WhatsApp. La petición es una marca de tiempo en `whatsapp_sessions`, y está
 * VIVA mientras tenga menos de `PAIRING_REQUEST_TTL_MS`. La pantalla abierta la
 * renueva (`keepalive`); cerrarla la deja vencer sola, y el puente vuelve a
 * quedarse quieto. Así nadie tiene que acordarse de «apagar» nada, y un intento
 * olvidado no se queda hablando con WhatsApp para siempre.
 *
 * Todo lo que decide aquí es puro para poder probarlo sin base de datos; las
 * rutas (`/api/whatsapp/pairing`, el latido del puente y `/status`) sólo leen y
 * escriben.
 */

/** Cuánto vive una petición sin que nadie la renueve. */
export const PAIRING_REQUEST_TTL_MS = 3 * 60_000;

/** Cada cuánto la pantalla abierta renueva la petición. Bien por debajo del TTL. */
export const PAIRING_KEEPALIVE_MS = 45_000;

export function isPairingRequestAlive(
  requestedAt: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!requestedAt) return false;
  const at = Date.parse(requestedAt);
  return Number.isFinite(at) && now.getTime() - at < PAIRING_REQUEST_TTL_MS;
}

/** Lo que la respuesta al latido le dice al puente sobre vincular. */
export function pairingReply(
  session: { pairing_requested_at?: unknown; pairing_phone?: unknown } | null | undefined,
  now: Date = new Date(),
): { pairingRequested: boolean; pairingPhone: string | null } {
  const requested = isPairingRequestAlive(
    typeof session?.pairing_requested_at === 'string' ? session.pairing_requested_at : null,
    now,
  );
  const phone = typeof session?.pairing_phone === 'string' ? session.pairing_phone : null;
  return { pairingRequested: requested, pairingPhone: requested ? phone : null };
}

export type PairingCommand =
  /** Mostrar un QR para escanear. */
  | { mode: 'qr' }
  /** Pedirle a WhatsApp un código de 8 caracteres para este número. */
  | { mode: 'code'; phone: string }
  /** La pantalla sigue abierta: que la petición viva un rato más. */
  | { mode: 'keepalive' }
  /** Ya no: que el puente vuelva a quedarse quieto. */
  | { mode: 'cancel' };

export function parsePairingCommand(
  body: unknown,
): { ok: true; command: PairingCommand } | { ok: false; error: string } {
  const input = (body && typeof body === 'object' ? body : {}) as {
    mode?: unknown;
    phone?: unknown;
  };
  switch (input.mode) {
    case 'qr':
    case 'keepalive':
    case 'cancel':
      return { ok: true, command: { mode: input.mode } };
    case 'code': {
      const phone = normalizePhone(typeof input.phone === 'string' ? input.phone : '');
      if (!phone) {
        return {
          ok: false,
          error:
            'Ese número no se entiende. Escribe el del teléfono dedicado con indicativo, por ejemplo +57 300 111 2233.',
        };
      }
      return { ok: true, command: { mode: 'code', phone } };
    }
    default:
      return { ok: false, error: 'Elige cómo vincular: con código QR o con el número.' };
  }
}

/** Lo que la pantalla necesita saber del intento en curso. */
export interface PairingView {
  /** Hay alguien pidiendo vincular ahora mismo. */
  requested: boolean;
  mode: 'qr' | 'code' | null;
  phone: string | null;
  /** El código de 8 caracteres, mientras siga vigente. */
  code: string | null;
}

export function pairingView(
  row:
    | {
        pairing_requested_at?: unknown;
        pairing_phone?: unknown;
        pairing_code?: unknown;
        pairing_code_expires_at?: unknown;
      }
    | null
    | undefined,
  now: Date = new Date(),
): PairingView {
  const requested = isPairingRequestAlive(
    typeof row?.pairing_requested_at === 'string' ? row.pairing_requested_at : null,
    now,
  );
  const phone = typeof row?.pairing_phone === 'string' ? row.pairing_phone : null;
  const expires =
    typeof row?.pairing_code_expires_at === 'string' ? Date.parse(row.pairing_code_expires_at) : 0;
  const code =
    requested && phone && typeof row?.pairing_code === 'string' && expires > now.getTime()
      ? row.pairing_code
      : null;
  return {
    requested,
    mode: requested ? (phone ? 'code' : 'qr') : null,
    phone: requested ? phone : null,
    code,
  };
}
