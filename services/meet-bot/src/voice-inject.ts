/**
 * LA VOZ DE CORTEX, METIDA EN EL MICRÓFONO DE LA REUNIÓN.
 *
 * No basta con parchear `navigator.mediaDevices.getUserMedia`: Meet a menudo
 * llama `MediaDevices.prototype.getUserMedia` (el prototipo), así que el
 * wrapper de instancia nunca corre — 21-08: speak duration=7s y gumAudio=0,
 * la sala no oía nada. Se parchea el prototipo Y se hace replaceTrack en
 * cada RTCRtpSender de audio, que es el cable que Meet sí usa.
 *
 * Un ConstantSource mínimo mantiene la pista viva (un MediaStreamDestination
 * en silencio queda `muted` y WebRTC no la envía cuando después llega el TTS).
 */

export const VOICE_INJECT_SCRIPT = /* js */ `
(() => {
  if (window.__cortexVoice) return;

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const dest = ctx.createMediaStreamDestination();
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(dest);

  try {
    const keep = ctx.createConstantSource();
    const keepGain = ctx.createGain();
    keepGain.gain.value = 0.0004;
    keep.connect(keepGain);
    keepGain.connect(dest);
    keep.start();
  } catch (e) { /* ConstantSource no existe en un Chrome viejo */ }

  const micTrack = dest.stream.getAudioTracks()[0];
  if (micTrack) micTrack.enabled = true;

  let gumAudio = 0;
  const voicePcs = [];

  const protoGUM = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    if (constraints && constraints.audio) {
      gumAudio += 1;
      const stream = new MediaStream();
      stream.addTrack(micTrack);
      if (constraints.video) {
        try {
          const v = await protoGUM.call(this, { video: constraints.video });
          for (const t of v.getVideoTracks()) stream.addTrack(t);
        } catch (e) { /* sin video */ }
      }
      return stream;
    }
    return protoGUM.call(this, constraints);
  };

  function gumCallback(constraints, success, fail) {
    MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices, constraints)
      .then(success, fail);
  }
  if (navigator.getUserMedia) navigator.getUserMedia = gumCallback;
  if (navigator.webkitGetUserMedia) navigator.webkitGetUserMedia = gumCallback;

  const protoEnum = MediaDevices.prototype.enumerateDevices;
  MediaDevices.prototype.enumerateDevices = async function () {
    const list = await protoEnum.call(this);
    if (list.some((d) => d.kind === 'audioinput')) return list;
    return [{
      deviceId: 'cortex-virtual-mic',
      groupId: 'cortex',
      kind: 'audioinput',
      label: 'Cortex Microphone',
      toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; },
    }, ...list];
  };

  const PrevPC = window.RTCPeerConnection;
  if (PrevPC && !PrevPC.__cortexVoiceWrapped) {
    const Wrapped = new Proxy(PrevPC, {
      construct(Target, args) {
        const pc = new Target(...args);
        voicePcs.push(pc);
        return pc;
      },
    });
    Wrapped.__cortexVoiceWrapped = true;
    window.RTCPeerConnection = Wrapped;
  }

  async function hijackSenders() {
    let replaced = 0;
    let already = 0;
    for (const pc of voicePcs) {
      try {
        for (const sender of pc.getSenders()) {
          const t = sender.track;
          if (!t || t.kind !== 'audio') continue;
          if (t.id === micTrack.id) {
            already += 1;
            t.enabled = true;
            continue;
          }
          try {
            await sender.replaceTrack(micTrack);
            micTrack.enabled = true;
            replaced += 1;
          } catch (e) { /* sender cerrado */ }
        }
      } catch (e) { /* pc cerrada */ }
    }
    return { replaced, already, pcs: voicePcs.length };
  }

  let speaking = false;
  let playHead = 0;

  function pcmBuffer(b64, sampleRate) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const n = Math.floor(bytes.byteLength / 2);
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, n);
    const buf = ctx.createBuffer(1, n, sampleRate || 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = i16[i] / 32768;
    return buf;
  }

  async function beginSpeak() {
    if (ctx.state === 'suspended') await ctx.resume();
    micTrack.enabled = true;
    speaking = true;
    playHead = ctx.currentTime + 0.02;
    return hijackSenders();
  }

  function speakPcm(b64, sampleRate) {
    const buf = pcmBuffer(b64, sampleRate);
    if (!buf.length) return { queued: 0 };
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    const now = ctx.currentTime;
    if (playHead < now + 0.02) playHead = now + 0.02;
    src.start(playHead);
    playHead += buf.duration;
    speaking = true;
    return { queued: buf.duration, until: playHead };
  }

  async function endSpeak() {
    const remain = Math.max(0, playHead - ctx.currentTime);
    await new Promise((r) => setTimeout(r, remain * 1000 + 80));
    speaking = false;
    return { duration: remain };
  }

  async function speak(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let buf;
    try {
      buf = await ctx.decodeAudioData(bytes.buffer);
    } catch (e) { return { duration: 0, error: 'decode: ' + (e && e.message) }; }
    if (ctx.state === 'suspended') await ctx.resume();
    micTrack.enabled = true;
    const hijack = await hijackSenders();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    speaking = true;
    const done = new Promise((resolve) => {
      src.onended = () => { speaking = false; resolve(); };
    });
    src.start();
    const cap = Math.ceil(buf.duration * 1000) + 1500;
    await Promise.race([done, new Promise((r) => setTimeout(r, cap))]);
    speaking = false;
    return {
      duration: buf.duration,
      ctx: ctx.state,
      gumAudio,
      track: micTrack.readyState,
      trackEnabled: micTrack.enabled,
      trackMuted: micTrack.muted,
      gain: gain.gain.value,
      hijack,
    };
  }

  async function arm() {
    if (ctx.state === 'suspended') await ctx.resume();
    if (micTrack) micTrack.enabled = true;
    const hijack = await hijackSenders();
    let audioInputs = [];
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputs = devices.filter((d) => d.kind === 'audioinput').map((d) => d.label || d.deviceId);
    } catch (e) { /* */ }
    return {
      ctx: ctx.state,
      gumAudio,
      track: micTrack && micTrack.readyState,
      trackEnabled: micTrack && micTrack.enabled,
      trackMuted: micTrack && micTrack.muted,
      audioInputs,
      hijack,
    };
  }

  window.__cortexVoice = {
    speak,
    speakPcm,
    beginSpeak,
    endSpeak,
    arm,
    mute: () => { gain.gain.value = 0; if (micTrack) micTrack.enabled = false; },
    unmute: () => { gain.gain.value = 1; if (micTrack) micTrack.enabled = true; void hijackSenders(); },
    isSpeaking: () => speaking,
    status: () => ({
      ctx: ctx.state,
      gumAudio,
      track: micTrack && micTrack.readyState,
      pcs: voicePcs.length,
      gain: gain.gain.value,
    }),
  };
})();
`;
