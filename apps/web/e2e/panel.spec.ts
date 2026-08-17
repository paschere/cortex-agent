import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Page, expect, test } from '@playwright/test';

/**
 * LA PREMISA DEL PANEL, EN UN NAVEGADOR DE VERDAD.
 *
 * ===========================================================================
 * QUÉ SE ESTÁ PROBANDO, Y POR QUÉ NO BASTABA CON `mount.test.ts`
 * ===========================================================================
 * `components/panel/mount.test.ts` lee `AppShell.tsx` y comprueba la FORMA del
 * árbol: que `PanelProvider` reciba `{children}` como prop y que `PanelHost` sea
 * su hermano. Eso es lo que hace que el mecanismo sea correcto, y se puede leer.
 *
 * Lo que no se puede leer es el resultado: que con un `fetch` a medio consumir,
 * abrir el panel no interrumpa la respuesta ni borre lo ya escrito. Esa es LA
 * premisa de todo el diseño —si falla, el panel cambia una forma de perder la
 * conversación por otra— y sólo la contesta un navegador con React montando de
 * verdad.
 *
 * ===========================================================================
 * EL TURNO ES SIMULADO, Y ESO ES LO CORRECTO AQUÍ
 * ===========================================================================
 * `window.fetch` se sustituye SÓLO para `POST /api/chat` y devuelve un
 * `ReadableStream` que gotea el protocolo de datos del AI SDK. No se llama a
 * Anthropic, y no por ahorrar: una respuesta real tarda lo que le da la gana y
 * termina cuando quiere, y esta prueba necesita que el stream siga abierto en un
 * instante EXACTO — el instante en que se abre el panel. Un turno que se cierra
 * antes de tiempo convertiría la prueba en verde sin haber probado nada.
 *
 * Lo simulado es la RESPUESTA. Todo lo demás es el producto: el mismo
 * `ChatRoot`, el mismo `useChat`, el mismo `PanelProvider`, el mismo rail y la
 * misma ruta `/api/panel` contra la base de datos local.
 *
 * ===========================================================================
 * CÓMO SE DETECTA UN DESMONTAJE SIN TOCAR `ChatRoot`
 * ===========================================================================
 * Se guarda una REFERENCIA al nodo del compositor en `window` y luego se
 * comprueba que el nodo que hay en la página sigue siendo ESE objeto y que sigue
 * conectado al documento. React no reutiliza el DOM de un componente que
 * desmonta: si `ChatRoot` se hubiera remontado, `document.querySelector`
 * devolvería un nodo distinto y el guardado estaría desconectado. Es la misma
 * pregunta que un contador de montajes, hecha desde fuera — que es donde hay que
 * hacerla, porque el archivo que se está protegiendo no debe enterarse de que
 * existe esta prueba.
 */

const SHOTS = process.env.PANEL_SHOTS ?? join(process.cwd(), 'test-results', 'panel');
mkdirSync(SHOTS, { recursive: true });
const shot = (name: string) => join(SHOTS, `panel1-${name}.png`);

/** Lo que el turno falso acaba diciendo, entero. */
const CHUNKS = [
  'Miré la cartera: ',
  'quedan 69,85 millones ',
  'abiertos en cuatro facturas, ',
  'con 28,5 vencidos ',
  'en una sola. ',
  'La más vieja es la FV-2201 ',
  'de Andina, ',
  'que ya lleva 45 días ',
  'y sólo tiene un abono de veinte. ',
  '¿Le escribo al contacto?',
];
const FULL = CHUNKS.join('');

/**
 * Sustituye `POST /api/chat` por un stream goteado.
 *
 * El resto de rutas bajo `/api/chat/...` —seguimientos, vigilancia, aperturas—
 * pasan intactas: se compara el `pathname` completo, no un `includes`, porque
 * interceptar de más convertiría esto en una prueba de un navegador imaginario.
 *
 * `window.__turn` cuenta lo que ha salido para que la prueba pueda pararse
 * exactamente a mitad en vez de dormir un número inventado de milisegundos.
 */
