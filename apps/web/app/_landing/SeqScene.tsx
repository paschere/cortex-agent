'use client';

import { useGLTF } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import {
  Component,
  type MutableRefObject,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';

/**
 * La secuencia del hero: el humano toca a la IA, big bang, y nace CORTEX.
 *
 * El scroll es la línea de tiempo. HeroSequence (el dueño del pin) escribe el
 * progreso 0..1 en un ref; aquí se suaviza con un damping crítico y se
 * reparte en fases, CADA UNA CON SU CURVA — nada entra ni sale linealmente:
 *
 *   FASE 0 (reposo; corre con el RELOJ, no con el scroll) — la escena tiene
 *              vida propia antes del primer scroll: el humano FLOTA (bob
 *              ±2% de su altura cada 5.6s + deriva de rotación ±1.4°, por
 *              transform — cero costo por partícula), y cada ~4.3–6s con
 *              jitter la IA lo LLAMA: zarcillos de luz salen del núcleo
 *              hacia la mano por la misma bezier del río y se disuelven a
 *              medio camino o rozándola; el núcleo y los anillos se excitan
 *              un beat, un shimmer recorre el brazo hacia la mano y el
 *              hombro se eleva unos grados y vuelve. Todo se multiplica por
 *              idleK = 1 − smooth01(P/0.15): scrollear ES responder, y la
 *              vida idle cede el paso a la narrativa sin pelear con ella.
 *
 *   0.00–0.30  EL ALCANCE (easeInOutCubic) — el humano de partículas (GLB
 *              muestreado + GPU skinning) a la izquierda, el núcleo a la
 *              derecha, SEPARADOS. El progreso acerca el cuerpo, apunta el
 *              brazo (slerp de RightArm→RightForeArm) y empuja la cámara; el
 *              núcleo late más rápido cuanto más cerca está la mano.
 *
 *   ~0.26–0.30 LA ANTICIPACIÓN — todo INHALA: las partículas se contraen
 *              hacia el punto de contacto y la luz baja medio beat. Es el
 *              silencio antes del estallido; sin él, el bang sería un glitch.
 *
 *   0.30–0.45  EL BIG BANG (easeOutExpo) — el contacto. Flash y onda de
 *              choque con borde cromático en DOM (HeroSequence); aquí las
 *              partículas estallan radiales desde el contacto y viajan con
 *              turbulencia curl (remolinos orgánicos, no rayos rectos), con
 *              iridiscencia por velocidad: las rápidas tiran a cian, las
 *              lentas a rosa.
 *
 *   0.45–0.75  NACE CORTEX — cada partícula converge escalonada hacia su
 *              punto del wordmark «CORTEX» (muestreado con fillText y lectura
 *              de píxeles) y LLEGA con un leve overshoot que se asienta
 *              (back-ease en el vértice). Cuando el trazo cierra, un shimmer
 *              lo recorre una vez de izquierda a derecha.
 *
 *   0.75–1.00  EL PRODUCTO — el wordmark se reduce y sube mientras la luz se
 *              apaga; debajo entra la ventana viva (DOM, en HeroSequence).
 *
 * LA LUZ. Nada de morado plano: cada fragmento pasa por una rampa índigo
 * profundo → violeta → blanco cálido según su energía, y cada draw call
 * principal lleva una CAPA GEMELA detrás — misma geometría, puntos 2.6×,
 * alpha ~25%, borde suave — que es el bloom sin postprocesado. La niebla de
 * profundidad atenúa lo lejano para que el campo tenga aire.
 *
 * TÉCNICA. Un solo campo de partículas en los draw calls de siempre. Cada
 * vértice conoce su posición de escena (skinning/procedural), su dirección
 * de estallido (radial desde uContact + jitter, calculada en el shader) y su
 * punto del wordmark (aWord). La mezcla ocurre EN EL VÉRTICE con los
 * uniforms de fase: el CPU escribe ~20 números por frame, jamás una
 * partícula.
 *
 * PRESUPUESTO. DPR [1, 1.5], antialias apagado, low-power, frameloop 'never'
 * cuando el pin no se ve, GLB post-LCP (dynamic import), 40% de partículas
 * en móvil. Las capas gemelas duplican draw calls baratos, no geometría.
 */

const BREATHE_S = 3.4;
const MODEL_URL = '/models/human.glb';

/** El GLB viene comprimido con meshopt; sin este decoder no hay geometría. */
const extendLoader = (loader: { setMeshoptDecoder: (d: unknown) => unknown }) => {
  loader.setMeshoptDecoder(MeshoptDecoder);
};

// El preload corre al evaluarse el chunk — post-mount por el dynamic import.
if (typeof window !== 'undefined') {
  useGLTF.preload(MODEL_URL, false, false, extendLoader);
}

/* --------------------------------------------------------------------------
 * El wordmark: «CORTEX» muestreado de un canvas 2D.
 * ------------------------------------------------------------------------ */

let wordCloud: Float32Array | null = null;
/** Mitad del ancho del wordmark, en unidades de "alto de glifo". */
let wordHalfW = 2.3;

function buildWordCloud(): Float32Array {
  if (wordCloud) return wordCloud;
  const W = 1280;
  const H = 320;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const out: number[] = [];
  if (ctx) {
    // La familia real (next/font la publica con nombre propio) leída del
    // body — el mismo Manrope 800 del wordmark del masthead.
    const fam = getComputedStyle(document.body).fontFamily || 'ui-sans-serif, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    try {
      (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '0.06em';
    } catch {
      /* Safari viejo: sin tracking, el wordmark sigue siendo el wordmark. */
    }
    let size = H * 0.66;
    ctx.font = `800 ${size}px ${fam}`;
    const width = ctx.measureText('CORTEX').width;
    if (width > W * 0.94) {
      size *= (W * 0.94) / width;
      ctx.font = `800 ${size}px ${fam}`;
    }
    ctx.fillStyle = '#fff';
    ctx.fillText('CORTEX', W / 2, H / 2 + size * 0.04);

    const data = ctx.getImageData(0, 0, W, H).data;
    for (let y = 0; y < H; y += 2) {
      for (let x = 0; x < W; x += 2) {
        if ((data[(y * W + x) * 4 + 3] ?? 0) > 120) {
          out.push((x - W / 2) / H, (H / 2 - y) / H);
        }
      }
    }
  }
  if (out.length < 64) {
    for (let i = 0; i < 4000; i++)
      out.push((Math.random() - 0.5) * 4.4, (Math.random() - 0.5) * 0.8);
  }
  wordCloud = new Float32Array(out);
  let mx = 0;
  for (let i = 0; i < wordCloud.length; i += 2) mx = Math.max(mx, Math.abs(wordCloud[i] ?? 0));
  wordHalfW = Math.max(0.5, mx);
  return wordCloud;
}

/** N puntos del wordmark, con jitter sub-celda, como atributo vec2. */
function wordAttr(count: number): Float32Array {
  const cloud = buildWordCloud();
  const cells = cloud.length / 2;
  const out = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    const c = (Math.random() * cells) | 0;
    out[i * 2] = (cloud[c * 2] ?? 0) + (Math.random() - 0.5) * 0.012;
    out[i * 2 + 1] = (cloud[c * 2 + 1] ?? 0) + (Math.random() - 0.5) * 0.012;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * La silueta procedural — el respaldo si el GLB no llega.
 * ------------------------------------------------------------------------ */

const SIL_W = 480;
const SIL_H = 720;
const SIL_AXIS = 205;
const HAND_UNIT: readonly [number, number] = [(468 - SIL_AXIS) / SIL_H, (720 - 122) / SIL_H];

function drawHuman(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const stroke = (pts: Array<[number, number]>, w: number) => {
    ctx.lineWidth = w;
    ctx.beginPath();
    const [first, ...rest] = pts;
    if (!first) return;
    ctx.moveTo(first[0], first[1]);
    for (const [x, y] of rest) ctx.lineTo(x, y);
    ctx.stroke();
  };

  ctx.beginPath();
  ctx.arc(SIL_AXIS, 84, 44, 0, Math.PI * 2);
  ctx.fill();
  stroke(
    [
      [SIL_AXIS, 122],
      [SIL_AXIS, 160],
    ],
    28,
  );
  ctx.beginPath();
  ctx.moveTo(152, 170);
  ctx.lineTo(258, 170);
  ctx.quadraticCurveTo(252, 300, 240, 380);
  ctx.lineTo(170, 380);
  ctx.quadraticCurveTo(158, 300, 152, 170);
  ctx.closePath();
  ctx.fill();
  stroke(
    [
      [156, 182],
      [254, 182],
    ],
    46,
  );
  stroke(
    [
      [176, 372],
      [234, 372],
    ],
    48,
  );
  stroke(
    [
      [160, 194],
      [138, 284],
      [148, 372],
    ],
    30,
  );
  stroke(
    [
      [252, 192],
      [342, 158],
      [452, 126],
    ],
    31,
  );
  ctx.beginPath();
  ctx.arc(460, 122, 17, 0, Math.PI * 2);
  ctx.fill();
  stroke(
    [
      [188, 382],
      [178, 532],
      [170, 676],
    ],
    38,
  );
  stroke(
    [
      [222, 382],
      [234, 532],
      [244, 676],
    ],
    38,
  );
  stroke(
    [
      [156, 688],
      [198, 688],
    ],
    18,
  );
  stroke(
    [
      [230, 688],
      [274, 688],
    ],
    18,
  );
}

function gauss(): number {
  return Math.random() + Math.random() + Math.random() - 1.5;
}

function sampleHuman(count: number): { pos: Float32Array; seed: Float32Array } {
  const canvas = document.createElement('canvas');
  canvas.width = SIL_W;
  canvas.height = SIL_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);

  if (!ctx) {
    for (let i = 0; i < count; i++) {
      pos[i * 3] = gauss() * 0.06;
      pos[i * 3 + 1] = Math.random() * 0.9;
      pos[i * 3 + 2] = gauss() * 0.1;
      seed[i] = Math.random();
    }
    return { pos, seed };
  }

  drawHuman(ctx);
  const data = ctx.getImageData(0, 0, SIL_W, SIL_H).data;
  const filled: number[] = [];
  for (let y = 0; y < SIL_H; y++) {
    for (let x = 0; x < SIL_W; x++) {
      if ((data[(y * SIL_W + x) * 4 + 3] ?? 0) > 128) filled.push(y * SIL_W + x);
    }
  }

  const n = filled.length;
  for (let i = 0; i < count; i++) {
    const idx = filled[(Math.random() * n) | 0] ?? 0;
    const px = (idx % SIL_W) + Math.random();
    const py = ((idx / SIL_W) | 0) + Math.random();
    const jx = gauss() * 1.6;
    const jy = gauss() * 1.6;
    pos[i * 3] = (px + jx - SIL_AXIS) / SIL_H;
    pos[i * 3 + 1] = (SIL_H - (py + jy)) / SIL_H;
    pos[i * 3 + 2] = Math.max(-0.15, Math.min(0.15, gauss() * 0.075));
    seed[i] = Math.random();
  }
  return { pos, seed };
}

/* --------------------------------------------------------------------------
 * Muestreo del modelo real: superficie → partículas con piel.
 * ------------------------------------------------------------------------ */

type SampledSkin = {
  pos: Float32Array;
  skinIndex: Float32Array;
  skinWeight: Float32Array;
  seed: Float32Array;
  tone: Float32Array;
};

function sampleFaceIndex(sampler: MeshSurfaceSampler, totalWeight: number): number {
  const s = sampler as unknown as {
    _sampleFaceIndex?: () => number;
    binarySearch?: (x: number) => number;
  };
  if (typeof s._sampleFaceIndex === 'function') return s._sampleFaceIndex();
  if (typeof s.binarySearch === 'function') return s.binarySearch(Math.random() * totalWeight);
  return 0;
}

function sampleSkinnedMeshes(
  meshes: THREE.SkinnedMesh[],
  count: number,
  tones: number[],
): SampledSkin {
  const pos = new Float32Array(count * 3);
  const skinIndex = new Float32Array(count * 4);
  const skinWeight = new Float32Array(count * 4);
  const seed = new Float32Array(count);
  const tone = new Float32Array(count);

  const samplers = meshes.map((m) => new MeshSurfaceSampler(m).build());
  const areas = samplers.map((s) => {
    const d = s.distribution;
    return d && d.length > 0 ? (d[d.length - 1] ?? 0) : 0;
  });
  const totalArea = areas.reduce((a, b) => a + b, 0) || 1;

  let written = 0;
  for (let m = 0; m < meshes.length; m++) {
    const mesh = meshes[m];
    const sampler = samplers[m];
    if (!mesh || !sampler) continue;
    const quota =
      m === meshes.length - 1 ? count - written : Math.round((count * (areas[m] ?? 0)) / totalArea);

    const geo = mesh.geometry;
    const index = geo.index;
    const pAttr = geo.getAttribute('position');
    const siAttr = geo.getAttribute('skinIndex');
    const swAttr = geo.getAttribute('skinWeight');
    const dist = sampler.distribution;
    if (!pAttr || !siAttr || !swAttr || !dist || dist.length === 0) continue;
    const totalW = dist[dist.length - 1] ?? 0;

    for (let j = 0; j < quota && written < count; j++, written++) {
      const face = sampleFaceIndex(sampler, totalW);
      let i0 = face * 3;
      let i1 = face * 3 + 1;
      let i2 = face * 3 + 2;
      if (index) {
        i0 = index.getX(i0);
        i1 = index.getX(i1);
        i2 = index.getX(i2);
      }

      let u = Math.random();
      let v = Math.random();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      const w = 1 - u - v;

      const k = written * 3;
      pos[k] = pAttr.getX(i0) * u + pAttr.getX(i1) * v + pAttr.getX(i2) * w;
      pos[k + 1] = pAttr.getY(i0) * u + pAttr.getY(i1) * v + pAttr.getY(i2) * w;
      pos[k + 2] = pAttr.getZ(i0) * u + pAttr.getZ(i1) * v + pAttr.getZ(i2) * w;

      const iv = u >= v && u >= w ? i0 : v >= w ? i1 : i2;
      const k4 = written * 4;
      skinIndex[k4] = siAttr.getX(iv);
      skinIndex[k4 + 1] = siAttr.getY(iv);
      skinIndex[k4 + 2] = siAttr.getZ(iv);
      skinIndex[k4 + 3] = siAttr.getW(iv);
      let wx = swAttr.getX(iv);
      let wy = swAttr.getY(iv);
      let wz = swAttr.getZ(iv);
      let ww = swAttr.getW(iv);
      const sum = wx + wy + wz + ww || 1;
      wx /= sum;
      wy /= sum;
      wz /= sum;
      ww /= sum;
      skinWeight[k4] = wx;
      skinWeight[k4 + 1] = wy;
      skinWeight[k4 + 2] = wz;
      skinWeight[k4 + 3] = ww;

      seed[written] = Math.random();
      tone[written] = tones[m] ?? 1;
    }
  }

  return { pos, skinIndex, skinWeight, seed, tone };
}

/* --------------------------------------------------------------------------
 * Layout: dónde vive cada actor. El reach (0..1) interpola la separación
 * inicial hacia el punto de contacto.
 * ------------------------------------------------------------------------ */

type Layout = {
  wide: boolean;
  body: { x0: number; x1: number; baseY: number; height: number; rotY: number };
  fig: { y: number; scale: number };
  core0: THREE.Vector3;
  core1: THREE.Vector3;
  coreR: number;
  handDX: number;
  handY: number;
};

function computeLayout(w: number, h: number): Layout {
  const wide = w / h > 1.05;
  if (wide) {
    const body = {
      x0: -w * 0.335,
      x1: -w * 0.135,
      baseY: -h * 0.405,
      height: h * 0.65,
      rotY: 1.08,
    };
    const handDX = h * 0.21;
    const handY = body.baseY + body.height * 0.78;
    const coreR = Math.min(h * 0.095, w * 0.055);
    const core0 = new THREE.Vector3(w * 0.385, handY + h * 0.07, 0);
    const core1 = new THREE.Vector3(body.x1 + handDX + coreR * 0.85, handY + h * 0.015, 0);
    return {
      wide,
      body,
      fig: { y: body.baseY, scale: h * 0.66 },
      core0,
      core1,
      coreR,
      handDX,
      handY,
    };
  }
  // Angosto: composición vertical — humano abajo-izquierda, núcleo
  // arriba-derecha; el contacto ocurre en diagonal.
  const body = { x0: -w * 0.34, x1: -w * 0.2, baseY: -h * 0.46, height: h * 0.52, rotY: 0.9 };
  const handDX = h * 0.17;
  const handY = body.baseY + body.height * 0.78;
  const coreR = h * 0.05;
  const core0 = new THREE.Vector3(w * 0.3, h * 0.28, 0);
  const core1 = new THREE.Vector3(body.x1 + handDX + coreR * 1.1, handY + h * 0.055, 0);
  return {
    wide,
    body,
    fig: { y: body.baseY, scale: h * 0.5 },
    core0,
    core1,
    coreR,
    handDX,
    handY,
  };
}

/** El control de la bezier del río, recalculado con la mano viva. */
function riverCtrl(
  out: THREE.Vector3,
  hand: THREE.Vector3,
  core: THREE.Vector3,
  layout: Layout,
  w: number,
  h: number,
) {
  out.copy(hand).add(core).multiplyScalar(0.5);
  if (layout.wide) {
    out.y += Math.max(0.2, (core.x - hand.x) * 0.26);
    out.z = 0.4;
  } else {
    out.x += w * 0.055;
    out.y -= h * 0.015;
    out.z = 0.3;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Shaders. `SEQ_GLSL` es el pedazo compartido de la secuencia: anticipación
 * (inhalar hacia el contacto), estallido radial con turbulencia curl,
 * convergencia con overshoot al wordmark y shimmer de cierre. La mezcla vive
 * en la GPU; el CPU sólo escribe uniforms.
 * ------------------------------------------------------------------------ */

const SEQ_GLSL = /* glsl */ `
  uniform float uReach;
  uniform float uSuck;
  uniform float uBang;
  uniform float uForm;
  uniform float uMood;
  uniform vec3 uContact;
  uniform float uBangR;
  uniform vec3 uWordC;
  uniform float uWordS;
  uniform float uWordHalf;
  uniform float uShine;

  attribute vec2 aWord;

  varying float vIri;

  /* Curl barato con la posición como semilla: remolinos orgánicos, no rayos. */
  vec3 curlAt(vec3 q, float t) {
    vec3 c = q * 0.55;
    return vec3(
      sin(c.y * 1.3 + t * 0.7) - sin(c.z * 1.1 - t * 0.6),
      sin(c.z * 1.2 + t * 0.8) - sin(c.x * 1.4 + t * 0.5),
      sin(c.x * 1.1 - t * 0.7) - sin(c.y * 1.2 + t * 0.6)
    );
  }

  /* Devuelve la posición de secuencia y deja en outGlow el extra de luz. */
  vec3 seqPos(vec3 p, float seed, float t, out float outGlow) {
    outGlow = 0.0;
    vIri = 0.0;

    // La anticipación: todo inhala hacia el punto de contacto.
    p = mix(p, uContact, uSuck * (0.10 + 0.12 * fract(seed * 9.7)));

    if (uBang < 0.001) return p;

    // El estallido: radial desde el contacto, con jitter por semilla.
    vec3 d = p - uContact;
    float L = max(length(d), 1e-4);
    vec3 dir = d / L + 0.6 * vec3(sin(seed * 91.0), cos(seed * 57.0), sin(seed * 23.0) * 0.5);
    dir = normalize(dir);
    float speed = 0.45 + 1.05 * fract(seed * 7.7);
    float travel = uBangR * speed * uBang;
    vec3 pB = p + dir * travel;

    // Turbulencia curl mientras vuela; muere al formarse el wordmark.
    float turb = uBang * (1.0 - uForm);
    pB += turb * 0.85 * curlAt(pB, t);

    // Iridiscencia por velocidad, sólo en vuelo: rápidas → cian, lentas → rosa.
    vIri = (fract(seed * 7.7) - 0.5) * 2.0 * turb;

    // La convergencia, escalonada por partícula, con llegada en overshoot
    // (back-ease): pasa apenas del glifo y se asienta.
    float lag = fract(seed * 5.13) * 0.4;
    float ft = clamp((uForm - lag) / max(1.0 - lag, 1e-3), 0.0, 1.0);
    float f1 = ft - 1.0;
    float fb = ft <= 0.0 ? 0.0 : 1.0 + 2.4 * f1 * f1 * f1 + 1.4 * f1 * f1;
    vec3 pW = vec3(uWordC.xy + aWord * uWordS, uWordC.z + (fract(seed * 3.3) - 0.5) * 0.14);

    // El shimmer de cierre: una banda de luz recorre el wordmark una vez.
    if (uShine > 0.001 && uShine < 0.999 && ft > 0.6) {
      float wx = aWord.x / uWordHalf;
      float band = exp(-pow((wx - (uShine * 2.4 - 1.2)) * 2.8, 2.0));
      outGlow = band * 1.8 * ft;
    }

    return mix(pB, pW, clamp(fb, 0.0, 1.1));
  }
`;

/** La rampa de color y el disco del fragmento, compartidos. `uSoft` abre el
 * borde: 0 = partícula nítida, 1 = la capa gemela de bloom. */
const FRAG_COMMON = /* glsl */ `
  uniform vec3 uColDeep;
  uniform vec3 uColMid;
  uniform vec3 uColHot;
  uniform float uAlpha;
  uniform float uSoft;
  varying float vI;
  varying float vIri;

  vec3 ramp(float x) {
    vec3 c = mix(uColDeep, uColMid, clamp(x, 0.0, 1.0));
    return mix(c, uColHot, clamp(x - 1.0, 0.0, 1.0));
  }

  vec4 shade(float boost) {
    float edge = mix(0.14, 0.38, uSoft);
    float m = smoothstep(0.5, edge, length(gl_PointCoord - 0.5));
    if (m < 0.02) discard;
    vec3 col = ramp(vI * boost);
    col = mix(col, vec3(0.58, 0.86, 1.0), clamp(vIri, 0.0, 1.0) * 0.32);
    col = mix(col, vec3(1.0, 0.63, 0.78), clamp(-vIri, 0.0, 1.0) * 0.32);
    return vec4(col * vI, uAlpha * m);
  }
`;

const FIGURE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec2 uFigOff;
  uniform float uFigScale;
  uniform vec2 uHand;
  uniform vec3 uPointer;
  uniform float uPointerK;
  uniform float uInvite;
  uniform float uInviteK;

  attribute float aSeed;
  varying float vI;

  ${SEQ_GLSL}

  const float TAU = 6.2831853;

  void main() {
    vec3 p = vec3(position.xy * uFigScale + uFigOff, position.z);

    float br = sin(uTime * TAU / ${BREATHE_S.toFixed(1)});
    float torso = smoothstep(0.35, 0.75, position.y);
    p.y += br * 0.022 * torso * uFigScale * 0.12;
    p.x += br * 0.006 * (position.x) * torso * uFigScale;

    p += 0.02 * vec3(
      sin(uTime * 0.9 + aSeed * 43.0),
      cos(uTime * 0.8 + aSeed * 91.0),
      sin(uTime * 1.1 + aSeed * 17.0)
    );

    float d = distance(p.xy, uPointer.xy);
    float g = smoothstep(1.2, 0.1, d) * uPointerK;
    p.xy += (uPointer.xy - p.xy) * g * 0.06;

    float glow;
    p = seqPos(p, aSeed, uTime, glow);

    // El brazo como cápsula en espacio unitario de la silueta (hombro→
    // mano): fuera de ella ni el glow de la mano ni el shimmer existen —
    // jamás torso ni cabeza.
    vec2 armA = vec2(0.065, 0.733);
    vec2 ab = uHand - armA;
    float armH = clamp(dot(position.xy - armA, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    float armMask = smoothstep(0.06, 0.028, distance(position.xy, armA + ab * armH));

    float handGlow = smoothstep(0.3, 0.05, distance(position.xy, uHand)) * armMask *
      (0.55 + 0.45 * sin(uTime * 2.6)) * (1.0 + 1.6 * uReach) * (1.0 - uBang);

    // La respuesta a la llamada (fase 0): una banda angosta de luz que
    // recorre el brazo hombro→mano. σ ≈ 10% del largo del brazo: un
    // pulso que viaja, no un baño.
    float inv = 0.0;
    if (uInviteK > 0.001) {
      inv = exp(-pow((armH - uInvite) / 0.10, 2.0)) * armMask * uInviteK;
    }

    // El mismo tope que en la figura real: la luz de la mano ilumina, no
    // borra; el margen crece con el reach real (> 0.25).
    float lit = min(handGlow * 0.9 + inv, 0.55 + 1.7 * max(uReach - 0.25, 0.0));

    vI = (0.62 + 0.48 * fract(aSeed * 7.31) + lit + g * 0.35 + glow) * uMood;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // Niebla de profundidad: lo lejano se atenúa, el campo respira aire.
    vI *= 1.0 - 0.32 * clamp((-mv.z - 13.5) / 8.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.65 + 0.6 * fract(aSeed * 3.17)) * (1.0 + 0.35 * g) * (1.0 - 0.35 * uForm) * uDpr * (55.0 / -mv.z);
  }
`;

/**
 * El humano real: GPU skinning en el vértice (la fórmula de los chunks
 * `skinning_vertex` de three, en GLSL1 para correr igual en WebGL1 y 2),
 * seguido de la mezcla de secuencia.
 */
const BODY_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform float uAppear;
  uniform sampler2D uBoneTex;
  uniform float uBoneTexSize;
  uniform mat4 uBind;
  uniform mat4 uBindInv;
  uniform mat4 uXform;
  uniform vec3 uHand;
  uniform vec3 uShoulder;
  uniform vec3 uPointer;
  uniform float uPointerK;
  uniform float uInvite;
  uniform float uInviteK;

  attribute vec4 aSkinIndex;
  attribute vec4 aSkinWeight;
  attribute float aSeed;
  attribute float aTone;
  attribute float aArm;
  varying float vI;

  ${SEQ_GLSL}

  mat4 boneAt(const in float i) {
    float j = i * 4.0;
    float x = mod(j, uBoneTexSize);
    float y = floor(j / uBoneTexSize);
    float dx = 1.0 / uBoneTexSize;
    float dy = 1.0 / uBoneTexSize;
    y = dy * (y + 0.5);
    vec4 v1 = texture2D(uBoneTex, vec2(dx * (x + 0.5), y));
    vec4 v2 = texture2D(uBoneTex, vec2(dx * (x + 1.5), y));
    vec4 v3 = texture2D(uBoneTex, vec2(dx * (x + 2.5), y));
    vec4 v4 = texture2D(uBoneTex, vec2(dx * (x + 3.5), y));
    return mat4(v1, v2, v3, v4);
  }

  void main() {
    vec4 sv = uBind * vec4(position, 1.0);
    vec4 sk = boneAt(aSkinIndex.x) * sv * aSkinWeight.x
            + boneAt(aSkinIndex.y) * sv * aSkinWeight.y
            + boneAt(aSkinIndex.z) * sv * aSkinWeight.z
            + boneAt(aSkinIndex.w) * sv * aSkinWeight.w;
    vec3 p = (uXform * vec4((uBindInv * sk).xyz, 1.0)).xyz;

    p += 0.018 * vec3(
      sin(uTime * 0.9 + aSeed * 43.0),
      cos(uTime * 0.8 + aSeed * 91.0),
      sin(uTime * 1.1 + aSeed * 17.0)
    );

    float d = distance(p.xy, uPointer.xy);
    float g = smoothstep(1.2, 0.1, d) * uPointerK;
    p.xy += (uPointer.xy - p.xy) * g * 0.06;

    // La pertenencia al brazo derecho (peso de skinning de RightArm/
    // RightForeArm/RightHand, horneado al muestrear): fuera del brazo,
    // ni el glow de la mano ni el shimmer existen — la cadera que la mano
    // roza en reposo no puede quemarse.
    float armMask = smoothstep(0.2, 0.65, aArm);

    // La energía se concentra en la mano que alcanza — y sube con el reach.
    float handGlow = smoothstep(0.6, 0.08, distance(p, uHand)) * armMask *
      (0.55 + 0.45 * sin(uTime * 2.6)) * (1.0 + 1.6 * uReach) * (1.0 - uBang);

    // La respuesta a la llamada (fase 0): una banda angosta de luz que
    // recorre el brazo hombro→mano por su eje. σ ≈ 10% del largo del
    // brazo — un pulso que viaja, no un gradiente que inunda.
    float inv = 0.0;
    if (uInviteK > 0.001) {
      vec3 ab = uHand - uShoulder;
      float h = clamp(dot(p - uShoulder, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
      inv = exp(-pow((h - uInvite) / 0.10, 2.0)) * armMask * uInviteK;
    }

    // El tope de luz de la mano: glow + shimmer iluminan, no borran — la
    // mano en reposo cuelga junto a la cadera y sin tope el apilado aditivo
    // de sus partículas densas la volvía una mancha quemada sobre el cuerpo.
    // El margen crece con el reach real (> 0.25): el clímax del contacto
    // conserva su brillo.
    float lit = min(handGlow * 0.9 + inv, 0.55 + 1.7 * max(uReach - 0.25, 0.0));

    float glow;
    p = seqPos(p, aSeed, uTime, glow);

    float tw = 0.86 + 0.14 * sin(uTime * (1.4 + fract(aSeed * 3.3) * 1.6) + aSeed * 61.0);

    vI = ((0.6 + 0.5 * fract(aSeed * 7.31)) * tw * aTone + lit + g * 0.35 + glow)
      * uAppear * uMood;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vI *= 1.0 - 0.32 * clamp((-mv.z - 13.5) / 8.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + 0.7 * fract(aSeed * 3.17)) * (1.0 + 0.35 * g) * (1.0 - 0.35 * uForm) * uDpr * (55.0 / -mv.z);
  }
`;

const FIGURE_FRAG = /* glsl */ `
  ${FRAG_COMMON}

  void main() {
    gl_FragColor = shade(0.9);
  }
`;

const CORE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uCore;
  uniform float uCoreR;

  attribute float aSeed;
  varying float vI;

  ${SEQ_GLSL}

  void main() {
    float r = length(position);
    float k = clamp(r, 0.0, 1.0);
    float ang = uTime * (0.22 + 1.5 * (1.0 - k)) * (1.0 + 1.4 * uReach) + aSeed * 6.2831853;
    float c = cos(ang);
    float s = sin(ang);
    vec3 q = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);

    float tilt = 0.22 * sin(uTime * 0.35);
    q = vec3(q.x, q.y * cos(tilt) - q.z * sin(tilt), q.y * sin(tilt) + q.z * cos(tilt));

    // El latido se acelera a medida que la mano se acerca.
    float beat = 1.0 + (0.045 + 0.05 * uReach) *
      sin(uTime * 6.2831853 / ${BREATHE_S.toFixed(1)} * (1.0 + 2.2 * uReach));
    vec3 p = uCore + q * uCoreR * beat;

    float glow;
    p = seqPos(p, aSeed, uTime, glow);

    vI = (mix(1.7, 0.5, k) * (1.0 + 0.5 * uReach) + glow) * uMood;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vI *= 1.0 - 0.32 * clamp((-mv.z - 13.5) / 8.0, 0.0, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + 0.9 * fract(aSeed * 5.19)) * (1.0 - 0.35 * uForm) * uDpr * (55.0 / -mv.z);
  }
`;

const CORE_FRAG = /* glsl */ `
  ${FRAG_COMMON}

  void main() {
    gl_FragColor = shade(0.55);
  }
`;

const RINGS_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uCore;
  uniform float uCoreR;

  attribute float aAngle;
  attribute float aRing;
  attribute float aSeed;
  varying float vI;

  ${SEQ_GLSL}

  vec3 tiltRing(vec3 p, float ring) {
    if (ring < 0.5) {
      float c = cos(1.15); float s = sin(1.15);
      return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
    } else if (ring < 1.5) {
      float c = cos(-0.9); float s = sin(-0.9);
      vec3 q = vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
      float c2 = cos(0.7); float s2 = sin(0.7);
      return vec3(q.x * c2 + q.z * s2, q.y, -q.x * s2 + q.z * c2);
    }
    float c = cos(0.5); float s = sin(0.5);
    vec3 q = vec3(p.x * c - p.y * s, p.x * s + p.y * c, p.z);
    float c2 = cos(1.9); float s2 = sin(1.9);
    return vec3(q.x, q.y * c2 - q.z * s2, q.y * s2 + q.z * c2);
  }

  void main() {
    float radius = uCoreR * (1.45 + aRing * 0.36) * (1.0 + 0.05 * sin(uTime + aRing * 4.0));
    float speed = ((aRing < 0.5) ? 0.55 : ((aRing < 1.5) ? -0.4 : 0.3)) * (1.0 + 1.6 * uReach);
    float a = aAngle + uTime * speed;
    vec3 local = vec3(cos(a) * radius, sin(a) * radius, 0.0);
    local += (fract(vec3(aSeed * 3.1, aSeed * 7.7, aSeed * 5.3)) - 0.5) * uCoreR * 0.09;
    local = tiltRing(local, aRing);

    vec3 p = uCore + local;
    float glow;
    p = seqPos(p, aSeed, uTime, glow);

    float head = pow(0.5 + 0.5 * cos(a - uTime * (1.2 + aRing * 0.5)), 6.0);
    vI = (0.35 + 0.5 * fract(aSeed * 9.1) + head * 1.6 + glow) * uMood;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vI *= 1.0 - 0.32 * clamp((-mv.z - 13.5) / 8.0, 0.0, 1.0);
    gl_PointSize = uSize * (0.5 + 0.7 * fract(aSeed * 4.7)) * (1.0 - 0.35 * uForm) * uDpr * (55.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const RIVER_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uCtrl;
  uniform vec3 uPointer;
  uniform float uPointerK;

  attribute float aPhase;
  attribute float aDir;
  attribute float aSeed;
  varying float vI;
  varying float vIri;

  vec3 bez(float t) {
    float u = 1.0 - t;
    return u * u * uA + 2.0 * u * t * uCtrl + t * t * uB;
  }

  void main() {
    float pace = 0.7 + 0.6 * fract(aSeed * 3.7);
    float speed = 0.12 * pace;
    float dir = aDir > 0.5 ? 1.0 : -1.0;
    float t = fract(aPhase + uTime * speed * dir);

    vec3 p = bez(t);
    vec3 tang = normalize(bez(min(t + 0.02, 1.0)) - bez(max(t - 0.02, 0.0)) + vec3(1e-5));
    vec3 n1 = normalize(vec3(-tang.y, tang.x, 0.0));

    float len = distance(uA, uB);
    float mid = sin(3.14159 * t);
    float lane = (fract(aSeed * 13.7) - 0.5) * 2.0;
    p += n1 * lane * len * (0.03 + 0.085 * mid);
    p.z += (fract(aSeed * 29.3) - 0.5) * len * 0.14 * mid;
    p += n1 * sin(uTime * (1.2 + fract(aSeed * 5.0)) + aSeed * 40.0) * len * 0.018;

    float d = distance(p.xy, uPointer.xy);
    float g = smoothstep(2.4, 0.0, d) * uPointerK;
    p.xy += (uPointer.xy - p.xy) * g * 0.4;

    // Iridiscencia permanente del río: las chispas rápidas tiran a cian,
    // las lentas a rosa — un caudal con espectro, no un trazo plano.
    vIri = (pace - 1.0) * 1.6;

    float ends = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.94, t);
    vI = (0.5 + 0.7 * fract(aSeed * 7.3)) * ends * (1.0 + g * 1.6);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.55 + 0.8 * fract(aSeed * 11.3)) * uDpr * (55.0 / -mv.z);
  }
`;

/**
 * Los zarcillos de invitación (fase 0): un puñado de chispas sale del núcleo
 * (uA) hacia la mano (uB) por la misma bezier del río — el mismo lenguaje
 * visual, dirección invertida y vida efímera. `uCall` es la vida de la
 * llamada (0..1); `uCallSeed` resembra los zarcillos en cada «ven».
 */
const TENDRIL_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uA;
  uniform vec3 uB;
  uniform vec3 uCtrl;
  uniform float uCall;
  uniform float uCallSeed;

  attribute float aPhase;
  attribute float aSeed;
  varying float vI;
  varying float vIri;

  vec3 bez(float t) {
    float u = 1.0 - t;
    return u * u * uA + 2.0 * u * t * uCtrl + t * t * uB;
  }

  void main() {
    // Reseed por llamada: cada invitación dibuja zarcillos distintos.
    float s = fract(aSeed + uCallSeed * 19.73);
    // Hasta dónde llega este zarcillo: de medio camino a rozar la mano.
    float span = 0.45 + 0.5 * fract(s * 3.9);
    // La cabeza avanza con la llamada; la cola la sigue con retraso —
    // ease-out: sale decidido del núcleo y llega suave.
    float head = uCall * (1.15 + 0.3 * fract(s * 7.1));
    float tt = clamp(head - aPhase * 0.4, 0.0, 1.0);
    float et = 1.0 - (1.0 - tt) * (1.0 - tt);
    float tc = et * span;
    vec3 p = bez(tc);

    vec3 tang = normalize(bez(min(tc + 0.02, 1.0)) - bez(max(tc - 0.02, 0.0)) + vec3(1e-5));
    vec3 n1 = normalize(vec3(-tang.y, tang.x, 0.0));
    float len = distance(uA, uB);
    float mid = sin(3.14159 * clamp(tc / max(span, 1e-3), 0.0, 1.0));
    p += n1 * (fract(s * 13.7) - 0.5) * len * 0.06 * mid;
    p.z += (fract(s * 29.3) - 0.5) * len * 0.09 * mid;
    p += n1 * sin(uTime * (1.6 + fract(s * 5.0)) + s * 40.0) * len * 0.012;

    // La disolución: al final de la llamada las chispas se abren y mueren.
    float dis = smoothstep(0.62, 1.0, uCall);
    p += dis * len * 0.14 * (fract(vec3(s * 9.1, s * 4.3, s * 6.7)) - 0.5) * 2.0;

    vIri = (fract(s * 7.7) - 0.5) * 1.4;

    float born = smoothstep(0.0, 0.05, tt);
    // Brillantes de verdad: la cabeza del zarcillo casi blanca, la cola violeta.
    vI = (0.9 + 0.9 * fract(s * 7.3)) * born * (1.0 - 0.45 * aPhase) * (1.0 - dis)
      * (0.8 + 0.2 * sin(uTime * 7.0 + s * 50.0)) * (1.0 + 1.4 * exp(-6.0 * aPhase));

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.55 + 0.8 * fract(s * 11.3)) * uDpr * (55.0 / -mv.z);
  }
`;

const SPARK_FRAG = /* glsl */ `
  ${FRAG_COMMON}

  void main() {
    gl_FragColor = shade(0.5);
  }
`;

const HALO_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const HALO_FRAG = /* glsl */ `
  uniform float uTime;
  uniform float uFade;
  uniform float uExcite;
  uniform vec3 uColor;
  varying vec2 vUv;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float beat = 0.8 + 0.2 * sin(uTime * 6.2831853 / ${BREATHE_S.toFixed(1)} * (1.0 + 2.2 * uExcite));
    float a = exp(-d * 4.2) * 0.55 * beat * (1.0 + 0.65 * uExcite)
      + exp(-d * 1.6) * 0.12 * beat;
    a *= smoothstep(1.0, 0.6, d) * uFade;
    gl_FragColor = vec4(uColor, a);
  }
`;

/* --------------------------------------------------------------------------
 * La escena
 * ------------------------------------------------------------------------ */

/* La paleta graduada: sombras índigo, medios violeta, altas luces blanco
 * cálido. El morado plano queda prohibido por rampa. */
const COL_DEEP = new THREE.Color('#4438c9');
const COL_MID = new THREE.Color('#8d85f5');
const COL_HOT = new THREE.Color('#fff1e2');
const COL_CORE_MID = new THREE.Color('#a89fff');
const COL_HALO = new THREE.Color('#a89fff');

const PARTICLE_BLEND = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
} as const;

/** Los uniforms de la secuencia: UN objeto {value} por uniform, COMPARTIDO
 * entre todos los materiales — escribir una vez mueve todos los draw calls. */
function makeSeqUniforms() {
  return {
    uReach: { value: 0 },
    uSuck: { value: 0 },
    uBang: { value: 0 },
    uForm: { value: 0 },
    uMood: { value: 1 },
    uContact: { value: new THREE.Vector3() },
    uBangR: { value: 10 },
    uWordC: { value: new THREE.Vector3() },
    uWordS: { value: 1 },
    uWordHalf: { value: 2.3 },
    uShine: { value: 0 },
  };
}
type SeqUniforms = ReturnType<typeof makeSeqUniforms>;

type UniformMap = Record<string, { value: unknown }>;

/**
 * La capa gemela de bloom: mismo shader y MISMOS objetos de uniform salvo
 * tamaño (×2.6), alpha (~25%) y borde suave. Es lo que hace que todo brille
 * de verdad sin postprocesado.
 */
const GLOW_SIZE = 2.2;
const GLOW_ALPHA = 0.16;

function makeGlowMaterial(vertexShader: string, fragmentShader: string, u: UniformMap) {
  const size = (u.uSize as { value: number }).value;
  const alpha = (u.uAlpha as { value: number }).value;
  return new THREE.ShaderMaterial({
    ...PARTICLE_BLEND,
    vertexShader,
    fragmentShader,
    uniforms: {
      ...u,
      uSize: { value: size * GLOW_SIZE },
      uAlpha: { value: alpha * GLOW_ALPHA },
      uSoft: { value: 1 },
    },
  });
}

/** El estado vivo que el loop del padre escribe y las figuras leen. */
type Live = {
  bodyX: number;
  core: THREE.Vector3;
  aimW: number;
  /** Fase 0 — el bob de flotación en unidades de mundo (ya × idleK). */
  floatY: number;
  /** Fase 0 — la deriva de rotación del cuerpo, en radianes (ya × idleK). */
  floatRot: number;
  /** Fase 0 — el pulso suavizado de la llamada (0..1, ya × idleK): eleva
   * el hombro unos grados vía el peso del aim y vuelve. */
  invite: number;
};

type FigureShared = {
  uTime: { value: number };
  uDpr: { value: number };
  uPointer: { value: THREE.Vector3 };
  uPointerK: { value: number };
  /** Progreso del frente del shimmer de respuesta (0 = hombro, 1 = mano). */
  uInvite: { value: number };
  /** Intensidad del shimmer (0 = apagado). */
  uInviteK: { value: number };
};

type FigureProps = {
  mobile: boolean;
  layout: Layout;
  live: Live;
  seqU: SeqUniforms;
  register: (u: FigureShared | null) => void;
  anchor: { hand: THREE.Vector3 | null };
  onFigureReady: () => void;
};

/* ---- El respaldo: la silueta procedural ---------------------------------- */

function FigureFallback({
  mobile,
  layout,
  live,
  seqU,
  register,
  anchor,
  onFigureReady,
}: FigureProps) {
  const count = Math.round(27_000 * (mobile ? 0.4 : 1));

  // biome-ignore lint/correctness/useExhaustiveDependencies: los buffers se generan una vez por montaje.
  const built = useMemo(() => {
    const human = sampleHuman(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(human.pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(human.seed, 1));
    geo.setAttribute('aWord', new THREE.BufferAttribute(wordAttr(count), 2));
    const u = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.15 },
      uFigOff: { value: new THREE.Vector2() },
      uFigScale: { value: 8 },
      uHand: { value: new THREE.Vector2(HAND_UNIT[0], HAND_UNIT[1]) },
      uPointer: { value: new THREE.Vector3(999, 999, 0) },
      uPointerK: { value: 0 },
      uInvite: { value: 0 },
      uInviteK: { value: 0 },
      uColDeep: { value: COL_DEEP },
      uColMid: { value: COL_MID },
      uColHot: { value: COL_HOT },
      uAlpha: { value: 0.46 },
      uSoft: { value: 0 },
      ...seqU,
    };
    const mat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: FIGURE_VERT,
      fragmentShader: FIGURE_FRAG,
      uniforms: u,
    });
    const glow = makeGlowMaterial(FIGURE_VERT, FIGURE_FRAG, u);
    return { geo, mat, glow, u };
  }, []);

  useEffect(() => {
    const a = mobile ? 0.36 : 0.46;
    built.u.uAlpha.value = a;
    (built.glow.uniforms.uAlpha as { value: number }).value = a * GLOW_ALPHA;
  }, [mobile, built]);

  useEffect(() => {
    register(built.u);
    anchor.hand = null;
    onFigureReady();
    return () => register(null);
  }, [built, register, anchor, onFigureReady]);

  useEffect(
    () => () => {
      built.geo.dispose();
      built.mat.dispose();
      built.glow.dispose();
    },
    [built],
  );

  useFrame(() => {
    // El bob de flotación de fase 0 entra por el offset: cero costo extra.
    built.u.uFigOff.value.set(live.bodyX, layout.fig.y + live.floatY);
    built.u.uFigScale.value = layout.fig.scale;
  });

  return (
    <>
      <points geometry={built.geo} material={built.glow} frustumCulled={false} />
      <points geometry={built.geo} material={built.mat} frustumCulled={false} />
    </>
  );
}

/* ---- El humano real: GLB muestreado + GPU skinning ---------------------- */

function FigureReal({ mobile, layout, live, seqU, register, anchor, onFigureReady }: FigureProps) {
  const gltf = useGLTF(MODEL_URL, false, false, extendLoader);
  const count = Math.round(30_000 * (mobile ? 0.4 : 1));

  const built = useMemo(() => {
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
    });
    const first = meshes[0];
    if (!first) throw new Error('human.glb no trae mallas con esqueleto');

    const tones = meshes.map((m) => (/joint/i.test(m.name) ? 0.45 : 1));
    const sampled = sampleSkinnedMeshes(meshes, count, tones);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sampled.pos, 3));
    geo.setAttribute('aSkinIndex', new THREE.BufferAttribute(sampled.skinIndex, 4));
    geo.setAttribute('aSkinWeight', new THREE.BufferAttribute(sampled.skinWeight, 4));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(sampled.seed, 1));
    geo.setAttribute('aTone', new THREE.BufferAttribute(sampled.tone, 1));
    geo.setAttribute('aWord', new THREE.BufferAttribute(wordAttr(count), 2));

    const skeleton = first.skeleton;
    if (!skeleton.boneTexture) skeleton.computeBoneTexture();
    const boneTex = skeleton.boneTexture as THREE.DataTexture;

    // La pertenencia al brazo derecho, horneada del skinning: la suma de
    // pesos sobre RightArm/RightForeArm/RightHand (y dedos). El shimmer de
    // invitación vive SOLO donde aArm ≈ 1 — el torso queda en cero.
    const armBoneIdx = new Set<number>();
    skeleton.bones.forEach((b, i) => {
      if (/Right(Arm|ForeArm|Hand)/.test(b.name)) armBoneIdx.add(i);
    });
    const armW = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      let a = 0;
      for (let j = 0; j < 4; j++) {
        if (armBoneIdx.has(sampled.skinIndex[i * 4 + j] ?? -1))
          a += sampled.skinWeight[i * 4 + j] ?? 0;
      }
      armW[i] = a;
    }
    geo.setAttribute('aArm', new THREE.BufferAttribute(armW, 1));

    const bbox = new THREE.Box3().setFromObject(root);
    const modelH = Math.max(1e-6, bbox.max.y - bbox.min.y);
    const minY = bbox.min.y;

    const mixer = new THREE.AnimationMixer(root);
    const idle = gltf.animations.find((c) => c.name === 'idle') ?? gltf.animations[0] ?? null;
    if (idle) mixer.clipAction(idle).play();

    const boneBy = (suffix: string) => skeleton.bones.find((b) => b.name.endsWith(suffix)) ?? null;
    const armBone = boneBy('RightArm');
    const foreBone = boneBy('RightForeArm');
    const handBone = boneBy('RightHand');

    const u = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.12 },
      uAppear: { value: 0 },
      uBoneTex: { value: boneTex },
      uBoneTexSize: { value: boneTex.image.width },
      uBind: { value: first.bindMatrix },
      uBindInv: { value: first.bindMatrixInverse },
      uXform: { value: new THREE.Matrix4() },
      uHand: { value: new THREE.Vector3() },
      uShoulder: { value: new THREE.Vector3() },
      uPointer: { value: new THREE.Vector3(999, 999, 0) },
      uPointerK: { value: 0 },
      uInvite: { value: 0 },
      uInviteK: { value: 0 },
      uColDeep: { value: COL_DEEP },
      uColMid: { value: COL_MID },
      uColHot: { value: COL_HOT },
      uAlpha: { value: 0.5 },
      uSoft: { value: 0 },
      ...seqU,
    };
    const mat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: BODY_VERT,
      fragmentShader: FIGURE_FRAG,
      uniforms: u,
    });
    const glow = makeGlowMaterial(BODY_VERT, FIGURE_FRAG, u);

    return {
      root,
      geo,
      mat,
      glow,
      u,
      skeleton,
      meshWorld: first.matrixWorld.clone(),
      mixer,
      modelH,
      minY,
      armBone,
      foreBone,
      handBone,
    };
  }, [gltf, count, seqU]);

  useEffect(() => {
    const a = mobile ? 0.4 : 0.5;
    built.u.uAlpha.value = a;
    (built.glow.uniforms.uAlpha as { value: number }).value = a * GLOW_ALPHA;
  }, [mobile, built]);

  useEffect(() => {
    register(built.u);
    onFigureReady();
    return () => {
      register(null);
      anchor.hand = null;
    };
  }, [built, register, anchor, onFigureReady]);

  useEffect(
    () => () => {
      built.geo.dispose();
      built.mat.dispose();
      built.glow.dispose();
      built.mixer.stopAllAction();
    },
    [built],
  );

  const scratch = useMemo(
    () => ({
      layoutMat: new THREE.Matrix4(),
      layoutInv: new THREE.Matrix4(),
      pos: new THREE.Vector3(),
      quatY: new THREE.Quaternion(),
      scl: new THREE.Vector3(),
      coreModel: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      cur: new THREE.Vector3(),
      des: new THREE.Vector3(),
      qDelta: new THREE.Quaternion(),
      qWorld: new THREE.Quaternion(),
      qParent: new THREE.Quaternion(),
      qLocal: new THREE.Quaternion(),
      hand: new THREE.Vector3(),
      shoulder: new THREE.Vector3(),
      appear: 0,
    }),
    [],
  );

  const aimBone = (bone: THREE.Bone, child: THREE.Bone, target: THREE.Vector3, weight: number) => {
    const s = scratch;
    s.a.setFromMatrixPosition(bone.matrixWorld);
    s.b.setFromMatrixPosition(child.matrixWorld);
    s.cur.subVectors(s.b, s.a);
    s.des.subVectors(target, s.a);
    if (s.cur.lengthSq() < 1e-10 || s.des.lengthSq() < 1e-10) return;
    s.cur.normalize();
    s.des.normalize();
    s.qDelta.setFromUnitVectors(s.cur, s.des);
    bone.getWorldQuaternion(s.qWorld);
    s.qWorld.premultiply(s.qDelta);
    if (bone.parent) {
      bone.parent.getWorldQuaternion(s.qParent);
      s.qLocal.copy(s.qParent).invert().multiply(s.qWorld);
    } else {
      s.qLocal.copy(s.qWorld);
    }
    bone.quaternion.slerp(s.qLocal, weight);
    bone.updateMatrixWorld(true);
  };

  useFrame((_, delta) => {
    const s = scratch;
    const dt = Math.min(delta, 1 / 20);

    // 1. La colocación del cuerpo: x vivo (el reach lo acerca al núcleo).
    //    En fase 0 el humano FLOTA: bob vertical y deriva de rotación por
    //    transform del grupo — ingrávido, sin tocar una sola partícula.
    const k = layout.body.height / built.modelH;
    s.quatY.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, layout.body.rotY + live.floatRot);
    s.pos.set(live.bodyX, layout.body.baseY - built.minY * k + live.floatY, 0);
    s.scl.setScalar(k);
    s.layoutMat.compose(s.pos, s.quatY, s.scl);
    built.u.uXform.value.multiplyMatrices(s.layoutMat, built.meshWorld);

    // 2. El esqueleto respira con idle.
    built.mixer.update(dt);
    s.appear = Math.min(1, s.appear + dt / 1.1);
    built.root.updateMatrixWorld(true);

    // 3. El gesto: el brazo apunta al núcleo con el peso que dicta el scroll
    //    (live.aimW = reach): al inicio cuelga, al contacto está extendido.
    //    En fase 0, cada llamada de la IA suma un peso pequeño (live.invite):
    //    el hombro se eleva unos 3° hacia el núcleo con lerp suave y vuelve.
    if (built.armBone && built.foreBone && built.handBone) {
      s.layoutInv.copy(s.layoutMat).invert();
      s.coreModel.copy(live.core).applyMatrix4(s.layoutInv);
      const w = Math.min(1, live.aimW * 0.95 + live.invite * 0.07);
      if (w > 0.001) {
        aimBone(built.armBone, built.foreBone, s.coreModel, w);
        aimBone(built.foreBone, built.handBone, s.coreModel, w);
      }
    }

    // 4. La textura de huesos, al día.
    built.skeleton.update();

    // 5. La mano real ancla el río y el glow; el hombro, el arranque del
    //    shimmer de respuesta (la banda viaja hombro→mano por ese eje).
    if (built.handBone) {
      s.hand.setFromMatrixPosition(built.handBone.matrixWorld).applyMatrix4(s.layoutMat);
      anchor.hand = s.hand;
      built.u.uHand.value.copy(s.hand);
    }
    if (built.armBone) {
      s.shoulder.setFromMatrixPosition(built.armBone.matrixWorld).applyMatrix4(s.layoutMat);
      built.u.uShoulder.value.copy(s.shoulder);
    }
    built.u.uAppear.value = s.appear;
  });

  return (
    <>
      <points geometry={built.geo} material={built.glow} frustumCulled={false} />
      <points geometry={built.geo} material={built.mat} frustumCulled={false} />
    </>
  );
}

/* ---- El guardián: si el GLB no llega, la silueta entra sin ruido -------- */

class FigureBoundary extends Component<
  { fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    // Silencioso a propósito: el respaldo ES la respuesta al error.
  }
  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/* ---- Todos los actores --------------------------------------------------- */

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth01 = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
/** Cada fase con su curva: nada entra ni sale linealmente. */
const easeInOutCubic = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
const easeOutExpo = (x: number) => {
  const t = clamp01(x);
  return t >= 1 ? 1 : 1 - 2 ** (-10 * t);
};

type SceneProps = {
  mobile: boolean;
  progressRef: MutableRefObject<number>;
  onFigureReady: () => void;
};

function HeroActors({ mobile, progressRef, onFigureReady }: SceneProps) {
  const density = mobile ? 0.4 : 1;
  const counts = useMemo(
    () => ({
      core: Math.round(8_000 * density),
      rings: Math.round(2_400 * density),
      river: Math.round(3_000 * density),
      tend: Math.round(700 * density),
    }),
    [density],
  );

  const viewport = useThree((s) => s.viewport);
  const layout = useMemo(
    () => computeLayout(viewport.width, viewport.height),
    [viewport.width, viewport.height],
  );

  const seqU = useMemo(makeSeqUniforms, []);

  // --- Geometrías y materiales (una vez) ---------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: los buffers se generan una vez por montaje.
  const built = useMemo(() => {
    const corePos = new Float32Array(counts.core * 3);
    const coreSeed = new Float32Array(counts.core);
    for (let i = 0; i < counts.core; i++) {
      const r = Math.random() ** 0.62;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      corePos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      corePos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th) * 0.86;
      corePos[i * 3 + 2] = r * Math.cos(ph);
      coreSeed[i] = Math.random();
    }
    const coreGeo = new THREE.BufferGeometry();
    coreGeo.setAttribute('position', new THREE.BufferAttribute(corePos, 3));
    coreGeo.setAttribute('aSeed', new THREE.BufferAttribute(coreSeed, 1));
    coreGeo.setAttribute('aWord', new THREE.BufferAttribute(wordAttr(counts.core), 2));
    const coreU = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 0.85 },
      uCore: { value: new THREE.Vector3() },
      uCoreR: { value: 1 },
      uColDeep: { value: COL_DEEP },
      uColMid: { value: COL_CORE_MID },
      uColHot: { value: COL_HOT },
      uAlpha: { value: 0.42 },
      uSoft: { value: 0 },
      ...seqU,
    };
    const coreMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      uniforms: coreU,
    });
    const coreGlow = makeGlowMaterial(CORE_VERT, CORE_FRAG, coreU);

    const ringAngle = new Float32Array(counts.rings);
    const ringId = new Float32Array(counts.rings);
    const ringSeed = new Float32Array(counts.rings);
    const ringPos = new Float32Array(counts.rings * 3);
    for (let i = 0; i < counts.rings; i++) {
      ringAngle[i] = Math.random() * Math.PI * 2;
      ringId[i] = i % 3;
      ringSeed[i] = Math.random();
    }
    const ringsGeo = new THREE.BufferGeometry();
    ringsGeo.setAttribute('position', new THREE.BufferAttribute(ringPos, 3));
    ringsGeo.setAttribute('aAngle', new THREE.BufferAttribute(ringAngle, 1));
    ringsGeo.setAttribute('aRing', new THREE.BufferAttribute(ringId, 1));
    ringsGeo.setAttribute('aSeed', new THREE.BufferAttribute(ringSeed, 1));
    ringsGeo.setAttribute('aWord', new THREE.BufferAttribute(wordAttr(counts.rings), 2));
    const ringsU = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.0 },
      uCore: { value: new THREE.Vector3() },
      uCoreR: { value: 1 },
      uColDeep: { value: COL_DEEP },
      uColMid: { value: COL_CORE_MID },
      uColHot: { value: COL_HOT },
      uAlpha: { value: 0.55 },
      uSoft: { value: 0 },
      ...seqU,
    };
    const ringsMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: RINGS_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: ringsU,
    });

    const rvPhase = new Float32Array(counts.river);
    const rvDir = new Float32Array(counts.river);
    const rvSeed = new Float32Array(counts.river);
    const rvPos = new Float32Array(counts.river * 3);
    for (let i = 0; i < counts.river; i++) {
      rvPhase[i] = Math.random();
      rvDir[i] = i % 2;
      rvSeed[i] = Math.random();
    }
    const riverGeo = new THREE.BufferGeometry();
    riverGeo.setAttribute('position', new THREE.BufferAttribute(rvPos, 3));
    riverGeo.setAttribute('aPhase', new THREE.BufferAttribute(rvPhase, 1));
    riverGeo.setAttribute('aDir', new THREE.BufferAttribute(rvDir, 1));
    riverGeo.setAttribute('aSeed', new THREE.BufferAttribute(rvSeed, 1));
    const riverU = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.25 },
      uA: { value: new THREE.Vector3() },
      uB: { value: new THREE.Vector3() },
      uCtrl: { value: new THREE.Vector3() },
      uPointer: { value: new THREE.Vector3(999, 999, 0) },
      uPointerK: { value: 0 },
      uColDeep: { value: COL_DEEP },
      uColMid: { value: COL_MID },
      uColHot: { value: COL_HOT },
      uAlpha: { value: 0.95 },
      uSoft: { value: 0 },
    };
    const riverMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: RIVER_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: riverU,
    });
    const riverGlow = makeGlowMaterial(RIVER_VERT, SPARK_FRAG, riverU);

    // Los zarcillos de invitación (fase 0): pocos, brillantes, efímeros.
    const tdPhase = new Float32Array(counts.tend);
    const tdSeed = new Float32Array(counts.tend);
    const tdPos = new Float32Array(counts.tend * 3);
    for (let i = 0; i < counts.tend; i++) {
      tdPhase[i] = Math.random();
      tdSeed[i] = Math.random();
    }
    const tendGeo = new THREE.BufferGeometry();
    tendGeo.setAttribute('position', new THREE.BufferAttribute(tdPos, 3));
    tendGeo.setAttribute('aPhase', new THREE.BufferAttribute(tdPhase, 1));
    tendGeo.setAttribute('aSeed', new THREE.BufferAttribute(tdSeed, 1));
    const tendU = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.7 },
      uA: { value: new THREE.Vector3() },
      uB: { value: new THREE.Vector3() },
      uCtrl: { value: new THREE.Vector3() },
      uCall: { value: 0 },
      uCallSeed: { value: 0.37 },
      uColDeep: { value: COL_DEEP },
      uColMid: { value: COL_CORE_MID },
      uColHot: { value: COL_HOT },
      uAlpha: { value: 0 },
      uSoft: { value: 0 },
    };
    const tendMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: TENDRIL_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: tendU,
    });
    const tendGlow = makeGlowMaterial(TENDRIL_VERT, SPARK_FRAG, tendU);

    const haloGeo = new THREE.PlaneGeometry(1, 1);
    const haloU = {
      uTime: { value: 0 },
      uFade: { value: 1 },
      uExcite: { value: 0 },
      uColor: { value: COL_HALO },
    };
    const haloMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: haloU,
    });

    return {
      coreGeo,
      coreMat,
      coreGlow,
      coreU,
      ringsGeo,
      ringsMat,
      ringsU,
      riverGeo,
      riverMat,
      riverGlow,
      riverU,
      tendGeo,
      tendMat,
      tendGlow,
      tendU,
      haloGeo,
      haloMat,
      haloU,
    };
  }, []);

  useEffect(() => {
    const disposables = [
      built.coreGeo,
      built.coreMat,
      built.coreGlow,
      built.ringsGeo,
      built.ringsMat,
      built.riverGeo,
      built.riverMat,
      built.riverGlow,
      built.tendGeo,
      built.tendMat,
      built.tendGlow,
      built.haloGeo,
      built.haloMat,
    ];
    return () => {
      for (const item of disposables) item.dispose();
    };
  }, [built]);

  // --- La figura activa: real o respaldo ---------------------------------
  const figureShared = useRef<FigureShared | null>(null);
  const registerFigure = useMemo(
    () => (u: FigureShared | null) => {
      figureShared.current = u;
    },
    [],
  );
  const anchor = useMemo<{ hand: THREE.Vector3 | null }>(() => ({ hand: null }), []);

  /** Lo que el loop escribe y las figuras leen (posición viva del cuerpo). */
  const live = useMemo<Live>(
    () => ({
      bodyX: layout.body.x0,
      core: layout.core0.clone(),
      aimW: 0,
      floatY: 0,
      floatRot: 0,
      invite: 0,
    }),
    [layout],
  );

  // --- Entradas: puntero, progreso ---------------------------------------
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const tendRef = useRef<THREE.Group>(null);
  /** La llamada de la IA (fase 0): estado del metrónomo con jitter. */
  const callRef = useRef({ init: false, next: 0, t0: -1, dur: 1.7, seed: 0.37, sm: 0 });
  const pointerNdc = useRef(new THREE.Vector2(0, 0));
  const pointerWorld = useRef(new THREE.Vector3(999, 999, 0));
  const pointerAt = useRef(-10);
  const hasPointer = useRef(false);
  const clockRef = useRef(0);
  const smoothRef = useRef(0);
  const shineRef = useRef({ armed: true, t0: -1 });
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const ctrlScratch = useMemo(() => new THREE.Vector3(), []);
  const handScratch = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      pointerNdc.current.set(
        (e.clientX / window.innerWidth) * 2 - 1,
        -(e.clientY / window.innerHeight) * 2 + 1,
      );
      pointerAt.current = clockRef.current;
      hasPointer.current = true;
    };
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      pointerNdc.current.set(
        (t.clientX / window.innerWidth) * 2 - 1,
        -(t.clientY / window.innerHeight) * 2 + 1,
      );
      pointerAt.current = clockRef.current;
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onTouch);
    };
  }, []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime + 2.2;
    clockRef.current = t;
    const dpr = state.gl.getPixelRatio();
    const dt = Math.min(delta, 1 / 20);

    // --- La línea de tiempo: damping crítico + curva por fase ------------
    smoothRef.current += (progressRef.current - smoothRef.current) * Math.min(1, dt * 8);
    const P = smoothRef.current;
    const reach = easeInOutCubic(P / 0.3);

    // --- FASE 0: la vida en reposo, con el reloj — no con el scroll ------
    // idleK muere suave hacia P=0.15: scrollear ES responder, y la vida
    // idle se disuelve antes de que la narrativa tome el mando.
    const idleK = 1 - smooth01(P / 0.15);

    // La llamada de la IA: dura 1.7s, y entre el fin de una y el arranque
    // de la siguiente pasan 2.6–4.3s (≈ cada 4.3–6s, jamás metrónomo).
    const call = callRef.current;
    if (!call.init) {
      call.init = true;
      call.next = t + 1.6;
    }
    let callT = 0;
    if (call.t0 >= 0) {
      const c = (t - call.t0) / call.dur;
      if (c >= 1) {
        call.t0 = -1;
        call.next = t + 2.6 + Math.random() * 1.7;
      } else {
        callT = c;
      }
    } else if (idleK > 0.05 && t >= call.next) {
      call.t0 = t;
      call.seed = Math.random();
    }
    // El pulso de excitación: campana suave sobre la vida de la llamada.
    const callPulse = smooth01(callT / 0.2) * (1 - smooth01((callT - 0.55) / 0.45)) * idleK;
    // La anticipación: sube justo antes del contacto y se corta al estallar.
    const suck = smooth01((P - 0.262) / 0.032) * (1 - smooth01((P - 0.302) / 0.01));
    const bangT = clamp01((P - 0.305) / 0.145);
    const bang = bangT <= 0 ? 0 : easeOutExpo(bangT);
    const formT = clamp01((P - 0.45) / 0.3);
    const settle = smooth01((P - 0.75) / 0.25);

    // El pulso de la llamada entra por uReach: núcleo más brillante, anillos
    // y latido acelerados, mano con más glow — sin mover cuerpo ni cámara
    // (esos usan la variable local `reach`).
    seqU.uReach.value = reach + 0.25 * callPulse;
    seqU.uSuck.value = suck;
    seqU.uBang.value = bang;
    seqU.uForm.value = formT;
    // El humor de la luz: baja medio beat en la anticipación, cae en la
    // oscuridad relativa tras el bang, sube con el wordmark y cede al
    // producto al final.
    seqU.uMood.value =
      (1 - 0.5 * suck) *
      (1 - 0.35 * bang * (1 - formT)) *
      (1 + 0.35 * smooth01(formT)) *
      // El wordmark asentado queda como marca viva y discreta sobre el
      // producto — apagarlo del todo lo volvía un neón muerto.
      (1 - 0.82 * settle);
    seqU.uBangR.value = Math.max(viewport.width, viewport.height) * 0.75;
    seqU.uWordHalf.value = wordHalfW;
    const wordS = Math.min(viewport.height * 0.26, (viewport.width * 0.82) / (wordHalfW * 2));
    const shrinkK = layout.wide ? 0.45 : 0.6;
    const riseK = layout.wide ? 0.26 : 0.35;
    seqU.uWordS.value = wordS * (1 - shrinkK * settle);
    seqU.uWordC.value.set(0, viewport.height * (0.02 + riseK * settle), 0);

    // El shimmer de cierre: una sola pasada cuando el wordmark termina de
    // formarse; se rearma si el visitante vuelve atrás.
    const shine = shineRef.current;
    if (P < 0.5) {
      shine.armed = true;
      shine.t0 = -1;
    } else if (formT >= 0.995 && shine.armed) {
      shine.armed = false;
      shine.t0 = t + 0.15;
    }
    seqU.uShine.value = shine.t0 > 0 ? clamp01((t - shine.t0) / 0.9) : 0;

    // --- La colocación viva: el reach acerca cuerpo y núcleo -------------
    live.bodyX = layout.body.x0 + (layout.body.x1 - layout.body.x0) * reach;
    live.core.lerpVectors(layout.core0, layout.core1, reach);
    live.aimW = reach;
    seqU.uContact.value.copy(live.core);

    // El humano flota (fase 0): bob ±2% de su altura cada 5.6s, deriva de
    // rotación ±1.4° cada 9.3s — ingrávido, no ascensor. Y el pulso de la
    // llamada, suavizado con lerp, eleva el hombro y vuelve.
    live.floatY = layout.body.height * 0.02 * Math.sin((t * 6.2831853) / 5.6) * idleK;
    live.floatRot = 0.024 * Math.sin((t * 6.2831853) / 9.3 + 1.7) * idleK;
    call.sm += (callPulse - call.sm) * Math.min(1, dt * 4.5);
    live.invite = call.sm;

    // --- La cámara empuja lento hacia el contacto y se abre después ------
    state.camera.position.z = 16 - 3.1 * reach + 3.1 * smooth01(formT);

    for (const u of [built.coreU, built.ringsU, built.riverU, built.tendU]) {
      u.uTime.value = t;
      u.uDpr.value = dpr;
    }
    built.haloU.uTime.value = t;

    built.coreU.uCore.value.copy(live.core);
    built.coreU.uCoreR.value = layout.coreR;
    built.ringsU.uCore.value.copy(live.core);
    built.ringsU.uCoreR.value = layout.coreR;

    // El río nace en la mano y muere en el núcleo; se enciende con la
    // cercanía y desaparece en el estallido (el flash lo tapa).
    const hand = anchor.hand ?? handScratch.set(live.bodyX + layout.handDX, layout.handY, 0);
    built.riverU.uA.value.copy(hand);
    built.riverU.uB.value.copy(live.core);
    built.riverU.uCtrl.value.copy(
      riverCtrl(ctrlScratch, hand, live.core, layout, viewport.width, viewport.height),
    );
    // La separación normalizada mano-núcleo apaga el río ANTES del contacto:
    // un caudal entre dos puntos que coinciden es una mancha, y apagarse en
    // la anticipación es narrativamente correcto — el silencio antes.
    const sep = hand.distanceTo(live.core) / Math.max(layout.coreR, 1e-4);
    const sepK = clamp01((sep - 2.0) / 1.8);
    const riverAlpha = 0.95 * (0.12 + 0.88 * reach) * (1 - bang) ** 2 * (1 - 0.6 * suck) * sepK;
    built.riverU.uAlpha.value = riverAlpha;
    (built.riverGlow.uniforms.uAlpha as { value: number }).value = riverAlpha * GLOW_ALPHA;

    // Los zarcillos de invitación: núcleo → mano por la misma bezier del
    // río, con vida efímera — el «ven» de luz de la fase 0.
    built.tendU.uA.value.copy(live.core);
    built.tendU.uB.value.copy(hand);
    built.tendU.uCtrl.value.copy(built.riverU.uCtrl.value);
    built.tendU.uCall.value = callT;
    built.tendU.uCallSeed.value = call.seed;
    const tendEnv = smooth01(callT / 0.12) * (1 - smooth01((callT - 0.68) / 0.32));
    const tendAlpha = 1.0 * tendEnv * idleK;
    built.tendU.uAlpha.value = tendAlpha;
    // Doble ración de aura: los zarcillos son pocos y deben leerse solos.
    (built.tendGlow.uniforms.uAlpha as { value: number }).value = tendAlpha * GLOW_ALPHA * 2;
    if (tendRef.current) tendRef.current.visible = tendAlpha > 0.003;

    if (haloRef.current) {
      haloRef.current.position.copy(live.core);
      const s = layout.coreR * 9;
      haloRef.current.scale.set(s, s, 1);
    }
    // El halo también responde a la llamada: brilla y late más rápido.
    built.haloU.uExcite.value = reach + 0.45 * callPulse;
    // En la anticipación el núcleo se apaga medio beat; en el bang, del todo.
    built.haloU.uFade.value = (1 - bang) * (1 - 0.7 * suck);

    // Puntero: de NDC al plano z=0. La perturbación muere con el bang — a
    // partir de ahí las partículas obedecen a la secuencia, no a la mano.
    if (hasPointer.current) {
      const cam = state.camera;
      scratch.set(pointerNdc.current.x, pointerNdc.current.y, 0.5).unproject(cam);
      scratch.sub(cam.position).normalize();
      const reachZ = -cam.position.z / scratch.z;
      if (Number.isFinite(reachZ) && reachZ > 0) {
        scratch.multiplyScalar(reachZ).add(cam.position);
        pointerWorld.current.lerp(scratch, Math.min(1, delta * 9));
      }
    }
    const idle = t - pointerAt.current;
    const targetK = (idle < 2 ? 1 : 0) * (1 - bang);
    const fig = figureShared.current;
    const pointerTargets = fig ? [fig, built.riverU] : [built.riverU];
    for (const u of pointerTargets) {
      u.uPointer.value.copy(pointerWorld.current);
      u.uPointerK.value += (targetK - u.uPointerK.value) * Math.min(1, delta * 4);
    }
    if (fig) {
      fig.uTime.value = t;
      fig.uDpr.value = dpr;
      // El shimmer de respuesta: la banda recorre el brazo hombro→mano a
      // mitad de la llamada, cuando los zarcillos ya están en camino.
      // 0.45 ilumina sin quemar: la figura sigue azul con una vena de luz.
      fig.uInvite.value = clamp01((callT - 0.25) / 0.55);
      fig.uInviteK.value =
        0.45 * smooth01((callT - 0.22) / 0.15) * (1 - smooth01((callT - 0.85) / 0.15)) * idleK;
    }

    // Cámara con vida: la escena se inclina 2–3° hacia el cursor; el efecto
    // se disuelve al formarse el wordmark (un logo torcido se ve roto).
    const g = groupRef.current;
    if (g) {
      const damp = 1 - smooth01(formT);
      let ty: number;
      let tx: number;
      if (hasPointer.current) {
        ty = pointerNdc.current.x * 0.05 * damp;
        tx = -pointerNdc.current.y * 0.035 * damp;
      } else {
        ty = Math.sin(t * 0.13) * 0.035 * damp;
        tx = Math.cos(t * 0.1) * 0.022 * damp;
      }
      // La deriva orbital de fase 0: ±0.5°, lentísima, se disuelve al
      // scrollear — micro-vida de cámara aunque el puntero esté quieto.
      ty += Math.sin(t * 0.083) * 0.0085 * idleK;
      tx += Math.cos(t * 0.061) * 0.005 * idleK;
      g.rotation.y += (ty - g.rotation.y) * Math.min(1, delta * 2.5);
      g.rotation.x += (tx - g.rotation.x) * Math.min(1, delta * 2.5);
    }
  });

  const figureProps: FigureProps = {
    mobile,
    layout,
    live,
    seqU,
    register: registerFigure,
    anchor,
    onFigureReady,
  };

  return (
    <group ref={groupRef}>
      <mesh ref={haloRef} geometry={built.haloGeo} material={built.haloMat} frustumCulled={false} />
      <FigureBoundary fallback={<FigureFallback {...figureProps} />}>
        <Suspense fallback={null}>
          <FigureReal {...figureProps} />
        </Suspense>
      </FigureBoundary>
      <points geometry={built.coreGeo} material={built.coreGlow} frustumCulled={false} />
      <points geometry={built.coreGeo} material={built.coreMat} frustumCulled={false} />
      <points geometry={built.ringsGeo} material={built.ringsMat} frustumCulled={false} />
      <points geometry={built.riverGeo} material={built.riverGlow} frustumCulled={false} />
      <points geometry={built.riverGeo} material={built.riverMat} frustumCulled={false} />
      {/* Los zarcillos de invitación (fase 0); el loop apaga el grupo
          entero cuando no hay llamada — cero draw calls en vano. */}
      <group ref={tendRef} visible={false}>
        <points geometry={built.tendGeo} material={built.tendGlow} frustumCulled={false} />
        <points geometry={built.tendGeo} material={built.tendMat} frustumCulled={false} />
      </group>
    </group>
  );
}

/* --------------------------------------------------------------------------
 * El Canvas
 * ------------------------------------------------------------------------ */

export default function SeqScene({
  paused,
  progressRef,
  onReady,
  onFigureReady,
}: {
  paused: boolean;
  progressRef: MutableRefObject<number>;
  onReady: () => void;
  onFigureReady: () => void;
}) {
  const mobile = useMemo(
    () => (typeof window !== 'undefined' ? window.matchMedia('(pointer: coarse)').matches : false),
    [],
  );

  return (
    <Canvas
      frameloop={paused ? 'never' : 'always'}
      dpr={[1, 1.5]}
      camera={{ fov: 45, position: [0, 0, 16], near: 1, far: 60 }}
      gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
      onCreated={onReady}
    >
      <HeroActors mobile={mobile} progressRef={progressRef} onFigureReady={onFigureReady} />
    </Canvas>
  );
}
