import { ValidationError } from '@cortex/core';
import { GoogleApiError, isExcelRejection } from '../gsheets/errors';
import type { ToolContext } from '../types';
import { isDriveScopeError } from './drive-excel';

const RECONNECT =
  'Reconecta Google en Datos y conexiones y acepta el acceso a Drive y a Hojas de cálculo; ése es el único paso que no puedo hacer yo.';

/**
 * El error de Google al leer una hoja o un Excel de Drive, dicho en español y
 * distinguiendo la causa: sin conexión o sin permiso, sin acceso al archivo
 * (con la cuenta con la que hay que compartirlo), enlace que no existe, Excel
 * que no se pudo leer, cuota. El error original ya quedó en el log del
 * servidor (ver `logGoogleError`).
 */
export async function describeSheetReadError(ctx: ToolContext, err: unknown): Promise<Error> {
  if (err instanceof ValidationError) return err;
  if (err instanceof GoogleApiError) {
    if (isDriveScopeError(err) && err.api === 'drive') {
      return new ValidationError(
        `Este archivo es un Excel o CSV guardado en Drive y para leerlo falta el permiso de Drive en la conexión de Google. ${RECONNECT}`,
      );
    }
    if (err.status === 401 || isDriveScopeError(err)) {
      return new ValidationError(
        `La conexión de Google venció o le falta un permiso (${err.api === 'sheets' ? 'Hojas de cálculo' : 'Drive'}). ${RECONNECT}`,
      );
    }
    if (err.status === 403 && /rateLimitExceeded|userRateLimit|quota/i.test(err.body)) {
      return new ValidationError(
        'Google está limitando las consultas por ahora. Espera un minuto y vuelve a intentar.',
      );
    }
    if (err.status === 403) {
      const email = await ctx.integrations.accountEmail?.('google').catch(() => null);
      const who = email
        ? `la cuenta de Google conectada en Cortex, ${email}`
        : 'la cuenta de Google que conectó la empresa en Cortex (la ves en Datos y conexiones)';
      return new ValidationError(
        `Esa cuenta no tiene acceso al archivo. Compártelo con ${who} (basta con permiso de lectura) y vuelve a pegar el enlace.`,
      );
    }
    if (err.status === 404) {
      return new ValidationError(
        'Google dice que ese archivo no existe (o que no es visible para la cuenta conectada). Revisa que el enlace esté completo y bien copiado, y que no sea de un archivo borrado.',
      );
    }
    if (err.status === 429) {
      return new ValidationError(
        'Google está limitando las consultas por ahora. Espera un minuto y vuelve a intentar.',
      );
    }
    if (isExcelRejection(err)) {
      return new ValidationError(
        'Ese enlace es un archivo de Excel abierto en Hojas de cálculo y Google no deja leerlo como hoja. Normalmente lo leo directo desde Drive; esta vez no pude. Convierte el archivo (Archivo > Guardar como hoja de cálculo de Google) y pega el enlace nuevo.',
      );
    }
    return new ValidationError(
      `Google respondió con un error inesperado (${err.status}) al leer el archivo. Intenta de nuevo en unos minutos; si sigue, avisa al equipo de Cortex.`,
    );
  }
  const hasGoogle = await ctx.integrations
    .hasScopes('google', ['https://www.googleapis.com/auth/spreadsheets.readonly'])
    .catch(() => false);
  if (!hasGoogle)
    return new ValidationError(
      `Google no está conectado en esta empresa (o falta el permiso de Hojas). Conéctalo en Datos y conexiones y vuelve a pegar el enlace; ése es el único paso que no puedo hacer yo.`,
    );
  return new ValidationError(
    'No pude leer la hoja con la conexión de Google de la empresa. Revisa que el enlace sea el correcto y que la cuenta conectada tenga acceso al archivo.',
  );
}
