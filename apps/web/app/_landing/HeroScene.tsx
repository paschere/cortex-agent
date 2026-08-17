'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

/**
 * El hero cinematográfico: una persona conectándose con la IA, literal.
 *
 * TRES ACTORES, CUATRO DRAW CALLS DE PARTÍCULAS Y UN HALO:
 *
 *   1. LA FIGURA — una silueta humana de pie, de partículas, con el brazo
 *      extendido hacia la derecha. No es una nube que "sugiere" nada: se
 *      dibuja un humano en un canvas 2D offscreen (cabeza, torso, brazos,
 *      piernas, con proporciones de figura) y se muestrea el relleno. ~26k
 *      puntos con algo de profundidad (±0.15) y jitter orgánico. Respira.
 *
 *   2. EL NÚCLEO — la IA: una esfera-remolino densa y brillante (additive),
 *      con un halo que late y tres anillos de partículas orbitando en planos
 *      inclinados. Las partículas interiores giran más rápido que las de
 *      afuera: un vórtice, no una pelota.
 *
 *   3. EL RÍO — la protagonista. Un flujo continuo de partículas entre la
 *      mano extendida y el núcleo, en ambos sentidos, sobre una curva bezier.
 *      Siempre está corriendo; el cursor lo perturba (las partículas cercanas
 *      se desvían hacia él y vuelven solas, porque su posición se recalcula
 *      desde la curva en cada frame — la turbulencia no necesita estado).
 *
 * EL MOMENTO. Cuando el titular termina de entrar, el núcleo pulsa fuerte una
 * vez y un destello viaja por el río desde el núcleo hasta la mano. Una vez:
 * un evento que se repite deja de ser un evento.
 *
 * CÁMARA. No se mueve; la escena entera se inclina 2–3° hacia el cursor con
 * suavizado. Sin puntero fino (móvil), deriva sola, lenta.
 *
 * PRESUPUESTO. ~40k partículas en escritorio, ~40% de eso en móvil. DPR
 * acotado a [1, 1.5], antialias apagado, blending additive sobre el fondo
 * oscuro del hero (que es siempre oscuro — decisión de identidad, no un tema).
 * El loop lo gobierna el padre: se congela con prefers-reduced-motion (la
 * MISMA composición, quieta), se pausa con visibilitychange y cuando el hero
 * ya quedó atrás del scroll.
 */

const BREATHE_S = 3.4;
const FLASH_S = 1.15;

/* --------------------------------------------------------------------------
 * La silueta humana — dibujada, no adivinada.
 *
 * Un canvas offscreen de 480×720 donde el humano se construye como se
 * construye un maniquí: círculo de cabeza, cuello, masa del torso, y
 * extremidades como trazos gruesos con puntas redondas que hacen de
 * articulaciones. El brazo derecho va extendido hacia la derecha y apenas
 * hacia arriba — el gesto de alcanzar. Después se muestrea el relleno.
 *
 * Coordenadas unitarias: x centrado en el eje del cuerpo, y=0 en los pies,
 * y≈0.95 en la coronilla, todo dividido por la altura (720). El mundo escala
 * esa unidad a la altura que el layout pida.
 * ------------------------------------------------------------------------ */

const SIL_W = 480;
const SIL_H = 720;
const SIL_AXIS = 205; // eje del cuerpo, en px del canvas
/** La punta de la mano extendida, en coordenadas unitarias (de aquí nace el río). */
export const HAND_UNIT: readonly [number, number] = [(468 - SIL_AXIS) / SIL_H, (720 - 122) / SIL_H];

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

  // El brazo extendido: hombro → codo → mano, alcanzando a la derecha y un
  // poco hacia arriba. La mano es un punto redondo aparte para que remate.
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

/**
 * Muestrea la silueta: N puntos en coordenadas unitarias, z ya en unidades de
 * mundo (±0.15, con cola suave), más una semilla por punto.
 */
