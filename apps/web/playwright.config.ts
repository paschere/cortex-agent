import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * TODO LO QUE PLAYWRIGHT ESCRIBE, FUERA DE `apps/web`.
 *
 * No es higiene: es que `next dev` VIGILA este directorio, y ver aparecer
 * `test-results/`, trazas y una sesión guardada a mitad de una prueba le hizo
 * rehacer `.next` con el servidor sirviendo — que se traduce en un 500 en
 * `/chat` y en seis pruebas rojas detrás de una verde. Los artefactos se van a
 * un directorio temporal y el watcher deja de tener nada que mirar.
 */
const ARTIFACTS = process.env.PLAYWRIGHT_ARTIFACTS ?? join(tmpdir(), 'cortex-panel-e2e');

/**
 * LA PRUEBA QUE NO CABE EN VITEST.
 *
 * `vitest.config.ts` corre en `environment: 'node'` y en este repositorio no hay
 * jsdom: sirve para lo que se puede decidir leyendo un módulo —y
 * `components/panel/mount.test.ts` decide bastante— pero no puede contestar la
 * única pregunta de la que depende el panel entero: si abrirlo A MITAD DE UN
 * TURNO EN STREAMING deja el turno vivo. Eso necesita un navegador de verdad, un
 * `useChat` de verdad con un `fetch` en vuelo, y React montando y desmontando.
 *
 * Por eso este archivo existe y por eso hay uno solo: `@playwright/test` ya era
 * dependencia y `pnpm test:e2e` ya estaba en los scripts, pero sin configuración
 * no corría nada.
 *
 * NO LEVANTA EL SERVIDOR. `next dev` con este monorepo tarda lo suyo y la base
 * de datos local hay que tenerla arriba de todos modos; un `webServer` que
 * arranca y muere por prueba haría este archivo más lento y más frágil de lo que
 * resuelve. Ver `e2e/README.md` para los tres comandos que hacen falta antes.
 */
export default defineConfig({
  testDir: './e2e',
  outputDir: join(ARTIFACTS, 'output'),
  // Un turno goteado dura segundos a propósito: la prueba necesita que el
  // stream siga abierto mientras se abre el panel.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // En serie: las pruebas comparten la misma organización sembrada, y dos
  // navegadores escribiendo en la misma cola se pisan.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3003',
    trace: 'retain-on-failure',
    // El panel ancho sólo existe por encima de `lg`; la hoja, por debajo. Cada
    // prueba que mire la hoja cambia el tamaño ella misma.
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        storageState: join(ARTIFACTS, 'user.json'),
      },
    },
  ],
});
