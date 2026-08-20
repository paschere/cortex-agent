/**
 * F0 — EL SPIKE QUE DECIDE SI «CORTEX EN LA SALA» EXISTE.
 *
 * Pregunta binaria: ¿un Chromium controlado puede unirse a un Google Meet real
 * y sacar audio USABLE de la sala? Todo lo demás del plan es trabajo conocido;
 * esto es la única incógnita, así que se responde antes de gastar un día en lo
 * que la depende.
 *
 * Cómo se corre (con el Chromium de services/browser, que ya está instalado):
 *
 *     MEET_URL="https://meet.google.com/xxx-xxxx-xxx" \
 *     BOT_NAME="Cortex (notas)" \
 *     node services/meet-bot/dist/spike.js
 *
 * Qué hace: abre el link, pone el nombre del bot, apaga cámara y micrófono,
 * pide unirse, y una vez dentro instala el tap de audio (audio-tap.ts) y mide
 * el RMS del audio que sale durante ~30 s. Imprime un veredicto:
 *
 *     PASS  — llegó audio con señal (RMS pico por encima del piso de ruido).
 *             El tap ligero sirve; F1 se construye sobre él.
 *     FAIL  — silencio. El tap por Web Audio no alcanza en esta versión de
 *             Meet; F1 arranca con el plan B (Xvfb + PulseAudio + ffmpeg).
 *
 * No sube nada, no habla, no graba a disco salvo un .webm de muestra para
 * oírlo con oídos humanos. Es una prueba, y se comporta como una.
 */

import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { AUDIO_TAP_SCRIPT } from './audio-tap';

const MEET_URL = process.env.MEET_URL;
const BOT_NAME = process.env.BOT_NAME || 'Cortex (notas)';
const LISTEN_MS = Number(process.env.LISTEN_MS || 30_000);
/** Piso de RMS bajo el cual lo llamamos silencio. Conservador. */
const SIGNAL_FLOOR = Number(process.env.SIGNAL_FLOOR || 0.002);

function log(msg: string): void {
  console.log(`[spike] ${msg}`);
}

