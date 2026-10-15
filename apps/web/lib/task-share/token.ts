import { createHash, randomBytes } from 'node:crypto';

/**
 * El token del enlace. Aparte de `shape.ts` a propósito: `node:crypto` no puede
 * entrar al paquete del navegador y `shape.ts` lo importa un componente cliente.
 */

export function mintShareToken(): string {
  return randomBytes(24).toString('base64url');
}

/** De la clave sólo se guarda su hash: la base no puede abrir el enlace. */
export function hashShareToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
