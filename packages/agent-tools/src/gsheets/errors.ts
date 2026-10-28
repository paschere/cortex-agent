import { IntegrationError } from '@cortex/core';

/**
 * Error de la API de Google (Sheets o Drive) con el estado HTTP y el mensaje
 * original de Google, para poder distinguir «sin acceso», «no existe» y «es un
 * Excel» sin leer texto en inglés en cada sitio. El `message` conserva el
 * formato de siempre (`Sheets 400 /ruta: cuerpo`).
 */
export class GoogleApiError extends IntegrationError {
  constructor(
    readonly api: 'sheets' | 'drive',
    readonly status: number,
    path: string,
    readonly body: string,
  ) {
    super(`${api === 'sheets' ? 'Sheets' : 'Drive'} ${status} ${path}: ${body}`, 'google');
    this.name = 'GoogleApiError';
  }

  /** El mensaje y el motivo que Google puso en el cuerpo JSON (sin datos del usuario). */
  get googleMessage(): string {
    try {
      const parsed = JSON.parse(this.body) as {
        error?: { message?: string; status?: string; errors?: Array<{ reason?: string }> };
      };
      const e = parsed.error;
      return [e?.status, e?.errors?.[0]?.reason, e?.message].filter(Boolean).join(' | ');
    } catch {
      return this.body.slice(0, 300);
    }
  }
}

/** Resumen seguro para el log del servidor: sin cuerpo completo ni ids de usuario. */
export function logGoogleError(
  logger: { warn: (obj: object, msg: string) => void } | undefined,
  err: unknown,
  where: string,
): void {
  if (!(err instanceof GoogleApiError)) return;
  logger?.warn(
    { api: err.api, status: err.status, google: err.googleMessage.slice(0, 300), where },
    'google api error',
  );
}

/**
 * La API de Sheets rechaza los archivos de Excel (.xlsx) abiertos en la
 * interfaz de Sheets con 400 «This operation is not supported for this
 * document» (FAILED_PRECONDITION). Esos se leen por Drive.
 */
export function isExcelRejection(err: unknown): boolean {
  return (
    err instanceof GoogleApiError &&
    err.api === 'sheets' &&
    err.status === 400 &&
    /not supported for this document|FAILED_PRECONDITION/i.test(err.body)
  );
}
