/**
 * `import 'server-only'` es un marcador de Next.js, no un módulo: existe para
 * que el build FALLE si un archivo de servidor acaba en un bundle de cliente.
 * Fuera de Next nadie lo resuelve, así que vitest lo apunta aquí.
 *
 * El stub está vacío a propósito. Sustituirlo por algo que haga cualquier cosa
 * convertiría un guardarraíl del build en una dependencia de los tests.
 */
export {};
