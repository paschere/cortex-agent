import 'server-only';

/**
 * Cuántos espacios de trabajo puede tener una misma cuenta.
 *
 * Vive en su propio módulo hoja por una razón mecánica y una de fondo. La
 * mecánica: `lib/organization.ts` importa el pool de `lib/auth.ts`, así que
 * `auth.ts` no puede importar de `organization.ts` sin cerrar un ciclo — y el
 * número lo necesitan los dos, porque better-auth lo aplica al crear y el
 * producto lo enseña antes de ofrecer el botón.
 *
 * La de fondo: dos copias del mismo tope se separan, y cuando se separan el
 * síntoma es de los que no se ven. Con el número del cliente más alto que el del
 * servidor, la pantalla ofrece «crear otro espacio», la persona escribe el
 * nombre y recibe un error genérico de una librería en inglés. Con el número más
 * bajo, el botón desaparece antes de tiempo y nadie sabe por qué.
 */
export const WORKSPACE_LIMIT = 5;
