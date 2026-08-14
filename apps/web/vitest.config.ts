import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * `include` is an allowlist of the source trees rather than the default
 * `**\/*.test.ts`: the default also walks `.next`, which is build output, and a
 * test runner should never depend on whether that directory happens to exist.
 * The `@` alias mirrors tsconfig's `paths` so a test can import app modules the
 * same way the app does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` no es un paquete: es un marcador que Next resuelve durante
      // el build para que un módulo de servidor no pueda acabar en un bundle de
      // cliente. Vitest no lo conoce, así que apunta a un stub vacío — de otro
      // modo, poner el guardarraíl en un archivo lo volvería intesteable, que es
      // justo al revés de lo que se quiere.
      'server-only': fileURLToPath(new URL('./test/server-only-stub.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    // `components/` entra con el registro de renderizadores. Hasta ahora no
    // estaba, y el efecto no era que nadie hubiera escrito pruebas ahí: era que
    // escribirlas no servía de nada, porque no se habrían ejecutado. Un
    // `include` es un techo además de una lista.
    include: [
      'app/**/*.test.ts',
      'lib/**/*.test.ts',
      'inngest/**/*.test.ts',
      'components/**/*.test.ts',
    ],
  },
});
