import { normalizeHex } from './colors';

/**
 * LA MARCA COMO LA VE UN COMPONENTE (migración 0170).
 *
 * Lo que viaja al navegador: el nombre para mostrar, la dirección del logo
 * (ya autorizada por quien la arma: con sesión adentro, con el token de la
 * vista afuera) y los dos colores. Nada más — ni la ruta interna del archivo
 * ni quién la cambió.
 *
 * Módulo puro: lo importan componentes de cliente, rutas y pruebas.
 */

export interface ViewBrand {
  /** Nombre para mostrar; si la empresa no puso uno, el del espacio. */
  name: string;
  logoUrl: string | null;
  /** `#rrggbb` o null (= el índigo de Cortex). */
  primary: string | null;
  secondary: string | null;
}

/** El logo, ya reducido en el navegador, no pasa de esto. */
export const MAX_LOGO_BYTES = 600_000;
export const LOGO_BUCKET = 'branding';
export const MAX_BRAND_NAME = 80;

export type LogoType = 'image/png' | 'image/jpeg' | 'image/webp';

/**
 * Qué imagen es, por sus primeros bytes y no por lo que diga el navegador.
 * SVG no: un SVG abierto directo en su URL ejecuta lo que traiga adentro, y el
 * logo se sirve desde el mismo dominio que la app.
 */
export function sniffLogo(bytes: Uint8Array): LogoType | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (b(0) === 0x89 && b(1) === 0x50 && b(2) === 0x4e && b(3) === 0x47) return 'image/png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'image/jpeg';
  if (
    b(0) === 0x52 &&
    b(1) === 0x49 &&
    b(2) === 0x46 &&
    b(3) === 0x46 &&
    b(8) === 0x57 &&
    b(9) === 0x45 &&
    b(10) === 0x42 &&
    b(11) === 0x50
  )
    return 'image/webp';
  return null;
}

export interface BrandInput {
  displayName: string | null;
  primary: string | null;
  secondary: string | null;
}

/** Valida lo que llega del formulario. Devuelve el error en español o los datos limpios. */
export function parseBrandInput(raw: {
  displayName?: unknown;
  primary?: unknown;
  secondary?: unknown;
}): { ok: true; value: BrandInput } | { ok: false; error: string } {
  const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  if (name.length > MAX_BRAND_NAME)
    return { ok: false, error: `El nombre no puede pasar de ${MAX_BRAND_NAME} caracteres.` };
  const color = (v: unknown, label: string) => {
    if (typeof v !== 'string' || !v.trim()) return { ok: true as const, value: null };
    const hex = normalizeHex(v);
    return hex
      ? { ok: true as const, value: hex }
      : { ok: false as const, error: `${label}: usa un color como #1F6FEB.` };
  };
  const primary = color(raw.primary, 'Color principal');
  if (!primary.ok) return primary;
  const secondary = color(raw.secondary, 'Color secundario');
  if (!secondary.ok) return secondary;
  return {
    ok: true,
    value: { displayName: name || null, primary: primary.value, secondary: secondary.value },
  };
}