function sampleHuman(count: number): { pos: Float32Array; seed: Float32Array } {
  const canvas = document.createElement('canvas');
  canvas.width = SIL_W;
  canvas.height = SIL_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);

  if (!ctx) {
    // Sin canvas 2D no hay silueta que muestrear; una columna difusa evita el
    // crash y el hero sigue teniendo núcleo y río.
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
    // Jitter orgánico leve para que el borde no sea un stencil duro.
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
 * Layout: dónde vive cada actor, en unidades de mundo del plano z=0.
 * ------------------------------------------------------------------------ */

type Layout = {
  fig: { x: number; y: number; scale: number };
  hand: THREE.Vector3;
  core: THREE.Vector3;
  coreR: number;
  ctrl: THREE.Vector3;
};

function computeLayout(w: number, h: number): Layout {
  const wide = w / h > 1.05;
  if (wide) {
    const scale = h * 0.66; // la figura mide ~66% del alto del viewport
    const fig = { x: w * 0.045, y: -h * 0.44, scale };
    const hand = new THREE.Vector3(fig.x + HAND_UNIT[0] * scale, fig.y + HAND_UNIT[1] * scale, 0);
    // El núcleo bien a la derecha: entre la mano y él tiene que quedar AIRE
    // para que el río se lea como río y no como un brazo que toca una bola.
    const core = new THREE.Vector3(w * 0.395, hand.y + h * 0.06, 0);
    const coreR = Math.min(h * 0.1, (core.x - hand.x) * 0.26);
    const mid = hand.clone().add(core).multiplyScalar(0.5);
    const ctrl = new THREE.Vector3(mid.x, mid.y + (core.x - hand.x) * 0.26, 0.4);
    return { fig, hand, core, coreR, ctrl };
  }
  // Angosto: la conexión vive en el tercio de arriba (el texto ancla abajo
  // con su scrim): figura a la izquierda con el brazo alto, núcleo
  // arriba-derecha, río corto en diagonal.
  const scale = h * 0.5;
  const fig = { x: -w * 0.24, y: -h * 0.2, scale };
  const hand = new THREE.Vector3(fig.x + HAND_UNIT[0] * scale, fig.y + HAND_UNIT[1] * scale, 0);
  const core = new THREE.Vector3(w * 0.3, h * 0.31, 0);
  const dist = core.distanceTo(hand);
  const coreR = Math.min(h * 0.052, dist * 0.3);
  const mid = hand.clone().add(core).multiplyScalar(0.5);
  const ctrl = new THREE.Vector3(mid.x + w * 0.055, mid.y - h * 0.015, 0.3);
  return { fig, hand, core, coreR, ctrl };
}

/* --------------------------------------------------------------------------
 * Shaders
 * ------------------------------------------------------------------------ */

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
    // Unidades → mundo. La z ya viene en mundo (±0.15).
    vec3 p = vec3(position.xy * uFigScale + uFigOff, position.z);

    // Respira: el pecho sube apenas y los hombros se abren una fracción.
    float br = sin(uTime * TAU / ${BREATHE_S.toFixed(1)});
    float torso = smoothstep(0.35, 0.75, position.y);
    p.y += br * 0.022 * torso * uFigScale * 0.12;
    p.x += br * 0.006 * (position.x) * torso * uFigScale;

    // Jitter orgánico, pequeño: la figura es firme, no una nube.
    p += 0.02 * vec3(
      sin(uTime * 0.9 + aSeed * 43.0),
      cos(uTime * 0.8 + aSeed * 91.0),
      sin(uTime * 1.1 + aSeed * 17.0)
    );

    // El cursor perturba: las partículas cercanas se desvían hacia él y
    // vuelven (la posición base se recalcula siempre, así que "volver" es
    // gratis).
    float d = distance(p.xy, uPointer.xy);
    float g = smoothstep(1.2, 0.1, d) * uPointerK;
    p.xy += (uPointer.xy - p.xy) * g * 0.06;

    // La energía se concentra hacia la mano extendida: el cuerpo se enciende
    // en dirección del gesto.
    float handGlow = smoothstep(0.5, 0.06, distance(position.xy, uHand)) *
      (0.55 + 0.45 * sin(uTime * 2.6));

    vI = 0.62 + 0.48 * fract(aSeed * 7.31) + handGlow * 0.9 + g * 0.35;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * (0.65 + 0.6 * fract(aSeed * 3.17)) * (1.0 + 0.35 * g) * uDpr * (55.0 / -mv.z);
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
    // El vórtice: las partículas interiores giran más rápido.
    float r = length(position);
    float k = clamp(r, 0.0, 1.0);
    float ang = uTime * (0.22 + 1.5 * (1.0 - k)) + aSeed * 6.2831853;
    float c = cos(ang);
    float s = sin(ang);
    vec3 q = vec3(position.x * c - position.z * s, position.y, position.x * s + position.z * c);

    // Precesión leve del eje, para que el remolino no sea un trompo perfecto.
    float tilt = 0.22 * sin(uTime * 0.35);
    q = vec3(q.x, q.y * cos(tilt) - q.z * sin(tilt), q.y * sin(tilt) + q.z * cos(tilt));

    // Latido del núcleo + el pulso fuerte del momento de respuesta.
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
    // Tres planos distintos, fijos: la inclinación es identidad, no ruido.
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
    // Grosor del anillo.
    local += (fract(vec3(aSeed * 3.1, aSeed * 7.7, aSeed * 5.3)) - 0.5) * uCoreR * 0.09;
    local = tiltRing(local, aRing);

    float age = uTime - uPulseT;
    float burst = (age > 0.0) ? exp(-age * 2.6) : 0.0;
    vec3 p = uCore + local * (1.0 + 0.3 * burst);

    // Una cabeza brillante recorre cada anillo: se lee órbita, no aro.
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
    // Marco de la curva para repartir el caudal a lo ancho.
    vec3 tang = normalize(bez(min(t + 0.02, 1.0)) - bez(max(t - 0.02, 0.0)) + vec3(1e-5));
    vec3 n1 = normalize(vec3(-tang.y, tang.x, 0.0));

    float len = distance(uA, uB);
    float mid = sin(3.14159 * t);
    float lane = (fract(aSeed * 13.7) - 0.5) * 2.0;
    p += n1 * lane * len * (0.03 + 0.085 * mid);
    p.z += (fract(aSeed * 29.3) - 0.5) * len * 0.14 * mid;
    // Ondulación viva del caudal.
    p += n1 * sin(uTime * (1.2 + fract(aSeed * 5.0)) + aSeed * 40.0) * len * 0.018;

    // El cursor mete turbulencia: el río se comba hacia él y vuelve.
    float d = distance(p.xy, uPointer.xy);
    float g = smoothstep(2.4, 0.0, d) * uPointerK;
    p.xy += (uPointer.xy - p.xy) * g * 0.4;

    // El destello del momento: viaja del núcleo (t=1) a la mano (t=0).
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
    a *= smoothstep(1.0, 0.6, d); // el plano es cuadrado; su borde no puede verse
    gl_FragColor = vec4(uColor, a);
  }
