/**
 * LA VOZ DE CORTEX, METIDA EN EL MICRÓFONO DE LA REUNIÓN.
 *
 * ===========================================================================
 * EL TRUCO, SIMÉTRICO AL TAP DE AUDIO
 * ===========================================================================
 * Para ESCUCHAR, audio-tap.ts engancha el audio remoto por Web Audio. Para
 * HABLAR se hace lo contrario y por el mismo camino, sin PulseAudio: se
 * SUPLANTA el micrófono. `navigator.mediaDevices.getUserMedia` se sobrescribe
 * para que, cuando Meet pida el micro, reciba la pista de un
 * `MediaStreamDestination` que este script controla. Reproducir un audio en
 * ese destino = hablar en la reunión.
 *
 * Se instala como initScript ANTES de que Meet corra, para que la primera vez
 * que Meet toma el micro ya reciba nuestro destino y no el hardware. El
 * destino calla por defecto (silencio), así que hasta que Cortex hable, la
 * reunión no oye nada — un participante mudo, que es lo correcto.
 *
 * El binding `__cortexSpeak` (PCM linear16 en base64 + sampleRate) lo instala
 * Playwright con exposeBinding; aquí solo se reproduce lo que llega.
 */
export const VOICE_INJECT_SCRIPT = /* js */ `
(() => {
  if (window.__cortexVoice) return;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  // Un nodo de ganancia para poder silenciar de golpe (el botón de mute).
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(dest);

  // La pista de audio que Meet creerá que es el micrófono.
  const micTrack = dest.stream.getAudioTracks()[0];

  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    // Solo suplantamos el AUDIO. Si además pide video, se lo damos real/fake
    // como venga; nuestro bot va con cámara apagada, así que rara vez pasa.
    if (constraints && constraints.audio) {
      const stream = new MediaStream();
      stream.addTrack(micTrack);
      if (constraints.video) {
        try {
          const v = await realGUM({ video: constraints.video });
          for (const t of v.getVideoTracks()) stream.addTrack(t);
        } catch (e) { /* sin video, no pasa nada */ }
      }
      return stream;
    }
    return realGUM(constraints);
  };

  let speaking = false;

  // b64 = mp3 de Deepgram. decodeAudioData maneja el contenedor por nosotros;
  // el buffer resultante se reproduce en el destino-micro = hablar en la sala.
  async function speak(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let buf;
    try {
      buf = await ctx.decodeAudioData(bytes.buffer);
    } catch (e) { return 0; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    speaking = true;
    src.onended = () => { speaking = false; };
    if (ctx.state === 'suspended') await ctx.resume();
    src.start();
    return buf.duration;
  }

  window.__cortexVoice = {
    speak,
    mute: () => { gain.gain.value = 0; },
    unmute: () => { gain.gain.value = 1; },
    isSpeaking: () => speaking,
  };
})();
`;
