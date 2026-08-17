'use client';

import { useGLTF } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Component, type ReactNode, Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';

/**
 * El hero cinematográfico: una persona conectándose con la IA, literal.
 *
 * CUATRO ACTORES, CINCO DRAW CALLS DE PARTÍCULAS Y UN HALO:
 *
 *   1. LA FIGURA — un humano DE VERDAD: un modelo 3D con esqueleto
 *      (public/models/human.glb, comprimido con meshopt) que nunca se dibuja
 *      como malla. Al cargar se muestrea UNA VEZ su superficie con
 *      MeshSurfaceSampler (~30k puntos con su skinIndex/skinWeight), y de ahí
 *      en adelante vive como nube de partículas que respira con la animación
 *      `idle` del rig. El seguimiento de los huesos ocurre EN EL SHADER
 *      (GPU skinning con la boneTexture del esqueleto): el CPU no toca ni una
 *      partícula por frame — mueve ~65 huesos y nada más.
 *
 *   2. EL GESTO — después de cada tick de la animación, la cadena del brazo
 *      derecho (RightArm → RightForeArm) se sobreescribe con un slerp que la
 *      apunta al núcleo. El resto del cuerpo sigue respirando con idle, y la
 *      posición mundial del hueso de la mano ancla el río en cada frame.
 *
 *   3. EL NÚCLEO — la IA: una esfera-remolino densa y brillante (additive),
 *      con un halo que late y tres anillos de partículas orbitando en planos
 *      inclinados.
 *
 *   4. EL RÍO — un flujo continuo de partículas entre la mano y el núcleo, en
 *      ambos sentidos, sobre una curva bezier que nace EXACTAMENTE donde está
 *      la mano del esqueleto en ese frame.
 *
 * RESPALDO. Si el GLB no llega (red, decoder, lo que sea), la silueta
 * procedural anterior sigue aquí como fallback silencioso: mismo lenguaje de
 * partículas, misma escena. Un ErrorBoundary decide y nadie ve un hueco.
 *
 * PRESUPUESTO. El GLB (624KB) se descarga DESPUÉS del primer paint: este
 * módulo entero entra por dynamic import y el preload de abajo corre cuando
 * el chunk se evalúa, nunca antes del HTML. DPR acotado a [1, 1.5],
 * antialias apagado, `low-power`, pausa con visibilitychange y al dejar el
 * hero atrás. En móvil, 40% de las partículas.
 */

const BREATHE_S = 3.4;
const FLASH_S = 1.15;
const MODEL_URL = '/models/human.glb';

/** El GLB viene comprimido con meshopt; sin este decoder no hay geometría. */
const extendLoader = (loader: { setMeshoptDecoder: (d: unknown) => unknown }) => {
  loader.setMeshoptDecoder(MeshoptDecoder);
};

// El preload corre al evaluarse el chunk — que ya es post-mount por el
// dynamic import de HeroStage. El titular (LCP) nunca compite con estos bytes.
if (typeof window !== 'undefined') {
  useGLTF.preload(MODEL_URL, false, false, extendLoader);
}

/* --------------------------------------------------------------------------
 * La silueta procedural — HOY ES EL RESPALDO.
 *
 * Era la figura titular; ahora sólo aparece si el modelo real no carga. Se
 * dibuja un humano en un canvas 2D offscreen (cabeza, torso, extremidades) y
 * se muestrea el relleno. No borrar: es lo que garantiza que el hero nunca
 * quede sin persona.
 * ------------------------------------------------------------------------ */

const SIL_W = 480;
const SIL_H = 720;
const SIL_AXIS = 205; // eje del cuerpo, en px del canvas
/** La punta de la mano de la SILUETA, en coordenadas unitarias. */
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

  // Cabeza y cuello.
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

  // Torso: masa central + barra de hombros que redondea los deltoides.
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
  // Cadera.
  stroke(
    [
      [176, 372],
      [234, 372],
    ],
    48,
  );

  // Brazo izquierdo (del espectador), colgando con un codo leve.
  stroke(
    [
      [160, 194],
      [138, 284],
      [148, 372],
    ],
    30,
  );

  // El brazo extendido: hombro → codo → mano.
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

  // Piernas, apenas separadas, con rodilla y pie.
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
  // Pies.
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

/** Aproximación gaussiana barata: suma de tres uniformes, centrada en 0. */
function gauss(): number {
  return Math.random() + Math.random() + Math.random() - 1.5;
}

