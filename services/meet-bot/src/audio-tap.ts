/**
 * EL TAP: cómo un script DENTRO de la página de Meet saca el audio de la sala.
 *
 * Vexa (gmeet-capture + pcm-capture) dejó de usar ScriptProcessor: el callback
 * corre en el hilo principal y Meet lo mata a mitad de llamada (issue #204:
 * chunks dejan de salir, Whisper se queda en 0). AudioWorklet corre en el hilo
 * de audio. El PCM sale a 16 kHz linear16 para Deepgram.
 *
 * Cómo se engancha cada pista (el fallo del 21-08: chunks>0, peak=0, playing=0):
 *  1. Los <audio>/<video> que Meet YA está reproduciendo — createMediaStreamSource
 *     sobre su srcObject, igual que Vexa.
 *  2. Los receivers de RTCPeerConnection, porque Meet a veces no monta elementos
 *     (elements:0). Un <audio> sink 1×1 MUTED tira del jitter buffer; el tap es
 *     MediaStreamSource de la pista, NUNCA MediaElementSource (un elemento mudo
 *     o con display:none entrega silencio).
 *  3. Al `ended`, se olvida el id para que Meet pueda reciclar la pista.
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

  const state = {
    started: false, peak: 0, recentPeak: 0, chunks: 0, speaker: null, roster: [],
    tracks: 0, live: 0, elements: 0, pcs: 0, mine: 0, playing: 0,
    trackInfo: '', vis: '', ctxState: 'none', capture: 'none', lastRms: 0,
  };

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

  let ctx = null;
  const mixerHold = { current: null };
  const nodes = [];
  const sinks = [];
  let sweepTimer = null;
  let speakerWatched = false;

  const WORKLET_SRC = [
    'class CortexPcmCapture extends AudioWorkletProcessor {',
    '  constructor() { super(); this._buf = new Float32Array(4096); this._n = 0; }',
    '  process(inputs) {',
    '    const ch = inputs[0] && inputs[0][0];',
    '    if (!ch) return true;',
    '    for (let i = 0; i < ch.length; i++) {',
    '      this._buf[this._n++] = ch[i];',
    '      if (this._n === 4096) { this.port.postMessage(this._buf); this._buf = new Float32Array(4096); this._n = 0; }',
    '    }',
    '    return true;',
    '  }',
    '}',
    "registerProcessor('cortex-pcm-capture', CortexPcmCapture);",
  ].join('\\n');

  function emitPcm(float32, sampleRate) {
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    const rms = Math.sqrt(sum / Math.max(1, float32.length));
    if (rms > state.peak) state.peak = rms;
    if (rms > state.recentPeak) state.recentPeak = rms;
    state.lastRms = rms;
    const pcm = downsampleTo16k(float32, sampleRate);
    if (!pcm.length) return;
    state.chunks += 1;
    const b64 = int16ToBase64(pcm);
    try {
      if (window.__cortexAudioChunk) window.__cortexAudioChunk({ b64, rms, speaker: state.speaker });
    } catch (e) { /* binding caído un frame */ }
  }

  async function setupGraph() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume();
    const mixer = ctx.createGain();
    mixer.gain.value = 1;
    mixerHold.current = mixer;

    const onFrame = (ev) => emitPcm(ev.inputBuffer.getChannelData(0), ctx.sampleRate);

    try {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
      const node = new AudioWorkletNode(ctx, 'cortex-pcm-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e) => emitPcm(e.data, ctx.sampleRate);
      mixer.connect(node);
      node.connect(ctx.destination);
      nodes.push(node);
      state.capture = 'worklet';
    } catch (err) {
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      mixer.connect(processor);
      processor.connect(ctx.destination);
      processor.onaudioprocess = onFrame;
      nodes.push(processor);
      state.capture = 'script';
    }
    state.ctxState = ctx.state;
  }

  function dropWire(entry) {
    try { entry.node && entry.node.disconnect(); } catch (e) { /* ya cortado */ }
    if (entry.el && entry.el.parentNode) entry.el.parentNode.removeChild(entry.el);
    seenTrack.delete(entry.trackId);
  }

  function attachSink(track) {
    const el = document.createElement('audio');
    el.autoplay = true;
    el.playsInline = true;
    el.muted = true;
    el.volume = 1;
    el.setAttribute('data-cortex-tap', '1');
    el.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
    el.srcObject = new MediaStream([track]);
    (document.body || document.documentElement).appendChild(el);
    const play = () => { const p = el.play(); if (p && p.catch) p.catch(() => {}); };
    play();
    track.addEventListener('unmute', play);
    return el;
  }

  function wireTrack(t) {
    if (!t || t.kind !== 'audio' || t.readyState === 'ended') return;
    if (seenTrack.has(t.id)) return;
    if (!mixerHold.current || !ctx) return;
    seenTrack.add(t.id);
    let el = null;
    try {
      el = attachSink(t);
      const src = ctx.createMediaStreamSource(new MediaStream([t]));
      src.connect(mixerHold.current);
      const entry = { trackId: t.id, track: t, node: src, el };
      sinks.push(entry);
      t.addEventListener('ended', () => {
        const i = sinks.indexOf(entry);
        if (i >= 0) sinks.splice(i, 1);
        dropWire(entry);
      });
    } catch (e) {
      seenTrack.delete(t.id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    }
  }

  function wireStream(stream) {
    if (!stream) return;
    const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    for (const t of tracks) wireTrack(t);
    if (stream.addEventListener && !stream.__cortexWatch) {
      stream.__cortexWatch = true;
      stream.addEventListener('addtrack', (ev) => {
        if (ev.track && ev.track.kind === 'audio') wireTrack(ev.track);
      });
    }
  }

  function wireMeetElements() {
    const els = document.querySelectorAll('audio:not([data-cortex-tap]), video');
    state.elements = els.length;
    for (const el of els) {
      if (el.srcObject) wireStream(el.srcObject);
    }
  }

  function sweep() {
    while (pending.length) wireStream(pending.pop());
    for (const pc of pcs) {
      try {
        for (const r of pc.getReceivers ? pc.getReceivers() : []) {
          if (r.track && r.track.kind === 'audio') wireTrack(r.track);
        }
      } catch (e) { /* pc cerrada */ }
    }
    wireMeetElements();
    const liveTracks = sinks.map((s) => s.track).filter(Boolean);
    state.tracks = sinks.length;
    state.live = liveTracks.filter((t) => t.readyState === 'live' && !t.muted).length;
    state.pcs = pcs.length;
    const mine = document.querySelectorAll('audio[data-cortex-tap]');
    state.mine = mine.length;
    state.playing = [...mine].filter((e) => !e.paused).length;
    state.trackInfo = liveTracks
      .slice(0, 8)
      .map((t) => (t.readyState[0] || '?') + (t.muted ? 'M' : '') + (t.enabled ? '' : 'D'))
      .join(',');
    state.vis = document.visibilityState;
    if (ctx) {
      state.ctxState = ctx.state;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  }

  function disconnectWires() {
    while (sinks.length) dropWire(sinks.pop());
    seenTrack.clear();
  }

  async function start() {
    if (state.started) return { ok: false, reason: 'already-started' };
    state.started = true;
    await setupGraph();
    sweep();
    if (!sweepTimer) sweepTimer = setInterval(sweep, 1000);
    refreshRoster();
    watchSpeaker();
    return { ok: true, sampleRate: ctx && ctx.sampleRate, capture: state.capture };
  }

  function rewire() {
    disconnectWires();
    sweep();
    return { ok: true, tracks: state.tracks, capture: state.capture };
  }

  async function restart() {
    disconnectWires();
    for (const n of nodes.splice(0)) {
      try { n.disconnect(); } catch (e) { /* */ }
    }
    if (ctx) {
      try { await ctx.close(); } catch (e) { /* */ }
      ctx = null;
    }
    mixerHold.current = null;
    state.started = false;
    state.capture = 'none';
    state.peak = 0;
    state.recentPeak = 0;
    return start();
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
    if (speakerWatched) return;
    speakerWatched = true;
    const pick = () => refreshRoster();
    new MutationObserver(pick).observe(document.body, {
      subtree: true, attributes: true, childList: true,
      attributeFilter: ['data-is-speaking', 'data-audio-level', 'aria-label', 'class'],
    });
    setInterval(pick, 400);
  }

  function snapshotLevel(consumeRecent) {
    const recent = state.recentPeak;
    if (consumeRecent) state.recentPeak = 0;
    return {
      peak: state.peak,
      recentPeak: recent,
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
      capture: state.capture,
      lastRms: state.lastRms,
    };
  }

  window.__cortexTap = {
    start,
    rewire,
    restart,
    peek: () => snapshotLevel(false),
    level: () => snapshotLevel(true),
    roster: () => {
      refreshRoster();
      return state.roster.slice();
    },
  };
})();
`;