`;

/* --------------------------------------------------------------------------
 * La escena
 * ------------------------------------------------------------------------ */

// Paleta del hero — siempre oscuro, así que los colores viven aquí y no en
// tokens del tema: lavanda índigo para la materia, blanco cálido-frío para lo
// encendido. (Los tokens --lph-* del CSS usan estos mismos valores.)
const COL_BODY = new THREE.Color('#8d85f5');
const COL_HOT = new THREE.Color('#f2f1ff');
const COL_CORE = new THREE.Color('#a89fff');
const COL_RIVER = new THREE.Color('#9f96ff');

type SceneProps = {
  mobile: boolean;
  frozen: boolean;
  pulseSignal: number;
};

function HeroActors({ mobile, frozen, pulseSignal }: SceneProps) {
  const density = mobile ? 0.4 : 1;
  const counts = useMemo(
    () => ({
      figure: Math.round(27_000 * density),
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: los buffers se generan una vez por montaje; regenerar 40k posiciones en vivo no compra nada.
  const built = useMemo(() => {
    const common = {
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    } as const;

    // La figura.
    const human = sampleHuman(counts.figure);
    const figGeo = new THREE.BufferGeometry();
    figGeo.setAttribute('position', new THREE.BufferAttribute(human.pos, 3));
    figGeo.setAttribute('aSeed', new THREE.BufferAttribute(human.seed, 1));
    // Los uniforms se guardan como objetos tipados aparte: el useFrame los
    // escribe cada frame y así no hay que indexar `material.uniforms` (cuyo
    // tipo admite undefined) por nombre.
    const figU = {
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
    const figMat = new THREE.ShaderMaterial({
      ...common,
      vertexShader: FIGURE_VERT,
      fragmentShader: FIGURE_FRAG,
      uniforms: figU,
    });

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
      ...common,
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
      ...common,
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
      ...common,
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
      ...common,
      vertexShader: HALO_VERT,
      fragmentShader: HALO_FRAG,
      uniforms: haloU,
    });

    return {
      figGeo,
      figMat,
      figU,
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
    // Los buffers se generan una vez por montaje; regenerarlos en vivo no
    // compra nada y tira 40k posiciones a la basura.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // En móvil la figura pasa por detrás del texto: cede luz (el scrim hace
    // el resto). El resto de actores conserva la suya.
    built.figU.uAlpha.value = mobile ? 0.36 : 0.46;
  }, [mobile, built]);

  useEffect(() => {
    const disposables = [
      built.figGeo,
      built.figMat,
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

  // --- Entradas: puntero, pulso -----------------------------------------
  const groupRef = useRef<THREE.Group>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const pointerNdc = useRef(new THREE.Vector2(0, 0));
  const pointerWorld = useRef(new THREE.Vector3(999, 999, 0));
  const pointerAt = useRef(-10);
  const hasPointer = useRef(false);
  const clockRef = useRef(0);
  const scratch = useMemo(() => new THREE.Vector3(), []);

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
    // Con reduced-motion el reloj queda clavado: la MISMA composición, quieta,
    // en un instante elegido para que la escena se vea completa.
    const t = frozen ? 2.2 : state.clock.elapsedTime + 2.2;
    clockRef.current = t;
    const dpr = state.gl.getPixelRatio();

    for (const u of [built.figU, built.coreU, built.ringsU, built.riverU]) {
      u.uTime.value = t;
      u.uDpr.value = dpr;
    }
    built.haloU.uTime.value = t;

    // Layout → uniforms (barato; corre por frame para absorber resize).
    built.figU.uFigOff.value.set(layout.fig.x, layout.fig.y);
    built.figU.uFigScale.value = layout.fig.scale;
    built.coreU.uCore.value.copy(layout.core);
    built.coreU.uCoreR.value = layout.coreR;
    built.ringsU.uCore.value.copy(layout.core);
    built.ringsU.uCoreR.value = layout.coreR;
    built.riverU.uA.value.copy(layout.hand);
    built.riverU.uB.value.copy(layout.core);
    built.riverU.uCtrl.value.copy(layout.ctrl);
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
    for (const u of [built.figU, built.riverU]) {
      u.uPointer.value.copy(pointerWorld.current);
      u.uPointerK.value += (targetK - u.uPointerK.value) * Math.min(1, delta * 4);
    }

    // Cámara con vida: la escena se inclina 2–3° hacia el cursor; sin puntero
    // fino, deriva sola, lenta.
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

  return (
    <group ref={groupRef}>
      <mesh ref={haloRef} geometry={built.haloGeo} material={built.haloMat} frustumCulled={false} />
      <points geometry={built.figGeo} material={built.figMat} frustumCulled={false} />
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
}: {
  frozen: boolean;
  paused: boolean;
  pulseSignal: number;
  onReady: () => void;
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
      gl={{ antialias: false, alpha: true, powerPreference: 'high-performance' }}
      onCreated={onReady}
    >
      <HeroActors mobile={mobile} frozen={frozen} pulseSignal={pulseSignal} />
    </Canvas>
  );
}
