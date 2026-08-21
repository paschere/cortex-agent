/**
 * EL TAP: cómo un script DENTRO de la página de Meet saca el audio de la sala.
 *
 * PCM linear16 a 16 kHz, no WebM. MediaRecorder en timeslices manda el header
 * solo en el primer blob; Deepgram transcribe esa frase y luego se queda
 * ciego (o con varios segundos de retraso). El ScriptProcessor emite PCM
 * continuo: cada reconexión de Deepgram sigue entendiendo los bytes.
 *
 * Las pistas remotas se enganchan de dos formas: elementos <audio>/<video>
 * que Meet ya montó, y el constructor de RTCPeerConnection (antes de que
 * Meet corra, vía addInitScript).
 */

export const AUDIO_TAP_SCRIPT = /* js */ `
(() => {
  if (window.__cortexTap) return;

  // MEET CORTA EL AUDIO A UNA PESTAÑA OCULTA. En headless/Xvfb la página
  // arranca 'hidden' y Meet deja de suscribir al bot a los streams de audio
  // remotos (las pistas llegan pero muted=true, sin RTP). Forzamos que la
  // página SIEMPRE se reporte visible y con foco.
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    document.hasFocus = () => true;
    window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (e) { /* algún getter no configurable */ }

  const pending = [];
  const seenTrack = new Set();

  const pcs = [];
  const OrigPC = window.RTCPeerConnection;
  if (OrigPC && !OrigPC.__cortexWrapped) {
    const Wrapped = new Proxy(OrigPC, {
      construct(Target, args) {
        const pc = new Target(...args);
        pcs.push(pc);
        pc.addEventListener('track', (ev) => {
          if (ev.track && ev.track.kind === 'audio') {
            pending.push(ev.streams[0] || new MediaStream([ev.track]));
          }
        });
        return pc;
      },
    });
    Wrapped.__cortexWrapped = true;
    window.RTCPeerConnection = Wrapped;
  }

  const state = { started: false, peak: 0, chunks: 0, speaker: null, roster: [], tracks: 0, live: 0, elements: 0, pcs: 0, mine: 0, playing: 0, trackInfo: '', vis: '', ctxState: 'none' };

  const EFFECTS = /visual_effects|backgrounds and effects|fondos y efectos/i;
  const SPEAKING_SEL = '.Oaajhc, .HX2H7, .wEsLMd, .OgVli, [data-audio-level]:not([data-audio-level="0"])';

  function cleanName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\\s+/g, ' ').trim();
    if (!s || EFFECTS.test(s)) return null;
    s = s.replace(/\\s*\\((presenting|presentando)\\)\\s*$/i, '');
    s = s.replace(/,?\\s*(muted|muteado|micr[oó]fono (off|apagado)|c[aá]mara apagada|speaking|hablando).*$/i, '');
    s = s.replace(/^(you|t[uú])$/i, '');
    return s.trim() || null;
  }

  function tileSpeaking(el) {
    if (el.getAttribute('data-is-speaking') === 'true') return true;
    const level = el.getAttribute('data-audio-level');
    if (level && level !== '0') return true;
    const aria = el.getAttribute('aria-label') || '';
    if (/speaking|hablando/i.test(aria)) return true;
    return Boolean(el.querySelector(SPEAKING_SEL));
  }

  function collectRoster() {
    const byKey = new Map();
    function add(id, name, speaking, self) {
      const n = cleanName(name);
      if (!n && !self) return;
      const key = id || n || 'self';
      const prev = byKey.get(key);
      byKey.set(key, {
        id: key,
        name: n || prev?.name || 'Participante',
        speaking: Boolean(speaking || prev?.speaking),
        self: Boolean(self || prev?.self),
      });
    }
    for (const el of document.querySelectorAll('[data-participant-id]')) {
      const aria = el.getAttribute('aria-label') || '';
      if (EFFECTS.test(aria)) continue;
      const id = el.getAttribute('data-participant-id') || '';
      const selfNode = el.hasAttribute('data-self-name')
        ? el
        : el.querySelector('[data-self-name]');
      const selfName = selfNode ? selfNode.getAttribute('data-self-name') : null;
      const labeled = el.querySelector('span.notranslate, .zWGUib, .cS7aqe');
      add(id, selfName || labeled?.textContent || aria, tileSpeaking(el), Boolean(selfName));
    }
    for (const el of document.querySelectorAll('[data-self-name]')) {
      const n = el.getAttribute('data-self-name');
      if (n) add(el.getAttribute('data-participant-id') || 'self', n, tileSpeaking(el), true);
    }
    return [...byKey.values()];
  }

  function refreshRoster() {
    const next = collectRoster();
    state.roster = next;
    const talking = next.find((p) => p.speaking && !p.self) || next.find((p) => p.speaking);
    if (talking?.name) state.speaker = talking.name;
  }

  async function start() {
    if (state.started) return { ok: false, reason: 'already-started' };
    state.started = true;

    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') await ctx.resume();
    const mixer = ctx.createGain();
    mixer.gain.value = 1;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const buf = new Float32Array(analyser.fftSize);
    mixer.connect(analyser);

    const processor = ctx.createScriptProcessor(4096, 1, 1);
    mixer.connect(processor);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    processor.connect(silent);
    silent.connect(ctx.destination);

    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
      const rms = Math.sqrt(sum / input.length);
      if (rms > state.peak) state.peak = rms;
      const pcm = downsampleTo16k(input, ctx.sampleRate);
      if (!pcm.length) return;
      state.chunks += 1;
      const b64 = int16ToBase64(pcm);
      if (window.__cortexAudioChunk) {
        window.__cortexAudioChunk({ b64, rms, speaker: state.speaker });
      }
    };

    // PISTAS REMOTAS EN CHROME: un MediaStreamAudioSourceNode de una pista
    // WebRTC remota solo produce audio si esa pista TAMBIÉN está sonando en
    // un <audio>/<video> (bug viejo de Chromium). Meet normalmente las tiene
    // en elementos propios, pero no siempre ni para todas (21-08: chunks
    // fluían y peak=0 durante toda una llamada). Por eso cada pista que se
    // engancha se reproduce además en un <audio> oculto a volumen 0.
    const wired = [];
    const nodes = [];  // referencias vivas: sin esto el GC calla el audio.

    // Cada pista remota se reproduce en su PROPIO <audio> y se captura de ESE
    // elemento (createMediaElementSource), no de la pista suelta. En Chromium
    // headless una MediaStreamSource de pista WebRTC remota entrega silencio;
    // un elemento que ya la decodifica, no. El elemento queda a volumen real
    // (el contenedor no tiene altavoces, nadie lo oye) para que Chromium no
    // descarte la decodificación.
    function wireTrack(t) {
      if (!t || seenTrack.has(t.id)) return;
      seenTrack.add(t.id);
      try {
        const el = document.createElement('audio');
        el.autoplay = true;
        el.volume = 1;
        el.muted = false;
        el.setAttribute('data-cortex-tap', '1');
        el.style.display = 'none';
        el.srcObject = new MediaStream([t]);
        document.body.appendChild(el);
        const p = el.play();
        if (p && p.catch) p.catch(() => {});
        const srcNode = ctx.createMediaElementSource(el);
        srcNode.connect(mixer);
        nodes.push(srcNode);
        wired.push(t);
        state.tracks = wired.length;
        // El audio remoto suele llegar MUTED y desmutearse segundos después
        // (Meet nos suscribe tarde). Cuando pase, que el elemento reanude.
        t.addEventListener('unmute', () => { const p = el.play(); if (p && p.catch) p.catch(() => {}); });
      } catch (e) {
        // Si ya se le sacó un source al elemento, capturar la pista directo.
        try {
          const n = ctx.createMediaStreamSource(new MediaStream([t]));
          n.connect(mixer);
          nodes.push(n);
          wired.push(t);
          state.tracks = wired.length;
        } catch (e2) { /* pista cerrada */ }
      }
    }
    function wireStream(stream) {
      if (!stream) return;
      const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
      for (const t of tracks) wireTrack(t);
    }
    function wireEl(el) {
      if (el && el.srcObject) wireStream(el.srcObject);
    }
    function sweep() {
      while (pending.length) wireStream(pending.pop());
      // Los receivers de cada RTCPeerConnection: aquí vive el audio remoto
      // aunque Meet nunca lo monte en un <audio> (elements:0). Es la fuente
      // que no depende de la UI de Meet.
      for (const pc of pcs) {
        try {
          for (const r of pc.getReceivers ? pc.getReceivers() : []) {
            if (r.track && r.track.kind === 'audio') wireTrack(r.track);
          }
        } catch (e) { /* pc cerrada */ }
      }
      const els = document.querySelectorAll('audio:not([data-cortex-tap]), video');
      state.elements = els.length;
      for (const el of els) wireEl(el);
      state.live = wired.filter((t) => t.readyState === 'live' && !t.muted).length;
      state.pcs = pcs.length;
      state.mine = document.querySelectorAll('audio[data-cortex-tap]').length;
      state.playing = [...document.querySelectorAll('audio[data-cortex-tap]')]
        .filter((e) => !e.paused && e.currentTime > 0).length;
      state.trackInfo = wired
        .slice(0, 6)
        .map((t) => t.readyState[0] + (t.muted ? 'M' : '') + (t.enabled ? '' : 'D'))
        .join(',');
      state.vis = document.visibilityState;
      state.ctxState = ctx.state;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
    sweep();
    setInterval(sweep, 500);

    refreshRoster();
    watchSpeaker();
    return { ok: true, sampleRate: ctx.sampleRate };
  }

  function downsampleTo16k(float32, inRate) {
    const target = 16000;
    if (!inRate || inRate <= 0) return new Int16Array(0);
    const ratio = inRate / target;
    const n = Math.max(0, Math.floor(float32.length / ratio));
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, float32[Math.floor(i * ratio)] || 0));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function int16ToBase64(pcm) {
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function watchSpeaker() {
    const pick = () => refreshRoster();
    new MutationObserver(pick).observe(document.body, {
      subtree: true, attributes: true, childList: true,
      attributeFilter: ['data-is-speaking', 'data-audio-level', 'aria-label', 'class'],
    });
    setInterval(pick, 400);
  }

  window.__cortexTap = {
    start,
    level: () => ({
      peak: state.peak,
      chunks: state.chunks,
      speaker: state.speaker,
      tracks: state.tracks,
      live: state.live,
      elements: state.elements,
      pcs: state.pcs,
      mine: state.mine,
      playing: state.playing,
      trackInfo: state.trackInfo,
      vis: state.vis,
      ctx: state.ctxState,
    }),
    roster: () => {
      refreshRoster();
      return state.roster.slice();
    },
  };
})();
`;