/** Muestrea la silueta 2D: N puntos en coordenadas unitarias + semilla. */
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
 *
 * MeshSurfaceSampler reparte el muestreo por ÁREA (su distribución acumulada
 * por triángulo); de cada cara elegida se toma un punto barycéntrico y se
 * leen, de los atributos de la malla, la posición interpolada y el
 * skinIndex/skinWeight del vértice dominante del triángulo (los índices de
 * hueso no se pueden interpolar entre vértices que apuntan a huesos
 * distintos — el vértice con mayor peso barycéntrico da la piel correcta del
 * punto). Corre UNA vez al cargar.
 * ------------------------------------------------------------------------ */

type SampledSkin = {
  pos: Float32Array;
  skinIndex: Float32Array;
  skinWeight: Float32Array;
  seed: Float32Array;
  tone: Float32Array;
};

/**
 * La cara elegida por área, usando la distribución acumulada del sampler.
 * En r185 el método es `_sampleFaceIndex` (los .d.ts publican el nombre viejo
 * `binarySearch`); se aceptan ambos para sobrevivir un bump de three.
 */
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
      // La cara, elegida por área con la distribución del sampler.
      const face = sampleFaceIndex(sampler, totalW);
      let i0 = face * 3;
      let i1 = face * 3 + 1;
      let i2 = face * 3 + 2;
      if (index) {
        i0 = index.getX(i0);
        i1 = index.getX(i1);
        i2 = index.getX(i2);
      }

      // Barycéntricas uniformes sobre el triángulo.
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

      // La piel del vértice dominante.
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
 * Layout: dónde vive cada actor, en unidades de mundo del plano z=0.
 * ------------------------------------------------------------------------ */

type Layout = {
  wide: boolean;
  /** Colocación del cuerpo: pies en (x, baseY), altura objetivo y giro ¾. */
  body: { x: number; baseY: number; height: number; rotY: number };
  /** Colocación de la silueta de respaldo (coordenadas del sistema viejo). */
  fig: { x: number; y: number; scale: number };
  /** Estimación de la mano (el hueso real la reemplaza cuando existe). */
  hand: THREE.Vector3;
  core: THREE.Vector3;
  coreR: number;
};

function computeLayout(w: number, h: number): Layout {
  const wide = w / h > 1.05;
  if (wide) {
    const scale = h * 0.66;
    const fig = { x: w * 0.045, y: -h * 0.44, scale };
    // El humano real: ~65% del alto, de perfil ¾ mirando hacia el núcleo.
    const body = { x: w * 0.03, baseY: -h * 0.405, height: h * 0.65, rotY: 1.08 };
    const hand = new THREE.Vector3(body.x + h * 0.21, body.baseY + body.height * 0.78, 0);
    // El núcleo bien a la derecha: entre la mano y él tiene que quedar AIRE
    // para que el río se lea como río y no como un brazo que toca una bola.
    const core = new THREE.Vector3(w * 0.395, hand.y + h * 0.05, 0);
    const coreR = Math.min(h * 0.1, (core.x - hand.x) * 0.26);
    return { wide, body, fig, hand, core, coreR };
  }
  // Angosto: la conexión vive en el tercio de arriba (el texto ancla abajo
  // con su scrim): figura a la izquierda, núcleo arriba-derecha, río corto.
  const scale = h * 0.5;
  const fig = { x: -w * 0.24, y: -h * 0.2, scale };
  const body = { x: -w * 0.26, baseY: -h * 0.26, height: h * 0.52, rotY: 0.9 };
  const hand = new THREE.Vector3(body.x + h * 0.17, body.baseY + body.height * 0.78, 0);
  const core = new THREE.Vector3(w * 0.3, h * 0.31, 0);
  const dist = core.distanceTo(hand);
  const coreR = Math.min(h * 0.052, dist * 0.3);
  return { wide, body, fig, hand, core, coreR };
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
    out.y += (core.x - hand.x) * 0.26;
    out.z = 0.4;
  } else {
    out.x += w * 0.055;
    out.y -= h * 0.015;
    out.z = 0.3;
  }
  return out;
}

/* --------------------------------------------------------------------------
 * Shaders
 * ------------------------------------------------------------------------ */

