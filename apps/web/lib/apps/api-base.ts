/**
 * La base de las rutas /api de una pantalla de app. Un usuario externo (0209)
 * no tiene la cookie de better-auth, y el middleware sólo deja pasar sin ella
 * lo que cuelga de `/api/apps/public`; un miembro usa la ruta de siempre.
 * Las dos llegan al mismo manejador (ver app/api/apps/public/**).
 */
export function appApiBase(target: { appId: string; external?: boolean }): string {
  return target.external ? `/api/apps/public/${target.appId}` : `/api/apps/${target.appId}`;
}
