/**
 * Del `User-Agent` crudo a «Chrome en Mac»: lo único que una persona reconoce
 * en la lista de sesiones abiertas. Sin dependencias a propósito: es una
 * lectura aproximada para mostrar, nunca para decidir nada de seguridad.
 *
 * El orden de las comprobaciones importa: Edge y Opera se anuncian también
 * como Chrome, y Chrome como Safari.
 */

export interface DeviceInfo {
  browser: string;
  os: string;
  mobile: boolean;
  /** «Chrome en Mac», o «Dispositivo desconocido» si no vino nada. */
  label: string;
}

const BROWSERS: ReadonlyArray<[RegExp, string]> = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/SamsungBrowser\//, 'Samsung Internet'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

const SYSTEMS: ReadonlyArray<[RegExp, string]> = [
  [/iPhone/, 'iPhone'],
  [/iPad/, 'iPad'],
  [/Android/, 'Android'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'Mac'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

export function describeDevice(userAgent: string | null | undefined): DeviceInfo {
  const ua = userAgent?.trim() ?? '';
  if (!ua)
    return {
      browser: 'Navegador',
      os: 'desconocido',
      mobile: false,
      label: 'Dispositivo desconocido',
    };
  const browser = BROWSERS.find(([pattern]) => pattern.test(ua))?.[1] ?? 'Navegador';
  const os = SYSTEMS.find(([pattern]) => pattern.test(ua))?.[1] ?? null;
  const mobile = /iPhone|iPad|Android|Mobile/.test(ua);
  return {
    browser,
    os: os ?? 'desconocido',
    mobile,
    label: os ? `${browser} en ${os}` : browser,
  };
}

/** El secreto de un `otpauth://totp/...?secret=ABC` en grupos de cuatro para teclearlo. */
export function secretFromTotpUri(uri: string): string | null {
  try {
    const secret = new URL(uri).searchParams.get('secret');
    return secret ? (secret.match(/.{1,4}/g)?.join(' ') ?? secret) : null;
  } catch {
    return null;
  }
}