/** La silueta de respaldo (coordenadas unitarias + offset/escala). */
const FIGURE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec2 uFigOff;
  uniform float uFigScale;
  uniform vec2 uHand;
  uniform vec3 uPointer;
  uniform float uPointerK;

  attribute float aSeed;
  varying float vI;

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

    float handGlow = smoothstep(0.5, 0.06, distance(position.xy, uHand)) *
      (0.55 + 0.45 * sin(uTime * 2.6));

    vI = 0.62 + 0.48 * fract(aSeed * 7.31) + handGlow * 0.9 + g * 0.35;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.65 + 0.6 * fract(aSeed * 3.17)) * (1.0 + 0.35 * g) * uDpr * (55.0 / -mv.z);
  }
`;

/**
 * El humano real: GPU skinning en el vértice. Es la fórmula estándar de los
 * chunks `skinning_vertex`/`skinbase_vertex` de three, adaptada a GLSL1 (la
 * boneTexture se lee con texture2D y coordenadas de texel calculadas a mano,
 * exactamente el esquema que three usaba antes de texelFetch — así el shader
 * corre igual en WebGL1 y WebGL2 sin pedir GLSL3). Cada hueso ocupa 4 texels
 * RGBA float de una textura cuadrada.
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
  uniform mat4 uXform;   // (layout ∘ matrixWorld de la malla): modelo → escena
  uniform vec3 uHand;    // la mano, en coordenadas de la escena
  uniform vec3 uPointer;
  uniform float uPointerK;

  attribute vec4 aSkinIndex;
  attribute vec4 aSkinWeight;
  attribute float aSeed;
  attribute float aTone;
  varying float vI;

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
    // skinning_vertex, tal cual three lo hace para una SkinnedMesh.
    vec4 sv = uBind * vec4(position, 1.0);
    vec4 sk = boneAt(aSkinIndex.x) * sv * aSkinWeight.x
            + boneAt(aSkinIndex.y) * sv * aSkinWeight.y
            + boneAt(aSkinIndex.z) * sv * aSkinWeight.z
            + boneAt(aSkinIndex.w) * sv * aSkinWeight.w;
    vec3 p = (uXform * vec4((uBindInv * sk).xyz, 1.0)).xyz;

    // Jitter orgánico, pequeño: la figura es firme, no una nube.
    p += 0.018 * vec3(
      sin(uTime * 0.9 + aSeed * 43.0),
      cos(uTime * 0.8 + aSeed * 91.0),
      sin(uTime * 1.1 + aSeed * 17.0)
    );

    // El cursor perturba; la base se recalcula siempre, así que volver es gratis.
    float d = distance(p.xy, uPointer.xy);
    float g = smoothstep(1.2, 0.1, d) * uPointerK;
    p.xy += (uPointer.xy - p.xy) * g * 0.06;

    // La energía se concentra hacia la mano que alcanza el núcleo.
    float handGlow = smoothstep(1.1, 0.1, distance(p, uHand)) *
      (0.55 + 0.45 * sin(uTime * 2.6));

    // Twinkle leve, por semilla.
    float tw = 0.86 + 0.14 * sin(uTime * (1.4 + fract(aSeed * 3.3) * 1.6) + aSeed * 61.0);

    vI = ((0.6 + 0.5 * fract(aSeed * 7.31)) * tw * aTone + handGlow * 0.9 + g * 0.35) * uAppear;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.6 + 0.7 * fract(aSeed * 3.17)) * (1.0 + 0.35 * g) * uDpr * (55.0 / -mv.z);
  }
`;

const FIGURE_FRAG = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uAlpha;
  varying float vI;

  void main() {
    float m = smoothstep(0.5, 0.16, length(gl_PointCoord - 0.5));
    if (m < 0.02) discard;
    vec3 col = mix(uColA, uColB, clamp(vI - 0.8, 0.0, 1.0));
    gl_FragColor = vec4(col * vI, uAlpha * m);
  }
`;

const CORE_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uCore;
  uniform float uCoreR;
  uniform float uPulseT;

  attribute float aSeed;
  varying float vI;

  void main() {
    float r = length(position);
    float k = clamp(r, 0.0, 1.0);
    float ang = uTime * (0.22 + 1.5 * (1.0 - k)) + aSeed * 6.2831853;
    float c = cos(ang);
    float s = sin(ang);
    vec3 q = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);

    float tilt = 0.22 * sin(uTime * 0.35);
    q = vec3(q.x, q.y * cos(tilt) - q.z * sin(tilt), q.y * sin(tilt) + q.z * cos(tilt));

    float beat = 1.0 + 0.045 * sin(uTime * 6.2831853 / ${BREATHE_S.toFixed(1)});
    float age = uTime - uPulseT;
    float burst = (age > 0.0) ? exp(-age * 2.6) : 0.0;
    vec3 p = uCore + q * uCoreR * beat * (1.0 + 0.35 * burst);

    vI = mix(1.7, 0.5, k) * (1.0 + 2.2 * burst);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.5 + 0.9 * fract(aSeed * 5.19)) * uDpr * (55.0 / -mv.z);
  }
`;

