/**
 * EL TAP: cómo un script DENTRO de la página de Meet saca el audio de la sala.
 *
 * ===========================================================================
 * LA APUESTA DE F0, Y POR QUÉ ESTA ANTES QUE PULSEAUDIO
 * ===========================================================================
 * La forma pesada de capturar el audio de un Chromium headless es la de la
 * industria: un servidor de sonido virtual (PulseAudio) al que Chromium
 * escribe, y ffmpeg leyendo el «monitor» de ese sink. Funciona, pero arrastra
 * un demonio de sonido, permisos y un contenedor que ya no es solo un
 * navegador.
 *
 * Esta es la forma ligera, y si funciona nos ahorra todo eso: Meet reproduce
 * la voz de los demás con la Web Audio API, y esa API es interceptable DESDE
 * la propia página. `AudioContext.createMediaStreamDestination()` da un nodo
 * al que se puede enrutar cualquier audio que ya suena, y de ese destino sale
 * un MediaStream que un `MediaRecorder` corta en chunks de Opus. Sin Xvfb, sin
 * PulseAudio: el audio nunca sale de la memoria de Chromium hasta que ya es
 * Opus listo para Deepgram.
 *
 * DÓNDE PUEDE FALLAR, dicho antes de creerle: Meet podría reproducir con
 * elementos <audio> que no pasan por un AudioContext accesible, o por WebRTC
 * insertable streams fuera de alcance. Por eso F0 es binario: si el nivel de
 * audio que sale de aquí es silencio, el spike cae al plan B (PulseAudio) sin
 * discusión. La medida es el RMS del primer chunk con voz, no una opinión.
 *
 * ===========================================================================
 * EL TRUCO DEL HABLANTE, GRATIS
 * ===========================================================================
 * Diarizar audio (¿quién habló?) es caro y flojo. Meet ya lo resolvió y lo
 * pinta: el mosaico del hablante activo lleva una clase y el nombre está en el
 * DOM. Este script observa ese cambio y emite «ahora habla X» por el mismo
 * canal, para que el transcript salga atribuido por persona sin tocar el
 * audio. En F0 solo se registra que el observador engancha; F1 lo une al
 * transcript.
 */

/**
 * El script que corre en la página. Es una string y no un módulo porque se
 * evalúa dentro del navegador vía `page.evaluate` / `addInitScript`, igual que
 * `LOCATOR_INSTALL_SCRIPT` en services/browser/src/snapshot.ts. Expone dos
 * cosas en `window.__cortexTap`: arrancar la captura, y leer el nivel.
 *
 * El binding `__cortexAudioChunk` (base64 de un blob webm/opus) lo instala
 * Playwright con `exposeBinding`; aquí solo se llama.
 */
export const AUDIO_TAP_SCRIPT = /* js */ `
(() => {
  if (window.__cortexTap) return;

  const state = { started: false, peak: 0, chunks: 0, speaker: null };

  async function start() {
    if (state.started) return { ok: false, reason: 'already-started' };
    state.started = true;

    // Un AudioContext propio al que enrutar TODO lo que Meet ya está sonando.
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ctx.createMediaStreamDestination();

    // El medidor: un AnalyserNode para saber, en números, si hay señal. Es lo
    // que hace de F0 una prueba y no una esperanza.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const buf = new Float32Array(analyser.fftSize);

    // Enrutar cada <audio>/<video> con sonido que Meet cree ahora o después.
    // Meet monta un elemento por participante remoto; capturarlos a todos y
    // mezclarlos en el mismo destino da «la sala» en una sola pista.
    const wired = new WeakSet();
    function wire(el) {
      if (wired.has(el) || !el.srcObject) return;
      try {
        const src = ctx.createMediaStreamSource(el.srcObject);
        src.connect(dest);
        src.connect(analyser);
        wired.add(el);
      } catch (e) { /* una pista sin audio no se enruta; no pasa nada */ }
    }
    function sweep() {
      for (const el of document.querySelectorAll('audio, video')) wire(el);
    }
    sweep();
    setInterval(sweep, 1000);

    // El grabador: Opus en contenedor webm, chunks de 250ms. Cada chunk se
    // manda a Node en base64 — pequeño, frecuente, y en el formato que
    // Deepgram consume sin transcodificar.
    const rec = new MediaRecorder(dest.stream, { mimeType: 'audio/webm;codecs=opus' });
    rec.ondataavailable = async (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      state.chunks += 1;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      if (rms > state.peak) state.peak = rms;
      const b64 = await blobToBase64(ev.data);
      if (window.__cortexAudioChunk) window.__cortexAudioChunk({ b64, rms, speaker: state.speaker });
    };
    rec.start(250);

    watchSpeaker();
    return { ok: true };
  }

  function blobToBase64(blob) {
    return new Promise((res) => {
      const r = new FileReader();
      r.onloadend = () => res(String(r.result).split(',')[1] || '');
      r.readAsDataURL(blob);
    });
  }

  // El hablante activo, leído del DOM. Los selectores son deliberadamente
  // laxos y múltiples: Meet cambia sus clases, y aquí un fallo solo pierde la
  // atribución de una frase, no el audio. Se centraliza para repararlo en un
  // sitio, como los localizadores de trámites.
  function watchSpeaker() {
    const pick = () => {
      const speaking = document.querySelector('[data-is-speaking="true"], [class*="speaking"]');
      if (!speaking) return;
      const name = speaking.querySelector('[data-self-name], [class*="name"]')?.textContent
        || speaking.getAttribute('data-participant-id') || null;
      if (name && name !== state.speaker) state.speaker = name.trim();
    };
    new MutationObserver(pick).observe(document.body, {
      subtree: true, attributes: true, childList: true,
      attributeFilter: ['data-is-speaking', 'class'],
    });
    setInterval(pick, 500);
  }

  window.__cortexTap = {
    start,
    level: () => ({ peak: state.peak, chunks: state.chunks, speaker: state.speaker }),
  };
})();
`;
