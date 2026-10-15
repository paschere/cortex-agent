/**
 * La superficie pública de «Cortex en tu Chrome» para apps/web (rutas de la
 * extensión, Ajustes y el panel del chat). Un solo punto de entrada para que
 * la app no importe archivos sueltos de aquí dentro.
 */
export * from './consent';
export * from './credentials';
export * from './domain';
export * from './protocol';
export * from './store';
export { protectedHostsFromEnv } from './tools';
