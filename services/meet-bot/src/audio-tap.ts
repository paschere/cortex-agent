/**
 * EL TAP: cómo un script DENTRO de la página de Meet saca el audio de la sala.
 *
 * Camino de Vexa (`gmeet-capture.ts` + `pcm-capture.ts`):
 *  Meet ya reproduce cada participante en un <audio>/<video> con srcObject.
 *  Se toma ESE MediaStream con createMediaStreamSource y un AudioWorklet a
 *  16 kHz. No se crean sinks paralelos ni createMediaElementSource — eso
 *  le quita el elemento a Meet y las pistas remotas se quedan muted (peak=0).
 *
 * El PCM sale linear16 16 kHz a Deepgram. El roster/scene es de Cortex.
 */

export const AUDIO_TAP_SCRIPT = /* js */ `
(() => {
  if (window.__cortexTap) return;

  // MEET CORTA EL AUDIO A UNA PESTAÑA OCULTA.
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
    Object.defineProperty(document, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
    document.hasFocus = () => true;
    window.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    document.addEventListener('visibilitychange', (e) => e.stopImmediatePropagation(), true);
    document.dispatchEvent(new Event('visibilitychange'));
  } catch (e) { /* algún getter no configurable */ }

  const state = {
    started: false, peak: 0, recentPeak: 0, chunks: 0, speaker: null, roster: [],
    tracks: 0, live: 0, elements: 0, pcs: 0, mine: 0, playing: 0,
    trackInfo: '', vis: '', ctxState: 'none', capture: 'none', lastRms: 0,
    sampleRate: 0, meetSrc: 0, meetPlay: '',
  };

  const EFFECTS = /visual_effects|backgrounds and effects|fondos y efectos/i;
  const SPEAKING_SEL = '.Oaajhc, .HX2H7, .wEsLMd, .OgVli, [data-audio-level]:not([data-audio-level="0"]), [data-is-speaking="true"]';
  const NAME_SEL = 'span.notranslate, .zWGUib, .cS7aqe, .XWGOtd';
  // Keep name cleaning in sync with meet-speaker.ts (Node side).
  const PLACEHOLDER = /^(you|t[uú]|participant|participante|guest|invitado|unknown|desconocido|user|usuario)(\\s+\\d+)?$/i;
  const CHROME_CHUNK = /^(microphone|micr[oó]fono|camera|c[aá]mara|muted|muteado|speaker|altavoz|sharing|compartiendo)\\b/i;

  function cleanName(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/\\s+/g, ' ').trim();
    if (!s || EFFECTS.test(s)) return null;
    s = s.replace(/\\s*\\((presenting|presentando|you|t[uú]|yourself)\\)\\s*$/i, '');
    s = s.replace(/'s screen$/i, '');
    s = s.replace(/\\s+est[aá] (hablando|presentando)$/i, '');
    s = s.replace(/\\s+is (speaking|presenting)$/i, '');
    s = s.replace(/\\s+(speaking|hablando|presenting|presentando)$/i, '');
    const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
    const nameParts = [];
    for (const part of parts) {
      if (CHROME_CHUNK.test(part)) break;
      nameParts.push(part);
    }
    s = (nameParts.join(', ') || parts[0] || s).trim();
    if (PLACEHOLDER.test(s)) return null;
    return s || null;
  }

  function tileSpeaking(el) {
    if (el.getAttribute('data-is-speaking') === 'true' || el.getAttribute('data-speaking') === 'true') return true;
    const level = el.getAttribute('data-audio-level');
    if (level && level !== '0') return true;
    const aria = el.getAttribute('aria-label') || '';
    if (/(is )?speaking|est[aá] hablando|hablando/i.test(aria)) return true;
    return Boolean(el.querySelector(SPEAKING_SEL));
  }

  function tileName(el, selfName, aria) {
    if (selfName) return selfName;
    const labeled = el.querySelector(NAME_SEL);
    return cleanName(labeled && labeled.textContent) || cleanName(aria) || aria || '';
  }

  function collectRoster() {
    const byKey = new Map();
    function add(id, name, speaking, self) {
      const presenting = /\\b(presenting|presentando|compartiendo|sharing (the )?screen|sharing a window)\\b/i.test(name || '');
      const n = cleanName(name);
      if (!n && !self) return;
      const key = id || n || 'self';
      const prev = byKey.get(key);
      byKey.set(key, {
        id: key,
        name: n || prev?.name || 'Participante',
        speaking: Boolean(speaking || prev?.speaking),
        self: Boolean(self || prev?.self),
        presenting: Boolean(presenting || prev?.presenting),
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
      add(id, tileName(el, selfName, aria), tileSpeaking(el), Boolean(selfName));
    }
    for (const el of document.querySelectorAll('[data-self-name]')) {
      const n = el.getAttribute('data-self-name');
      if (n) add(el.getAttribute('data-participant-id') || 'self', n, tileSpeaking(el), true);
    }
    return [...byKey.values()];
  }

  function usableName(name) {
    const n = cleanName(name);
    if (!n || /^participante$/i.test(n)) return null;
    return n;
  }

  function pickSpeaker(roster) {
    const others = roster.filter((p) => !p.self);
    const talking = others.find((p) => p.speaking);
    const talkingName = talking ? usableName(talking.name) : null;
    if (talkingName) return talkingName;
    const unique = [];
    for (const p of others) {
      const n = usableName(p.name);
      if (n && !unique.includes(n)) unique.push(n);
    }
    if (unique.length === 1) return unique[0];
    if (state.speaker && others.some((p) => usableName(p.name) === state.speaker)) return state.speaker;
    return state.speaker;
  }

  function refreshRoster() {
    const next = collectRoster();
    state.roster = next;
    const name = pickSpeaker(next);
    if (name) state.speaker = name;
  }

  let ctx = null;
  const mixerHold = { current: null };
  const captureNodes = [];
  const sourceNodes = [];
  const connectedStreamIds = new Set();
  const connectedTrackIds = new Set();
  const wiredTracks = [];
  const pendingStreams = [];
  const tapPcs = [];
  let sweepTimer = null;
  let speakerWatched = false;
  let rosterSoon = null;

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

  function isLocalVoice(t) {
    try {
      return Boolean(window.__cortexLocalTrackId && t && t.id === window.__cortexLocalTrackId);
    } catch (e) { return false; }
  }

  function isLocalStream(stream) {
    const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    return tracks.length > 0 && tracks.every(isLocalVoice);
  }

  // Meet a veces deja el <audio> en pausa y igual tiene el MediaStream vivo.
  function findMediaElements() {
    return Array.from(document.querySelectorAll('audio, video')).filter((el) => {
      const stream = el.srcObject;
      return stream instanceof MediaStream && stream.getAudioTracks().some((t) => t.readyState === 'live');
    });
  }

  async function setupGraph() {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    if (ctx.state === 'suspended') await ctx.resume();
    state.sampleRate = ctx.sampleRate;
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
      captureNodes.push(node);
      state.capture = 'worklet';
    } catch (err) {
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      mixer.connect(processor);
      processor.connect(ctx.destination);
      processor.onaudioprocess = onFrame;
      captureNodes.push(processor);
      state.capture = 'script';
    }
    state.ctxState = ctx.state;
  }

  function connectStream(stream) {
    if (!stream || !(stream instanceof MediaStream)) return false;
    const tracks = stream.getAudioTracks().filter((t) => t.readyState === 'live' && !isLocalVoice(t));
    if (!tracks.length) return false;
    const fresh = tracks.filter((t) => !connectedTrackIds.has(t.id));
    if (!fresh.length) return false;
    if (isLocalStream(stream)) return false;
    if (!mixerHold.current || !ctx) {
      if (!pendingStreams.some((s) => s.id === stream.id)) pendingStreams.push(stream);
      return false;
    }
    try {
      const source = ctx.createMediaStreamSource(fresh.length === tracks.length ? stream : new MediaStream(fresh));
      source.connect(mixerHold.current);
      sourceNodes.push(source);
      connectedStreamIds.add(stream.id);
      for (const track of fresh) {
        connectedTrackIds.add(track.id);
        wiredTracks.push(track);
        track.addEventListener('ended', () => {
          connectedTrackIds.delete(track.id);
          connectedStreamIds.delete(stream.id);
          const i = wiredTracks.indexOf(track);
          if (i >= 0) wiredTracks.splice(i, 1);
        });
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function connectElement(el) {
    if (el.paused) el.play().catch(() => {});
    return connectStream(el.srcObject);
  }

  function flushPending() {
    const queued = pendingStreams.splice(0);
    for (const stream of queued) connectStream(stream);
  }

  function sweep() {
    flushPending();
    for (const pc of tapPcs) {
      try {
        for (const receiver of pc.getReceivers()) {
          const track = receiver.track;
          if (!track || track.kind !== 'audio' || track.readyState !== 'live') continue;
          if (isLocalVoice(track)) continue;
          connectStream(new MediaStream([track]));
        }
      } catch (e) { /* pc cerrada */ }
    }
    const els = findMediaElements();
    state.elements = els.length;
    state.meetPlay = els.slice(0, 6).map((el) => {
      const tracks = el.srcObject && el.srcObject.getAudioTracks
        ? el.srcObject.getAudioTracks().length
        : 0;
      return (el.tagName[0] || '?')
        + (el.muted ? 'm' : '')
        + (el.paused ? 'p' : '')
        + (el.volume < 0.1 ? 'v0' : '')
        + tracks;
    }).join(',');
    for (const el of els) connectElement(el);
    state.meetSrc = connectedStreamIds.size;
    state.tracks = connectedStreamIds.size;
    state.live = wiredTracks.filter((t) => t && t.readyState === 'live').length;
    state.pcs = tapPcs.length;
    state.mine = 0;
    state.playing = els.filter((e) => !e.paused).length;
    state.trackInfo = wiredTracks
      .slice(0, 8)
      .map((t) => (t.readyState[0] || '?') + (t.muted ? 'M' : '') + (t.enabled ? '' : 'D'))
      .join(',');
    state.vis = document.visibilityState;
    if (ctx) {
      state.ctxState = ctx.state;
      state.sampleRate = ctx.sampleRate;
      if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    }
  }

  function disconnectSources() {
    for (const n of sourceNodes.splice(0)) {
      try { n.disconnect(); } catch (e) { /* */ }
    }
    connectedStreamIds.clear();
    connectedTrackIds.clear();
    wiredTracks.length = 0;
  }

  async function start() {
    if (state.started) return { ok: false, reason: 'already-started' };
    state.started = true;
    await setupGraph();
    flushPending();
    sweep();
    if (!sweepTimer) sweepTimer = setInterval(sweep, 1000);
    refreshRoster();
    watchSpeaker();
    return { ok: true, sampleRate: ctx && ctx.sampleRate, capture: state.capture, streams: connectedStreamIds.size };
  }

  function rewire() {
    disconnectSources();
    flushPending();
    sweep();
    return { ok: true, tracks: state.tracks, meetSrc: state.meetSrc, capture: state.capture, pcs: tapPcs.length };
  }

  async function restart() {
    disconnectSources();
    for (const n of captureNodes.splice(0)) {
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

  function refreshRosterSoon() {
    if (rosterSoon) return;
    rosterSoon = setTimeout(() => {
      rosterSoon = null;
      refreshRoster();
    }, 250);
  }

  function watchSpeaker() {
    if (speakerWatched) return;
    speakerWatched = true;
    new MutationObserver(refreshRosterSoon).observe(document.body, {
      subtree: true, attributes: true, childList: true,
      attributeFilter: ['data-is-speaking', 'data-audio-level', 'aria-label', 'class'],
    });
    setInterval(refreshRoster, 800);
  }

  const PrevPC = window.RTCPeerConnection;
  if (PrevPC && !PrevPC.__cortexTapWrapped) {
    const Wrapped = new Proxy(PrevPC, {
      construct(Target, args) {
        const pc = new Target(...args);
        tapPcs.push(pc);
        pc.addEventListener('track', (ev) => {
          if (!ev.track || ev.track.kind !== 'audio') return;
          if (isLocalVoice(ev.track)) return;
          const stream = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]);
          connectStream(stream);
        });
        return pc;
      },
    });
    Wrapped.__cortexTapWrapped = true;
    window.RTCPeerConnection = Wrapped;
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
      sampleRate: state.sampleRate,
      meetSrc: state.meetSrc,
      meetPlay: state.meetPlay,
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
    scene: () => {
      refreshRoster();
      const presenter = state.roster.find((p) => p.presenting && !p.self)
        || state.roster.find((p) => p.presenting);
      return { presenting: presenter ? presenter.name : null, roster: state.roster.slice() };
    },
  };
})();
`;