const CORE_FRAG = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uAlpha;
  varying float vI;

  void main() {
    float m = smoothstep(0.5, 0.1, length(gl_PointCoord - 0.5));
    if (m < 0.02) discard;
    vec3 col = mix(uColA, uColB, clamp(vI * 0.55, 0.0, 1.0));
    gl_FragColor = vec4(col * vI, uAlpha * m);
  }
`;

const RINGS_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uCore;
  uniform float uCoreR;
  uniform float uPulseT;

  attribute float aAngle;
  attribute float aRing;
  attribute float aSeed;
  varying float vI;

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
    float speed = (aRing < 0.5) ? 0.55 : ((aRing < 1.5) ? -0.4 : 0.3);
    float a = aAngle + uTime * speed;
    vec3 local = vec3(cos(a) * radius, sin(a) * radius, 0.0);
    local += (fract(vec3(aSeed * 3.1, aSeed * 7.7, aSeed * 5.3)) - 0.5) * uCoreR * 0.09;
    local = tiltRing(local, aRing);

    float age = uTime - uPulseT;
    float burst = (age > 0.0) ? exp(-age * 2.6) : 0.0;
    vec3 p = uCore + local * (1.0 + 0.3 * burst);

    float head = pow(0.5 + 0.5 * cos(a - uTime * (1.2 + aRing * 0.5)), 6.0);
    vI = 0.35 + 0.5 * fract(aSeed * 9.1) + head * 1.6 + burst * 1.5;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (0.5 + 0.7 * fract(aSeed * 4.7)) * uDpr * (55.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }
`;

const RIVER_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uDpr;
  uniform float uSize;
  uniform vec3 uA;    // la mano
  uniform vec3 uB;    // el núcleo
  uniform vec3 uCtrl; // control de la curva
  uniform vec3 uPointer;
  uniform float uPointerK;
  uniform float uFlashT;

  attribute float aPhase;
  attribute float aDir;   // 1 = mano→núcleo, 0 = núcleo→mano
  attribute float aSeed;
  varying float vI;

  vec3 bez(float t) {
    float u = 1.0 - t;
    return u * u * uA + 2.0 * u * t * uCtrl + t * t * uB;
  }

  void main() {
    float speed = 0.12 * (0.7 + 0.6 * fract(aSeed * 3.7));
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

    float age = uTime - uFlashT;
    float flash = 0.0;
    if (age > 0.0 && age < ${FLASH_S.toFixed(2)}) {
      float front = 1.0 - age / ${FLASH_S.toFixed(2)};
      flash = exp(-pow((t - front) * 7.0, 2.0)) * 3.0 * (1.0 - age / ${FLASH_S.toFixed(2)} * 0.4);
    }

    float ends = smoothstep(0.0, 0.06, t) * smoothstep(1.0, 0.94, t);
    vI = (0.5 + 0.7 * fract(aSeed * 7.3)) * ends * (1.0 + g * 1.6) + flash;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.55 + 0.8 * fract(aSeed * 11.3)) * (1.0 + flash * 0.5) * uDpr * (55.0 / -mv.z);
  }
`;

const SPARK_FRAG = /* glsl */ `
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform float uAlpha;
  varying float vI;

  void main() {
    float m = smoothstep(0.5, 0.12, length(gl_PointCoord - 0.5));
    if (m < 0.02) discard;
    vec3 col = mix(uColA, uColB, clamp(vI * 0.5, 0.0, 1.0));
    gl_FragColor = vec4(col * vI, uAlpha * m);
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
  uniform float uPulseT;
  uniform vec3 uColor;
  varying vec2 vUv;

  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float beat = 0.8 + 0.2 * sin(uTime * 6.2831853 / ${BREATHE_S.toFixed(1)});
    float age = uTime - uPulseT;
    float burst = (age > 0.0) ? exp(-age * 2.2) : 0.0;
    float a = exp(-d * 4.2) * (0.55 * beat + 1.6 * burst)
      + exp(-d * 1.6) * (0.12 * beat + 0.5 * burst);
    a *= smoothstep(1.0, 0.6, d);
    gl_FragColor = vec4(uColor, a);
  }
