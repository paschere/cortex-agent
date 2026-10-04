import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * El mensaje personal de quien invita, desde la ruta hasta el correo.
 *
 * ===========================================================================
 * POR QUÉ UN CONTEXTO ASÍNCRONO Y NO UN PARÁMETRO
 * ===========================================================================
 * El correo lo manda `sendInvitationEmail` (lib/auth.ts), que better-auth llama
 * DENTRO de `createInvitation`: antes de que la función devuelva el id de la
 * invitación, y por tanto antes de que el mensaje se pueda guardar atado a ese
 * id. `createInvitation` tampoco deja pasar datos extra hasta el gancho del
 * correo. La salida limpia es que quien invita deje el mensaje en el contexto
 * de la llamada y el gancho lo lea ahí; sigue a la promesa, así que dos
 * invitaciones simultáneas de dos personas no se pisan.
 *
 * Fuera de un `withInvitationMessage` (un reenvío viejo, un script) no hay
 * mensaje y el correo sale sin él: el mensaje es un extra, nunca una condición.
 */
const store = new AsyncLocalStorage<{ message: string | null }>();

export function withInvitationMessage<T>(message: string | null, fn: () => Promise<T>): Promise<T> {
  return store.run({ message: message?.trim() || null }, fn);
}

export function currentInvitationMessage(): string | null {
  return store.getStore()?.message ?? null;
}