async function dripStreamingTurn(page: Page, opts: { conversationId?: string } = {}) {
  await page.addInitScript(
    ({ chunks, gapMs, conversationId }) => {
      const state = { sent: 0, finished: false, aborted: false };
      (window as unknown as { __turn: typeof state }).__turn = state;

      const original = window.fetch.bind(window);
      window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const href =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = new URL(href, window.location.origin).pathname;
        const method = (
          init?.method ??
          (typeof input === 'object' && 'method' in input ? input.method : 'GET')
        ).toUpperCase();

        if (path !== '/api/chat' || method !== 'POST') return original(input, init);

        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            let i = 0;
            const tick = () => {
              if (init?.signal?.aborted) {
                state.aborted = true;
                controller.close();
                return;
              }
              if (i < chunks.length) {
                // `0:` es una parte de texto en el protocolo de datos del AI SDK.
                controller.enqueue(encoder.encode(`0:${JSON.stringify(chunks[i])}\n`));
                i += 1;
                state.sent = i;
                setTimeout(tick, gapMs);
                return;
              }
              const usage = { promptTokens: 0, completionTokens: 0 };
              controller.enqueue(
                encoder.encode(
                  `e:${JSON.stringify({ finishReason: 'stop', usage, isContinued: false })}\n`,
                ),
              );
              controller.enqueue(
                encoder.encode(`d:${JSON.stringify({ finishReason: 'stop', usage })}\n`),
              );
              state.finished = true;
              controller.close();
            };
            setTimeout(tick, gapMs);
          },
        });

        const headers = new Headers({
          'Content-Type': 'text/plain; charset=utf-8',
          'x-vercel-ai-data-stream': 'v1',
        });
        if (conversationId) headers.set('X-Conversation-Id', conversationId);
        return Promise.resolve(new Response(body, { status: 200, headers }));
      };
    },
    { chunks: CHUNKS, gapMs: 350, conversationId: opts.conversationId ?? null },
  );
}

/** Guarda el nodo del compositor para poder preguntar después si es el mismo. */
async function markChatSubtree(page: Page) {
  await page.evaluate(() => {
    const node = document.querySelector('textarea');
    if (!node) throw new Error('no hay compositor que marcar');
    (window as unknown as { __probe: Element }).__probe = node;
  });
}

/** `true` si el compositor sigue siendo el mismo nodo vivo que antes. */
function chatSurvived(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const probe = (window as unknown as { __probe?: Element }).__probe;
    return Boolean(probe && probe.isConnected && probe === document.querySelector('textarea'));
  });
}

const composer = (page: Page) => page.getByPlaceholder(/Pregunta por una llamada/);
const railRow = (page: Page, name: RegExp) => page.getByRole('link', { name });

// ---------------------------------------------------------------------------

test('abrir el panel a mitad de un turno en streaming no mata el turno', async ({ page }) => {
  await dripStreamingTurn(page);
  await page.goto('/chat');
  await expect(composer(page)).toBeVisible();
  await markChatSubtree(page);

  await composer(page).fill('¿Cómo va la cartera?');
  await composer(page).press('Enter');

  // A MITAD: han salido unos cuantos trozos y faltan otros tantos.
  await page.waitForFunction(() => {
    const turn = (window as unknown as { __turn: { sent: number; finished: boolean } }).__turn;
    return turn.sent >= 3 && !turn.finished;
  });
  const partial = await page.evaluate(() => document.body.innerText);
  expect(partial, 'el turno tiene que estar a medias, no terminado').not.toContain(
    '¿Le escribo al contacto?',
  );

  // El clic que antes costaba la conversación.
  await railRow(page, /Cartera/).click();
  await expect(page.getByRole('complementary', { name: 'Cartera' })).toBeVisible();

  // Con el panel abierto, el stream tiene que seguir goteando hasta el final.
  await page.waitForFunction(
    () => (window as unknown as { __turn: { finished: boolean } }).__turn.finished,
  );
  await expect(page.getByText('¿Le escribo al contacto?')).toBeVisible();

  const turn = await page.evaluate(
    () => (window as unknown as { __turn: { aborted: boolean } }).__turn,
  );
  expect(turn.aborted, 'el fetch del turno no puede haberse abortado').toBe(false);

  // Y lo escrito antes de abrir el panel sigue ahí, con el turno entero.
  await expect(page.getByText('¿Cómo va la cartera?')).toBeVisible();
  await expect(page.getByText(FULL)).toBeVisible();

  expect(await chatSurvived(page), 'ChatRoot se remontó al abrir el panel').toBe(true);

  // Y cerrarlo tampoco lo desmonta.
  await page.getByRole('button', { name: 'Cerrar el panel' }).click();
  await expect(page.getByRole('complementary', { name: 'Cartera' })).toBeHidden();
  expect(await chatSurvived(page), 'ChatRoot se remontó al cerrar el panel').toBe(true);
  await expect(page.getByText(FULL)).toBeVisible();
});

test('la dirección del chat se reescribe sin llevarse el panel', async ({ page }) => {
  // Con `X-Conversation-Id`, `ChatRoot` pasa de `/chat` a `/chat/<id>` a mitad
  // de stream con `history.replaceState`. Esa reescritura tiene que conservar
  // `?panel=`, que es de quien está al lado.
  const conversationId = '11111111-2222-4333-8444-555555555555';
  await dripStreamingTurn(page, { conversationId });
  // El panel se abre por la dirección y no por el rail: «Vencimientos» vive
  // dentro del grupo plegable «Te espera», y esta prueba no es sobre el rail.
  await page.goto('/chat?panel=commitments');
  await expect(composer(page)).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Vencimientos' })).toBeVisible();

  await composer(page).fill('¿Qué se vence esta semana?');
  await composer(page).press('Enter');
  await page.waitForFunction(
    () => (window as unknown as { __turn: { finished: boolean } }).__turn.finished,
  );

  await expect(page).toHaveURL(new RegExp(`/chat/${conversationId}\\?panel=commitments`));
  await expect(page.getByRole('complementary', { name: 'Vencimientos' })).toBeVisible();
});

