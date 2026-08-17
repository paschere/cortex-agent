import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test as setup } from '@playwright/test';
import { seedPanelData } from './seed';

/**
 * LA SESIÓN, UNA VEZ, POR LA PUERTA DE VERDAD.
 *
 * Se entra por `/api/auth/sign-in/email` en lugar de rellenar el formulario:
 * lo que estas pruebas vigilan es el panel, y una pantalla de acceso rota
 * debería fallar en su propia prueba, no en todas. Si la cuenta no existe se
 * crea — el registro está abierto en local y `ALLOWED_EMAIL_DOMAIN` viene vacío.
 *
 * La primera petición autenticada es la que aprovisiona el espacio de trabajo
 * (`requireSession` lo hace bajo demanda), así que se hace aquí y no dentro de
 * una prueba: aprovisionar tarda, y hacerlo a mitad de un `test` mete veinte
 * segundos de ruido en una medida que va de milisegundos.
 */

const EMAIL = process.env.E2E_EMAIL ?? 'panel.e2e@cortex.test';
const PASSWORD = process.env.E2E_PASSWORD ?? 'PanelE2E-2026!';

setup('entrar y guardar la sesión', async ({ page }) => {
  const credentials = { email: EMAIL, password: PASSWORD, name: 'Panel E2E' };

  // `page.request` y no el `request` suelto: sólo el primero comparte las
  // cookies con la pestaña, que es todo el objetivo de este archivo.
  const signIn = await page.request.post('/api/auth/sign-in/email', { data: credentials });
  if (!signIn.ok()) {
    const signUp = await page.request.post('/api/auth/sign-up/email', { data: credentials });
    expect(signUp.ok(), `no se pudo crear ${EMAIL}: ${await signUp.text()}`).toBeTruthy();
  }

  // Las cookies quedan en el contexto de `request`, que es el mismo del `page`.
  // Una carga real las convierte en sesión aprovisionada.
  await page.goto('/chat');
  await expect(page.getByPlaceholder(/Pregunta por una llamada/)).toBeVisible();

  // Fuera de `apps/web` a propósito: `next dev` vigila ese directorio y un
  // fichero nuevo a mitad de una prueba le costaba el `.next` entero. Ver la
  // cabecera de `playwright.config.ts`.
  const artifacts = process.env.PLAYWRIGHT_ARTIFACTS ?? join(tmpdir(), 'cortex-panel-e2e');
  await page.context().storageState({ path: join(artifacts, 'user.json') });

  // Los datos que los cinco paneles enseñan, en el espacio de trabajo que
  // acaba de aprovisionarse. Después de la sesión porque hasta ahora no había
  // espacio en el que sembrar. Ver `e2e/seed.ts`.
  await seedPanelData(EMAIL);
});
