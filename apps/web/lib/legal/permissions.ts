/**
 * Quién puede qué, en la capa legal. Puro y sin imports de servidor: la
 * pantalla (cliente) decide qué botones enseña con las mismas reglas que las
 * rutas aplican. El papel es el de better-auth en la empresa (OrgRole).
 */

/** Descargar TODOS los datos de la empresa: dueño o administrador. */
export function canExportCompany(role: string): boolean {
  return role === 'owner' || role === 'admin';
}

/** Eliminar la empresa: sólo el dueño. */
export function canDeleteCompany(role: string): boolean {
  return role === 'owner';
}

/**
 * La doble confirmación del borrado: escribir el nombre de la empresa tal cual
 * (sin distinguir mayúsculas ni espacios de más). Un clic no basta para algo
 * que no se puede deshacer pasados 30 días.
 */
export function confirmsCompanyName(typed: string, name: string): boolean {
  const norm = (s: string) =>
    s.normalize('NFC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('es');
  return norm(typed).length > 0 && norm(typed) === norm(name);
}

/** Días de gracia antes de purgar una empresa. */
export const COMPANY_DELETION_GRACE_DAYS = 30;
