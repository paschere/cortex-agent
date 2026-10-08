/**
 * EL ERROR DE LEER UN ESTADO DEL PROGRAMA CONTABLE, EN CRISTIANO (0191). Puro.
 *
 * Un fallo de código («Cannot read properties of undefined…») o de red nunca
 * le llega al dueño tal cual: le sirve un mensaje humano con qué hacer, y el
 * detalle técnico se queda en el log. Los mensajes que ya escribió la propia
 * integración en español (llave vencida, límite de uso…) sí pasan.
 */

/** Frases típicas de un fallo de JavaScript, de red o de análisis de datos. */
const TECHNICAL =
  /cannot read propert|cannot destructure|is not a function|is not defined|is not iterable|undefined|\bnull\b|unexpected token|unexpected end|JSON|\bTypeError\b|\bReferenceError\b|\bSyntaxError\b|\bRangeError\b|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang|\bat \S+ \(|\bstack\b|\[object /i;

/** Fallos de código: se reconocen antes que cualquier otra causa. */
const CODE_BUG =
  /cannot read propert|cannot destructure|is not a function|is not defined|is not iterable|undefined|unexpected token|unexpected end|\b(TypeError|ReferenceError|SyntaxError|RangeError)\b|\[object /i;

const AUTH = /\b(401|403)\b|unauthori[sz]ed|forbidden|credencial|llave|token|permiso/i;
const LIMIT = /\b429\b|rate limit|too many|l[ií]mite/i;
const DOWN = /\b(5\d\d)\b|timeout|timed out|ETIMEDOUT|ECONN|ENOTFOUND|fetch failed|socket hang/i;

export interface HumanReportError {
  /** Lo que ve el dueño. */
  message: string;
  /** Lo que se escribe en el log (el original). */
  detail: string;
  /** Falló por nuestro lado o por un formato inesperado, no por algo que el dueño arregle. */
  technical: boolean;
}

function detailOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err) ?? 'error';
  } catch {
    return 'error';
  }
}

/**
 * @param what  «el balance general», «el estado de resultados»…
 * @param provider  «Siigo», «Alegra»…
 */
export function humanReportError(err: unknown, what: string, provider: string): HumanReportError {
  const detail = detailOf(err);
  if (CODE_BUG.test(detail)) return technicalError(detail, what, provider);
  if (LIMIT.test(detail))
    return {
      message: `${provider} pidió esperar un momento antes de entregar ${what}. Vuelve a intentar en unos minutos.`,
      detail,
      technical: false,
    };
  if (AUTH.test(detail))
    return {
      message: `${provider} no dejó leer ${what}: revisa que la conexión siga vigente en Integraciones y vuelve a intentar.`,
      detail,
      technical: false,
    };
  if (DOWN.test(detail))
    return {
      message: `${provider} no contestó a tiempo al pedir ${what}. Vuelve a intentar en unos minutos.`,
      detail,
      technical: false,
    };
  if (TECHNICAL.test(detail) || detail.length > 220) return technicalError(detail, what, provider);
  return {
    message: `No pude leer ${what} de ${provider}: ${detail.replace(/\.$/, '')}.`,
    detail,
    technical: false,
  };
}

function technicalError(detail: string, what: string, provider: string): HumanReportError {
  return {
    message: `No pude leer ${what} de ${provider}: el reporte llegó en un formato que no esperaba. Ya quedó registrado para revisarlo; mientras tanto se muestra lo que Cortex sabe por su cuenta. Puedes volver a intentar en unos minutos.`,
    detail,
    technical: true,
  };
}