async function main(): Promise<void> {
  if (!MEET_URL) {
    console.error('[spike] MEET_URL no está puesto. No hay reunión a la que entrar.');
    process.exit(1);
  }

  // Headed=false pero con audio: los flags fake-* NO se usan aquí a propósito
  // —queremos el audio REAL de la sala— pero sí se conceden los permisos de
  // medios para que Meet no se pare a pedirlos.
  // POR QUÉ CHROME REAL Y NO EL CHROMIUM DE PLAYWRIGHT: Meet exige códecs
  // propietarios (H.264/AAC) y Widevine que el Chromium pelado no trae, y sin
  // ellos rebota al navegador con «no puedes unirte» ANTES de la pre-sala.
  // El canal 'chrome' usa el Google Chrome instalado, que sí los tiene.
  //
  // HEADFUL (headless:false) a propósito para el spike: Meet degrada a los
  // clientes headless, y aquí queremos la ruta feliz para aislar la incógnita
  // real (el audio). En producción esto corre bajo Xvfb, que es headful ante
  // los ojos de Meet sin abrir una ventana de verdad.
  // POR QUÉ PERSISTENT CONTEXT Y NO launch+newContext: Meet detecta el
  // navegador AUTOMATIZADO y lo rebota en duro con «no puedes unirte» ANTES de
  // la sala de espera — un incógnito humano en la misma reunión SÍ pasa. Un
  // contexto persistente sobre un perfil de disco se comporta como un Chrome
  // de verdad (no como uno instrumentado por CDP), que es la diferencia que
  // Meet está mirando. Chrome real (canal 'chrome') por sus códecs H.264/AAC.
  const HEADFUL = process.env.HEADFUL !== '0';
  const profileDir = process.env.PROFILE_DIR || '/tmp/cortex-meet-profile';
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: !HEADFUL,
    permissions: ['microphone', 'camera'],
    locale: 'es-CO',
    timezoneId: 'America/Bogota',
    viewport: { width: 1280, height: 800 },
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
      // Quita el infobar y la marca de automatización que Meet sniffa.
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process,AutomationControlled',
      '--start-maximized',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Borrar las huellas que quedan aunque el flag esté puesto: navigator.webdriver
  // y el objeto de automatización. Se instala ANTES de que corra cualquier
  // script de la página, para que Meet lea un navegador normal.
  await context.addInitScript(`
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    window.chrome = window.chrome || { runtime: {} };
    Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-CO','es','en'] });
  `);

  const chunks: Buffer[] = [];
  let peakRms = 0;
  let chunkCount = 0;
  let lastSpeaker: string | null = null;

  const page = context.pages()[0] || (await context.newPage());

  // El canal por el que el tap manda cada chunk de audio a Node.
  await context.exposeBinding(
    '__cortexAudioChunk',
    (_src, payload: { b64: string; rms: number; speaker: string | null }) => {
      chunkCount += 1;
      if (payload.rms > peakRms) peakRms = payload.rms;
      if (payload.speaker && payload.speaker !== lastSpeaker) {
        lastSpeaker = payload.speaker;
        log(`hablante: ${payload.speaker}`);
      }
      if (payload.b64) chunks.push(Buffer.from(payload.b64, 'base64'));
    },
  );

  log(`entrando a ${MEET_URL} como «${BOT_NAME}»`);
  await page.goto(MEET_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(5_000);

  // DIAGNÓSTICO F0: qué pantalla nos muestra Meet de verdad. Un screenshot y
  // el texto visible dicen más que cualquier suposición sobre el flujo.
  const shot = `/tmp/cortex-meet-state-${Date.now()}.png`;
  await page.screenshot({ path: shot, fullPage: false }).catch(() => undefined);
  const visibleText = await page
    .evaluate('document.body ? document.body.innerText.slice(0, 800) : "(body vacío)"')
    .catch(() => '(no se pudo leer)');
  const buttons = await page
    .evaluate(
      `Array.from(document.querySelectorAll('button, [role=button]')).map(b => (b.innerText||b.getAttribute('aria-label')||'').trim()).filter(Boolean).slice(0, 25)`,
    )
    .catch(() => []);
  log(`URL ahora: ${page.url()}`);
  log(`screenshot: ${shot}`);
  log(`TEXTO VISIBLE:\n${visibleText}`);
  log(`BOTONES: ${JSON.stringify(buttons)}`);

  // Meet en pre-sala: nombre + apagar cámara/micro + unirse. Los selectores
  // son laxos y se prueban en orden; si el flujo cambió, esto es lo que se
  // repara, en un sitio.
  await page.waitForTimeout(4_000);

  // Nombre (solo aparece sin sesión iniciada). Meet lo etiqueta de varias
  // formas según idioma/versión; se prueban en orden.
  // El campo «¿Cómo te llamas?» de la sala de invitado. Esperarlo explícito:
  // la pre-sala tarda en montar y un fill sobre un input que aún no existe se
  // pierde en silencio (fue el 0/60 del intento anterior).
  const nameField = page.locator('input[type="text"]').first();
  const gotField = await nameField
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (gotField) {
    await nameField.click().catch(() => undefined);
    await nameField.pressSequentially(BOT_NAME, { delay: 40 }).catch(() => undefined);
    log(`nombre de invitado escrito: «${BOT_NAME}»`);
  } else {
    log('no apareció el campo de nombre en 15s');
  }
  await page.waitForTimeout(800);

  // Apagar cámara y micro antes de entrar, por sus botones (los atajos roban
  // el foco al input de nombre). Un bot que entra transmitiendo es maleducado.
  for (const label of ['Desactivar cámara', 'Desactivar micrófono']) {
    await page
      .locator(`[aria-label="${label}"]`)
      .first()
      .click({ timeout: 2_000 })
      .catch(() => undefined);
  }

  // Pedir unirse.
  const joinBtn = page
    .locator(
      'button:has-text("Solicitar unirse"), button:has-text("Ask to join"), button:has-text("Unirte ahora"), button:has-text("Join now"), button:has-text("Unirte"), button:has-text("Pedir")',
    )
    .first();
  if (await joinBtn.count().catch(() => 0)) {
    await joinBtn.click().catch(() => undefined);
    log('solicitud de entrada enviada — admíteme en la reunión si te lo pide');
  } else {
    log('no encontré el botón de unirse; el flujo de Meet pudo cambiar');
  }

  // Esperar a estar DENTRO. La sala aparece cuando un humano admite al bot;
  // damos 2 minutos y avisamos cada 15s que seguimos tocando la puerta.
  log('⏳ ESPERANDO ADMISIÓN — entra a la reunión y admite a «Cortex» (hasta 2 min)');
  let inRoom = false;
  const admitDeadline = Date.now() + 120_000;
  while (Date.now() < admitDeadline) {
    inRoom = await page
      .locator('[aria-label*="Abandonar"], [aria-label*="Leave call"], button[aria-label*="Salir"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (inRoom) break;
    await page.waitForTimeout(3_000);
  }

  if (!inRoom) {
    log(
      '❌ no me admitieron en 2 min. La incógnita del audio queda sin responder — reintenta con alguien admitiendo.',
    );
    await context.close();
    process.exit(3);
  }
  log('✅ DENTRO de la reunión');

  // Instalar el tap y arrancar la captura, blindado: si la página cambió o el
  // tap no montó, se dice, no se cae.
  await page.evaluate(AUDIO_TAP_SCRIPT).catch(() => undefined);
  const started = await page
    .evaluate('(window.__cortexTap && window.__cortexTap.start()) || {ok:false,reason:"sin tap"}')
    .catch((e: Error) => ({ ok: false, reason: e.message }));
  log(`tap de audio: ${JSON.stringify(started)}`);

  log(`🎧 escuchando ${Math.round(LISTEN_MS / 1000)}s — que alguien hable en la sala…`);
  const step = 5_000;
  for (let waited = 0; waited < LISTEN_MS; waited += step) {
    await page.waitForTimeout(step);
    const level = (await page
      .evaluate('(window.__cortexTap && window.__cortexTap.level()) || {peak:0,chunks:0}')
      .catch(() => ({ peak: 0, chunks: 0 }))) as { peak: number; chunks: number };
    log(
      `  ${Math.round((waited + step) / 1000)}s · chunks=${level.chunks} · pico RMS=${level.peak.toFixed(4)}`,
    );
  }

  // Guardar una muestra para oírla con oídos humanos: el número dice que hay
  // señal, pero un .webm dice si es LA reunión y no un zumbido.
  if (chunks.length > 0) {
    const out = `/tmp/cortex-meet-spike-${Date.now()}.webm`;
    writeFileSync(out, Buffer.concat(chunks));
    log(`muestra guardada: ${out} (${(Buffer.concat(chunks).length / 1024).toFixed(0)} KB)`);
  }

  // El veredicto.
  const pass = peakRms >= SIGNAL_FLOOR && chunkCount > 0;
  log('─'.repeat(48));
  log(`VEREDICTO: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  log(`  chunks capturados: ${chunkCount}`);
  log(`  pico RMS: ${peakRms.toFixed(4)} (piso ${SIGNAL_FLOOR})`);
  log(
    pass
      ? '  El tap ligero por Web Audio saca audio de la sala. F1 se construye sobre esto.'
      : '  Silencio por el tap ligero. F1 arranca con el plan B: Xvfb + PulseAudio + ffmpeg.',
  );

  await context.close();
  process.exit(pass ? 0 : 2);
}

void main().catch((err) => {
  console.error('[spike] el spike se cayó:', (err as Error).message);
  process.exit(1);
});
