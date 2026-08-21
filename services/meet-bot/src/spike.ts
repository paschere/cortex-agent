/**
 * F0 — ¿un Playwright (como Vexa) puede unirse a un Google Meet real y sacar audio?
 *
 *     MEET_URL="https://meet.google.com/xxx-xxxx-xxx" \
 *     BOT_NAME="Cortex (notas)" \
 *     pnpm --filter @cortex/meet-bot spike
 */
import { writeFileSync } from 'node:fs';
import { AUDIO_TAP_SCRIPT } from './audio-tap';
import { type BotConfig, joinGoogleMeeting, waitForGoogleMeetingAdmission } from './join';
import { launchPersistentBrowser } from './stealth';

const MEET_URL = process.env.MEET_URL;
const BOT_NAME = process.env.BOT_NAME || 'Cortex (notas)';
const LISTEN_MS = Number(process.env.LISTEN_MS || 30_000);
const SIGNAL_FLOOR = Number(process.env.SIGNAL_FLOOR || 0.002);

function log(msg: string): void {
  console.log(`[spike] ${msg}`);
}

async function main(): Promise<void> {
  if (!MEET_URL) {
    console.error('[spike] MEET_URL no está puesto. No hay reunión a la que entrar.');
    process.exit(1);
  }

  const profileDir = process.env.PROFILE_DIR || '/tmp/cortex-meet-profile';
  const { context, page } = await launchPersistentBrowser(profileDir);

  const chunks: Buffer[] = [];
  let peakRms = 0;
  let chunkCount = 0;
  let lastSpeaker: string | null = null;

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

  log(`entrando a ${MEET_URL} como «${BOT_NAME}» (join de Vexa)`);
  const botConfig: BotConfig = {
    platform: 'google_meet',
    botName: BOT_NAME,
    authenticated: false,
    uiInteractionMode: process.env.MEET_UI_MODE === 'synthetic' ? 'synthetic' : 'humanized',
    automaticLeave: { waitingRoomTimeout: 180_000 },
  };

  await joinGoogleMeeting(page, MEET_URL, BOT_NAME, botConfig);
  const admitted = await waitForGoogleMeetingAdmission(page, 180_000, botConfig);
  if (!admitted) {
    log('❌ no me admitieron. Reintenta con alguien admitiendo.');
    await context.close();
    process.exit(3);
  }
  log('✅ DENTRO de la reunión');

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

  if (chunks.length > 0) {
    const out = `/tmp/cortex-meet-spike-${Date.now()}.webm`;
    writeFileSync(out, Buffer.concat(chunks));
    log(`muestra guardada: ${out} (${(Buffer.concat(chunks).length / 1024).toFixed(0)} KB)`);
  }

  const pass = peakRms >= SIGNAL_FLOOR && chunkCount > 0;
  log('─'.repeat(48));
  log(`VEREDICTO: ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
  log(`  chunks capturados: ${chunkCount}`);
  log(`  pico RMS: ${peakRms.toFixed(4)} (piso ${SIGNAL_FLOOR})`);

  await context.close();
  process.exit(pass ? 0 : 2);
}

void main().catch((err) => {
  console.error('[spike] el spike se cayó:', (err as Error).message);
  process.exit(1);
});