`;

/* --------------------------------------------------------------------------
 * La escena
 * ------------------------------------------------------------------------ */

const COL_BODY = new THREE.Color('#8d85f5');
const COL_HOT = new THREE.Color('#f2f1ff');
const COL_CORE = new THREE.Color('#a89fff');
const COL_RIVER = new THREE.Color('#9f96ff');

const PARTICLE_BLEND = {
  transparent: true,
  depthWrite: false,
  depthTest: false,
  blending: THREE.AdditiveBlending,
} as const;

/** Los uniforms que el loop del padre escribe en la figura activa (real o
 * de respaldo): tiempo, DPR y puntero. */
type FigureShared = {
  uTime: { value: number };
  uDpr: { value: number };
  uPointer: { value: THREE.Vector3 };
  uPointerK: { value: number };
};

type FigureProps = {
  mobile: boolean;
  frozen: boolean;
  layout: Layout;
  /** La figura activa registra aquí sus uniforms compartidos. */
  register: (u: FigureShared | null) => void;
  /** La mano viva (coordenadas del grupo). null → se usa la estimación. */
  anchor: { hand: THREE.Vector3 | null };
  onFigureReady: () => void;
};

/* ---- El respaldo: la silueta procedural de siempre ---------------------- */

function FigureFallback({ mobile, layout, register, anchor, onFigureReady }: FigureProps) {
  const count = Math.round(27_000 * (mobile ? 0.4 : 1));

  // biome-ignore lint/correctness/useExhaustiveDependencies: los buffers se generan una vez por montaje.
  const built = useMemo(() => {
    const human = sampleHuman(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(human.pos, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(human.seed, 1));
    const u = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.15 },
      uFigOff: { value: new THREE.Vector2() },
      uFigScale: { value: 8 },
      uHand: { value: new THREE.Vector2(HAND_UNIT[0], HAND_UNIT[1]) },
      uPointer: { value: new THREE.Vector3(999, 999, 0) },
      uPointerK: { value: 0 },
      uColA: { value: COL_BODY },
      uColB: { value: COL_HOT },
      uAlpha: { value: 0.46 },
    };
    const mat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: FIGURE_VERT,
      fragmentShader: FIGURE_FRAG,
      uniforms: u,
    });
    return { geo, mat, u };
  }, []);

  useEffect(() => {
    built.u.uAlpha.value = mobile ? 0.36 : 0.46;
  }, [mobile, built]);

  useEffect(() => {
    register(built.u);
    anchor.hand = null; // el río usa la estimación del layout
    onFigureReady();
    return () => register(null);
  }, [built, register, anchor, onFigureReady]);

  // El dispose vive aparte: sólo cuando los buffers de verdad cambian.
  useEffect(
    () => () => {
      built.geo.dispose();
      built.mat.dispose();
    },
    [built],
  );

  useFrame(() => {
    built.u.uFigOff.value.set(layout.fig.x, layout.fig.y);
    built.u.uFigScale.value = layout.fig.scale;
  });

  return <points geometry={built.geo} material={built.mat} frustumCulled={false} />;
}

/* ---- El humano real: GLB muestreado + GPU skinning ---------------------- */

const FROZEN_POSE_T = 0.8;

function FigureReal({ mobile, frozen, layout, register, anchor, onFigureReady }: FigureProps) {
  const gltf = useGLTF(MODEL_URL, false, false, extendLoader);
  const count = Math.round(30_000 * (mobile ? 0.4 : 1));

  // Se muestrea UNA vez por modelo cargado (gltf/count son estables tras montar).
  const built = useMemo(() => {
    const root = gltf.scene;
    root.updateMatrixWorld(true);

    const meshes: THREE.SkinnedMesh[] = [];
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh);
    });
    const first = meshes[0];
    if (!first) throw new Error('human.glb no trae mallas con esqueleto');

    // Muestreo de superficie, una vez. Después de esto la malla no se usa
    // más que como fuente del esqueleto — jamás se dibuja. La malla de
    // articulaciones del modelo se superpone a la de superficie: donde ambas
    // coexisten la densidad se duplica y salían manchas encendidas — por eso
    // sus puntos entran con un tono más bajo.
    const tones = meshes.map((m) => (/joint/i.test(m.name) ? 0.45 : 1));
    const sampled = sampleSkinnedMeshes(meshes, count, tones);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(sampled.pos, 3));
    geo.setAttribute('aSkinIndex', new THREE.BufferAttribute(sampled.skinIndex, 4));
    geo.setAttribute('aSkinWeight', new THREE.BufferAttribute(sampled.skinWeight, 4));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(sampled.seed, 1));
    geo.setAttribute('aTone', new THREE.BufferAttribute(sampled.tone, 1));

    // El esqueleto y su textura de huesos (el uniform del skinning).
    // Ambas mallas del modelo comparten rig; la primera manda.
    const skeleton = first.skeleton;
    if (!skeleton.boneTexture) skeleton.computeBoneTexture();
    const boneTex = skeleton.boneTexture as THREE.DataTexture;

    // Normalización: alto del modelo y piso, para escalarlo al layout.
    const bbox = new THREE.Box3().setFromObject(root);
    const modelH = Math.max(1e-6, bbox.max.y - bbox.min.y);
    const minY = bbox.min.y;

    // La animación viva. El esqueleto corre `idle`; la malla ni se monta.
    const mixer = new THREE.AnimationMixer(root);
    const idle = gltf.animations.find((c) => c.name === 'idle') ?? gltf.animations[0] ?? null;
    if (idle) mixer.clipAction(idle).play();

    // La cadena del brazo derecho y la mano, por sufijo de nombre (los
    // exportadores cambian el separador de mixamorig, el sufijo no).
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
      uPointer: { value: new THREE.Vector3(999, 999, 0) },
      uPointerK: { value: 0 },
      uColA: { value: COL_BODY },
      uColB: { value: COL_HOT },
      uAlpha: { value: 0.5 },
    };
    const mat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: BODY_VERT,
      fragmentShader: FIGURE_FRAG,
      uniforms: u,
    });

    return {
      root,
      geo,
      mat,
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
  }, [gltf, count]);

  useEffect(() => {
    built.u.uAlpha.value = mobile ? 0.4 : 0.5;
  }, [mobile, built]);

  useEffect(() => {
    register(built.u);
    onFigureReady();
    return () => {
      register(null);
      anchor.hand = null;
    };
  }, [built, register, anchor, onFigureReady]);

  // El dispose vive aparte: sólo cuando los buffers de verdad cambian.
  useEffect(
    () => () => {
      built.geo.dispose();
      built.mat.dispose();
      built.mixer.stopAllAction();
    },
    [built],
  );

  // Scratch reutilizado por frame: cero allocations en el loop.
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
      aimW: 0,
      appear: 0,
    }),
    [],
  );

  /** Apunta `bone` (vía la dirección hacia `child`) al objetivo, con peso. */
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
    s.qWorld.premultiply(s.qDelta); // rotación deseada, en espacio del modelo
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

    // 1. La colocación del cuerpo en la escena (posición, ¾ hacia el núcleo,
    //    escala al 65% del alto) — una matriz, no 30k puntos.
    const k = layout.body.height / built.modelH;
    s.quatY.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, layout.body.rotY);
    s.pos.set(layout.body.x, layout.body.baseY - built.minY * k, 0);
    s.scl.setScalar(k);
    s.layoutMat.compose(s.pos, s.quatY, s.scl);
    built.u.uXform.value.multiplyMatrices(s.layoutMat, built.meshWorld);

    // 2. El esqueleto respira con idle. Congelado: un instante fijo.
    if (frozen) {
      built.mixer.setTime(FROZEN_POSE_T);
      s.aimW = 1;
      s.appear = 1;
    } else {
      built.mixer.update(dt);
      s.aimW = Math.min(1, s.aimW + dt / 1.4);
      s.appear = Math.min(1, s.appear + dt / 1.1);
    }
    built.root.updateMatrixWorld(true);

    // 3. El gesto: brazo y antebrazo derechos apuntados al núcleo con slerp.
    //    El peso sube de 0 a ~0.95 — queda un 5% de idle para que el brazo
    //    extendido siga vivo, no clavado.
    if (built.armBone && built.foreBone && built.handBone) {
      s.layoutInv.copy(s.layoutMat).invert();
      s.coreModel.copy(layout.core).applyMatrix4(s.layoutInv);
      const w = s.aimW * 0.95;
      aimBone(built.armBone, built.foreBone, s.coreModel, w);
      aimBone(built.foreBone, built.handBone, s.coreModel, w);
    }

    // 4. La textura de huesos, al día — es TODO lo que el shader necesita
    //    para mover 30k partículas.
    built.skeleton.update();

    // 5. La mano de verdad, en coordenadas de la escena: ancla el río.
    if (built.handBone) {
      s.hand.setFromMatrixPosition(built.handBone.matrixWorld).applyMatrix4(s.layoutMat);
      anchor.hand = s.hand;
      built.u.uHand.value.copy(s.hand);
    }

    built.u.uAppear.value = s.appear;
  });

  return <points geometry={built.geo} material={built.mat} frustumCulled={false} />;
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

type SceneProps = {
  mobile: boolean;
  frozen: boolean;
  pulseSignal: number;
  onFigureReady: () => void;
};

function HeroActors({ mobile, frozen, pulseSignal, onFigureReady }: SceneProps) {
  const density = mobile ? 0.4 : 1;
  const counts = useMemo(
    () => ({
      core: Math.round(8_000 * density),
      rings: Math.round(2_400 * density),
      river: Math.round(3_000 * density),
    }),
    [density],
  );

  const viewport = useThree((s) => s.viewport);
  const layout = useMemo(
    () => computeLayout(viewport.width, viewport.height),
    [viewport.width, viewport.height],
  );

  // --- Geometrías y materiales (una vez) ---------------------------------
  // biome-ignore lint/correctness/useExhaustiveDependencies: los buffers se generan una vez por montaje; regenerar miles de posiciones en vivo no compra nada.
  const built = useMemo(() => {
    // El núcleo: bola gaussiana con sesgo hacia el centro.
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
    const coreU = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 0.85 },
      uCore: { value: new THREE.Vector3() },
      uCoreR: { value: 1 },
      uPulseT: { value: -100 },
      uColA: { value: COL_CORE },
      uColB: { value: COL_HOT },
      uAlpha: { value: 0.52 },
    };
    const coreMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: CORE_VERT,
      fragmentShader: CORE_FRAG,
      uniforms: coreU,
    });

    // Los anillos.
    const ringAngle = new Float32Array(counts.rings);
    const ringId = new Float32Array(counts.rings);
    const ringSeed = new Float32Array(counts.rings);
    const ringPos = new Float32Array(counts.rings * 3); // placeholder (el shader lo ignora)
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
    const ringsU = {
      uTime: { value: 0 },
      uDpr: { value: 1 },
      uSize: { value: 1.0 },
      uCore: { value: new THREE.Vector3() },
      uCoreR: { value: 1 },
      uPulseT: { value: -100 },
      uColA: { value: COL_CORE },
      uColB: { value: COL_HOT },
      uAlpha: { value: 0.55 },
    };
    const ringsMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: RINGS_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: ringsU,
    });

    // El río.
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
      uFlashT: { value: -100 },
      uColA: { value: COL_RIVER },
      uColB: { value: COL_HOT },
      uAlpha: { value: 0.95 },
    };
    const riverMat = new THREE.ShaderMaterial({
      ...PARTICLE_BLEND,
      vertexShader: RIVER_VERT,
      fragmentShader: SPARK_FRAG,
      uniforms: riverU,
    });

    // El halo del núcleo.
    const haloGeo = new THREE.PlaneGeometry(1, 1);
    const haloU = {
      uTime: { value: 0 },
      uPulseT: { value: -100 },
      uColor: { value: COL_CORE },
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
      coreU,
      ringsGeo,
      ringsMat,
      ringsU,
      riverGeo,
      riverMat,
      riverU,
      haloGeo,
      haloMat,
      haloU,
    };
  }, []);

  useEffect(() => {
    const disposables = [
      built.coreGeo,
      built.coreMat,
      built.ringsGeo,
      built.ringsMat,
      built.riverGeo,
      built.riverMat,
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

  // --- Entradas: puntero, pulso -----------------------------------------
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const pointerNdc = useRef(new THREE.Vector2(0, 0));
  const pointerWorld = useRef(new THREE.Vector3(999, 999, 0));
  const pointerAt = useRef(-10);
  const hasPointer = useRef(false);
  const clockRef = useRef(0);
  const scratch = useMemo(() => new THREE.Vector3(), []);
  const ctrlScratch = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    if (frozen) return;
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
  }, [frozen]);

  // El momento de respuesta: pulso del núcleo + destello por el río.
  useEffect(() => {
    if (pulseSignal <= 0 || frozen) return;
    const t = clockRef.current + 0.05;
    built.coreU.uPulseT.value = t;
    built.ringsU.uPulseT.value = t;
    built.haloU.uPulseT.value = t;
    built.riverU.uFlashT.value = t + 0.25;
  }, [pulseSignal, frozen, built]);

  useFrame((state, delta) => {
    // Con reduced-motion el reloj queda clavado: la MISMA composición, quieta.
    const t = frozen ? 2.2 : state.clock.elapsedTime + 2.2;
    clockRef.current = t;
    const dpr = state.gl.getPixelRatio();

    for (const u of [built.coreU, built.ringsU, built.riverU]) {
      u.uTime.value = t;
      u.uDpr.value = dpr;
    }
    built.haloU.uTime.value = t;

    // Layout → uniforms (barato; corre por frame para absorber resize).
    built.coreU.uCore.value.copy(layout.core);
    built.coreU.uCoreR.value = layout.coreR;
    built.ringsU.uCore.value.copy(layout.core);
    built.ringsU.uCoreR.value = layout.coreR;

    // El río nace donde ESTÁ la mano: el hueso real si el modelo cargó, la
    // estimación del layout si corre el respaldo.
    const hand = anchor.hand ?? layout.hand;
    built.riverU.uA.value.copy(hand);
    built.riverU.uB.value.copy(layout.core);
    built.riverU.uCtrl.value.copy(
      riverCtrl(ctrlScratch, hand, layout.core, layout, viewport.width, viewport.height),
    );

    if (haloRef.current) {
      haloRef.current.position.copy(layout.core);
      const s = layout.coreR * 9;
      haloRef.current.scale.set(s, s, 1);
    }

    // Puntero: de NDC al plano z=0.
    if (!frozen && hasPointer.current) {
      const cam = state.camera;
      scratch.set(pointerNdc.current.x, pointerNdc.current.y, 0.5).unproject(cam);
      scratch.sub(cam.position).normalize();
      const reach = -cam.position.z / scratch.z;
      if (Number.isFinite(reach) && reach > 0) {
        scratch.multiplyScalar(reach).add(cam.position);
        pointerWorld.current.lerp(scratch, Math.min(1, delta * 9));
      }
    }
    const idle = t - pointerAt.current;
    const targetK = !frozen && idle < 2 ? 1 : 0;
    const fig = figureShared.current;
    const pointerTargets = fig ? [fig, built.riverU] : [built.riverU];
    for (const u of pointerTargets) {
      u.uPointer.value.copy(pointerWorld.current);
      u.uPointerK.value += (targetK - u.uPointerK.value) * Math.min(1, delta * 4);
    }
    if (fig) {
      fig.uTime.value = t;
      fig.uDpr.value = dpr;
    }

    // Cámara con vida: la escena se inclina 2–3° hacia el cursor.
    const g = groupRef.current;
    if (g && !frozen) {
      let ty: number;
      let tx: number;
      if (hasPointer.current) {
        ty = pointerNdc.current.x * 0.05;
        tx = -pointerNdc.current.y * 0.035;
      } else {
        ty = Math.sin(t * 0.13) * 0.035;
        tx = Math.cos(t * 0.1) * 0.022;
      }
      g.rotation.y += (ty - g.rotation.y) * Math.min(1, delta * 2.5);
      g.rotation.x += (tx - g.rotation.x) * Math.min(1, delta * 2.5);
    }
  });

  const figureProps: FigureProps = {
    mobile,
    frozen,
    layout,
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
      <points geometry={built.coreGeo} material={built.coreMat} frustumCulled={false} />
      <points geometry={built.ringsGeo} material={built.ringsMat} frustumCulled={false} />
      <points geometry={built.riverGeo} material={built.riverMat} frustumCulled={false} />
    </group>
  );
}

/* --------------------------------------------------------------------------
 * El Canvas
 * ------------------------------------------------------------------------ */

export default function HeroScene({
  frozen,
  paused,
  pulseSignal,
  onReady,
  onFigureReady,
}: {
  frozen: boolean;
  paused: boolean;
  pulseSignal: number;
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
      <HeroActors
        mobile={mobile}
        frozen={frozen}
        pulseSignal={pulseSignal}
        onFigureReady={onFigureReady}
      />
    </Canvas>
  );
}