test('el panel sobrevive al refresco porque vive en la dirección', async ({ page }) => {
  await page.goto('/chat?panel=approvals');
  await expect(page.getByRole('complementary', { name: 'Aprobaciones' })).toBeVisible();
  await expect(page.getByText(/esperando tu permiso|acciones pa/i).first()).toBeVisible();
});

test('en el chat el rail abre el panel; con ⌘ sigue navegando', async ({ page }) => {
  await page.goto('/chat');
  await expect(composer(page)).toBeVisible();

  // Un borrador a medio escribir es lo más barato de perder y lo más molesto.
  await composer(page).fill('acuérdate de esto');
  await markChatSubtree(page);

  await railRow(page, /Informes/).click();
  await expect(page.getByRole('complementary', { name: 'Informes' })).toBeVisible();
  await expect(page).toHaveURL(/\?panel=reports/);
  expect(await chatSurvived(page)).toBe(true);
  await expect(composer(page)).toHaveValue('acuérdate de esto');

  // El mismo destino con ⌘: la fila sigue siendo un enlace de verdad, así que
  // el navegador hace lo de siempre y abre una pestaña. Que ESTO siga
  // funcionando es la razón por la que la fila no se convirtió en un `<button>`.
  const [tab] = await Promise.all([
    page.context().waitForEvent('page'),
    railRow(page, /Informes/).click({ modifiers: ['Meta'] }),
  ]);
  // La pestaña nace en `about:blank` y navega un tick después.
  await tab.waitForURL(/\/reports$/, { timeout: 30_000 });
  await tab.close();

  // Y la pestaña de al lado no se llevó por delante ni el chat ni el panel.
  expect(await chatSurvived(page)).toBe(true);
  await expect(page.getByRole('complementary', { name: 'Informes' })).toBeVisible();

  // Fuera del chat el rail vuelve a ser un rail: la fila navega, sin panel.
  await page.goto('/reports');
  await railRow(page, /Cartera/).click();
  await page.waitForURL(/\/payments$/, { timeout: 30_000 });
  await expect(page.getByRole('complementary', { name: 'Cartera' })).toBeHidden();
});

test('⌘\\ abre y cierra el panel sin tocar el ratón', async ({ page }) => {
  await page.goto('/chat');
  await expect(composer(page)).toBeVisible();

  await page.keyboard.press('Meta+\\');
  await expect(page.getByRole('complementary', { name: 'Cartera' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(page.getByRole('complementary', { name: 'Cartera' })).toBeHidden();
});

test('los cinco paneles de v1 traen datos, y se ven', async ({ page }) => {
  // Cada frase es de los DATOS, nunca del marco: «Cartera» también es el título
  // del panel, y una prueba que se conforme con eso da verde con el esqueleto de
  // carga en pantalla — que es exactamente lo que pasó la primera vez.
  const expected: Array<[string, string, RegExp]> = [
    ['payments', 'Cartera', /69\.850\.000/],
    ['commitments', 'Vencimientos', /póliza/i],
    ['errands', 'Encargos', /SECOP/i],
    ['reports', 'Informes', /Vencimientos de la flota|Resumen semanal/i],
    ['approvals', 'Aprobaciones', /correo|gmail/i],
  ];

  for (const [id, title, content] of expected) {
    await page.goto(`/chat?panel=${id}`);
    const panel = page.getByRole('complementary', { name: title });
    await expect(panel).toBeVisible();
    // Ya no está cargando: sin esto la captura sale con los cuatro huesos.
    await expect(panel.locator('[aria-busy="true"]')).toHaveCount(0);
    await expect(panel.getByText(content).first()).toBeVisible();
    // La puerta a la pantalla completa está en todos.
    await expect(panel.getByRole('link', { name: /Ver todo/ })).toBeVisible();
    await page.screenshot({ path: shot(`escritorio-${id}`), fullPage: false });
  }
});

test('bajo lg el panel es una hoja a pantalla completa', async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto('/chat?panel=commitments');

  // La hoja es un diálogo de Radix: atrapa el foco porque sí tapa lo de debajo.
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('[aria-busy="true"]')).toHaveCount(0);
  await expect(sheet.getByText(/póliza/i).first()).toBeVisible();
  await page.screenshot({ path: shot('hoja-movil'), fullPage: false });

  await page.getByRole('button', { name: 'Cerrar el panel' }).click();
  await expect(sheet).toBeHidden();
});

test('el rail en modo chat, retratado', async ({ page }) => {
  await page.goto('/chat');
  await expect(composer(page)).toBeVisible();
  await page.screenshot({ path: shot('rail-en-chat'), fullPage: false });
});
