'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';

/**
 * El organismo — la persona conectándose con la IA, contado en 40–60 mil
 * partículas y un solo draw call.
 *
 * QUÉ ES. Un único `<points>` con material de shader propio: una red neuronal
 * difusa que se lee como mente sin dibujar un cerebro (ni el cliché del cerebro
 * azul). En reposo respira — pulso de escala y opacidad con el mismo periodo
 * lento (~3.4s) que el design system usa para "esto está vivo pero no te está
 * pidiendo nada".
 *
 * LA CONEXIÓN ES EL CURSOR. El puntero se proyecta al plano z=0 del organismo;
 * las partículas cercanas se encienden y se inclinan hacia él, y de esa zona
 * salen filamentos breves (un pool de 14 segmentos, efímeros) que viajan hacia
 * el núcleo. La pregunta que contesta ese movimiento: «esto responde a mí».
 * En touch, el dedo hace de cursor vía touchmove.
 *
 * EL SCROLL ES UNA TRANSFORMACIÓN, NO UNA CÁMARA. La cámara no se mueve nunca.
 * Un uniforme (uScroll) morfea las posiciones entre tres estados del MISMO
 * organismo, baratísimo: tres juegos de posiciones en bufferAttributes y dos
 * mix() en el vértice.
 *
 *   arriba   → caos disperso: los datos sueltos de una empresa
 *   mitad    → constelaciones: la información encontrando su sitio
 *   al final → convergencia en un anillo nítido, junto al CTA de cierre
 *
 * EL MOMENTO DE RESPUESTA. Cuando el hero termina de aparecer (señal que llega
 * por props desde NeuralField), un halo se expande desde el núcleo y se apaga
 * en ~2s. Una vez. Un pulso permanente dejaría de ser un evento.
 *
 * PRESUPUESTO. 48k partículas en escritorio; 15k si el dispositivo se declara
 * táctil o con poca memoria. DPR acotado a [1, 1.5], antialias apagado (los
 * puntos con borde suave no lo necesitan), y si el frame rate se cae sostenido
 * el DPR baja a 1. El frameloop se detiene con visibilitychange: una pestaña
 * que nadie mira no quema batería.
 *
 * PALETA. No hay un color escrito aquí: se leen los tokens --lp-brand y
 * --lp-brand-ink ya resueltos por el tema del visitante. En claro el organismo
 * dibuja con blending normal (additive sobre fondo claro se lava hacia el
 * blanco); en oscuro, additive, que es donde ese blending significa luz.
 */

const BREATHE_S = 3.4; // el mismo pulso lento del design system
const PULSE_S = 2.0;
const FILAMENTS = 14;

type Palette = {
  core: THREE.Color;
  edge: THREE.Color;
  dark: boolean;
};

function readPalette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const parse = (name: string, fallback: [number, number, number]) => {
    const parts = styles.getPropertyValue(name).trim().split(/\s+/).map(Number);
    const src = parts.length === 3 && parts.every(Number.isFinite) ? parts : fallback;
    const [r = 88, g = 80, b = 236] = src;
    return new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace);
  };
  return {
    // brand-ink es el indigo con contraste de texto: en claro es el más hondo,
    // en oscuro el más luminoso. Justo lo que debe ser el centro encendido.
    core: parse('--lp-brand-ink', [62, 53, 199]),
    edge: parse('--lp-brand', [88, 80, 236]),
    dark: window.matchMedia('(prefers-color-scheme: dark)').matches,
  };
}

/* --------------------------------------------------------------------------
 * Los tres estados del organismo. Se generan una vez, en el cliente, y viven
 * como tres atributos del mismo buffer — el shader los mezcla con el scroll.
 * ------------------------------------------------------------------------ */

/** Aproximación gaussiana barata: suma de tres uniformes, centrada en 0. */
function gauss(): number {
  return Math.random() + Math.random() + Math.random() - 1.5;
}

function buildAttributes(count: number) {
  const chaos = new Float32Array(count * 3);
  const order = new Float32Array(count * 3);
  const focus = new Float32Array(count * 3);
  const seed = new Float32Array(count);

  // Constelaciones: nueve cúmulos repartidos a lo ancho, ninguno centrado del
  // todo — el orden intermedio todavía no es la respuesta, es el borrador.
  const clusters: Array<[number, number, number]> = [
    [-5.6, 2.6, -0.6],
    [-3.4, -1.9, 0.4],
    [-1.2, 2.9, 0.2],
    [0.6, -0.4, -0.5],
    [2.4, 2.3, 0.5],
    [4.6, -1.4, -0.3],
    [6.0, 1.8, 0.2],
    [-6.2, -0.6, 0.1],
    [3.4, 3.4, -0.4],
  ];

  // El anillo final, levemente inclinado para que tenga volumen sin dejar de
  // leerse nítido. Corrido bien a la derecha: el CTA de cierre vive a la
  // izquierda y el anillo debe acompañarlo, no sentársele encima.
  const R = 3.6;
  const tiltX = 0.42;
  const tiltY = -0.22;
  const cosX = Math.cos(tiltX);
  const sinX = Math.sin(tiltX);
  const cosY = Math.cos(tiltY);
  const sinY = Math.sin(tiltY);
  const focusOffsetX = 4.6;

  for (let i = 0; i < count; i++) {
    const j = i * 3;
    const s = Math.random();
    seed[i] = s;

    // Estado 1 — caos: una nube ancha y aplanada, con una cola de outliers
    // para que el borde no se corte en una elipse perfecta.
    // Corrida un punto a la derecha: el texto del hero vive a la izquierda y
    // el centro de masa del caos no debe caerle encima.
    const wild = Math.random() < 0.22 ? 1.9 : 1.0;
    const cx0 = gauss() * 5.4 * wild + 0.9;
    const cy0 = gauss() * 3.1 * wild;
    const cz0 = gauss() * 1.5;
    chaos[j] = cx0;
    chaos[j + 1] = cy0;
    chaos[j + 2] = cz0;

    // Estado 2 — constelaciones: cada partícula a su cúmulo, con un 12% que se
    // queda de polvo entre medio para que el orden no parezca un stencil.
    if (s < 0.12) {
      order[j] = cx0 * 0.8;
      order[j + 1] = cy0 * 0.8;
      order[j + 2] = cz0 * 0.8;
    } else {
      const [cx, cy, cz] = clusters[i % clusters.length]!;
      order[j] = cx + gauss() * 1.15;
      order[j + 1] = cy + gauss() * 0.85;
      order[j + 2] = cz + gauss() * 0.6;
    }

    // Estado 3 — convergencia: un toro delgado (el anillo), con un 6% de halo
    // suelto alrededor para que la forma nítida siga siendo un organismo.
    if (s > 0.94) {
      const rr = 5.6 + gauss() * 0.8;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      focus[j] = rr * Math.sin(ph) * Math.cos(th) + focusOffsetX;
      focus[j + 1] = rr * Math.sin(ph) * Math.sin(th) * 0.6;
      focus[j + 2] = rr * Math.cos(ph) * 0.5;
    } else {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.random() * Math.PI * 2;
      const tube = Math.abs(gauss()) * 0.42;
      let x = (R + tube * Math.cos(phi)) * Math.cos(theta);
      let y = (R + tube * Math.cos(phi)) * Math.sin(theta);
      let z = tube * Math.sin(phi);
      // Inclinación horneada en el buffer: rotX y luego rotY.
      const y2 = y * cosX - z * sinX;
      const z2 = y * sinX + z * cosX;
      y = y2;
      z = z2;
      const x2 = x * cosY + z * sinY;
      const z3 = -x * sinY + z * cosY;
      x = x2;
      z = z3;
      focus[j] = x + focusOffsetX;
      focus[j + 1] = y;
      focus[j + 2] = z;
    }
  }

  return { chaos, order, focus, seed };
}

/* --------------------------------------------------------------------------
 * Shaders
 * ------------------------------------------------------------------------ */

const ORGANISM_VERT = /* glsl */ `
  uniform float uTime;
  uniform float uScroll;
  uniform float uPulse;
  uniform float uFit;
  uniform float uDpr;
  uniform float uSize;
  uniform float uPointerK;
  uniform vec3 uPointer;

  attribute vec3 aOrder;
  attribute vec3 aFocus;
  attribute float aSeed;

  varying float vGlow;
  varying float vRing;
  varying float vBreath;

  const float TAU = 6.2831853;

  void main() {
    // La transformación que cuenta el scroll: caos → constelaciones → anillo.
    float s1 = smoothstep(0.0, 0.55, uScroll);
    float s2 = smoothstep(0.48, 1.0, uScroll);
    vec3 p = mix(position, aOrder, s1);
    p = mix(p, aFocus, s2);

    // Deriva orgánica, que se aquieta cuando la forma converge.
    float loose = 1.0 - 0.72 * s2;
    p += loose * 0.16 * vec3(
      sin(uTime * 0.45 + aSeed * 31.0),
      cos(uTime * 0.38 + aSeed * 57.0),
      sin(uTime * 0.52 + aSeed * 13.0)
    );

    // La respiración: mismo periodo lento del design system.
    p *= (1.0 + 0.024 * sin(uTime * TAU / ${BREATHE_S.toFixed(1)})) * uFit;

    // La conexión: cerca del puntero las partículas se encienden y se
    // inclinan hacia él. uPointerK decae cuando la mano se queda quieta.
    // La atracción es una inclinación, no un imán: más fuerte y el cursor
    // amasa una mancha sólida que tapa el texto.
    float d = distance(p.xy, uPointer.xy);
    float glow = smoothstep(2.6, 0.2, d) * uPointerK;
    vec2 pull = uPointer.xy - p.xy;
    p.xy += normalize(pull + vec2(1e-4)) * glow * 0.16;

    // El momento de respuesta: un casquete que se expande desde el núcleo.
    float pt = uTime - uPulse;
    float ring = 0.0;
    if (pt > 0.0 && pt < ${PULSE_S.toFixed(1)}) {
      float k = pt / ${PULSE_S.toFixed(1)};
      float radius = 9.5 * (1.0 - pow(1.0 - k, 2.0));
      ring = smoothstep(1.15, 0.0, abs(length(p) - radius)) * pow(1.0 - k, 1.5);
    }

    vGlow = glow;
    vRing = ring;
    vBreath = 0.62 + 0.38 * sin(uTime * TAU / ${BREATHE_S.toFixed(1)} + aSeed * TAU);

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    float size = uSize * (0.55 + 0.9 * fract(aSeed * 7.31)) * (1.0 + 0.9 * glow + 0.7 * ring);
    gl_PointSize = size * uDpr * (55.0 / -mv.z);
  }
`;

const ORGANISM_FRAG = /* glsl */ `
  uniform vec3 uCore;
  uniform vec3 uEdge;
  uniform float uAlpha;

  varying float vGlow;
  varying float vRing;
  varying float vBreath;

  void main() {
    // Borde más firme que un bokeh: el punto debe leerse como partícula, no
    // como una mota desenfocada.
    float m = smoothstep(0.5, 0.18, length(gl_PointCoord - 0.5));
    if (m < 0.02) discard;
    float lit = clamp(vGlow + vRing, 0.0, 1.0);
    vec3 col = mix(uEdge, uCore, lit);
    float a = uAlpha * m * (0.3 + 0.7 * vBreath) * (0.45 + 0.55 * lit);
    gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
  }
`;

const FILAMENT_VERT = /* glsl */ `
  attribute float aA;
  varying float vA;
  void main() {
    vA = aA;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FILAMENT_FRAG = /* glsl */ `
  uniform vec3 uColor;
  uniform float uAlpha;
  varying float vA;
  void main() {
    gl_FragColor = vec4(uColor, vA * uAlpha);
  }
`;

/* --------------------------------------------------------------------------
 * Filamentos: un pool fijo de segmentos que nacen cerca del puntero y viajan
 * al núcleo por una curva. Pocos, breves, y un solo draw call aparte.
 * ------------------------------------------------------------------------ */

type Filament = {
  t: number;
  life: number;
  from: THREE.Vector3;
  ctrl: THREE.Vector3;
};

function bezier(out: THREE.Vector3, a: THREE.Vector3, c: THREE.Vector3, t: number) {
  // Cuadrática hacia el origen (el núcleo): b(t) = (1-t)²a + 2t(1-t)c.
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x,
    u * u * a.y + 2 * u * t * c.y,
    u * u * a.z + 2 * u * t * c.z,
  );
  return out;
}

/* --------------------------------------------------------------------------
 * El organismo dentro del Canvas
 * ------------------------------------------------------------------------ */

function Organism({
  count,
  pulseSignal,
  onSlow,
}: {
  count: number;
  pulseSignal: number;
  onSlow: () => void;
}) {
  const palette = useMemo(readPalette, []);

  const { geometry, material } = useMemo(() => {
    const { chaos, order, focus, seed } = buildAttributes(count);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(chaos, 3));
    geo.setAttribute('aOrder', new THREE.BufferAttribute(order, 3));
    geo.setAttribute('aFocus', new THREE.BufferAttribute(focus, 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

    const mat = new THREE.ShaderMaterial({
      vertexShader: ORGANISM_VERT,
      fragmentShader: ORGANISM_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uTime: { value: 0 },
        uScroll: { value: 0 },
        uPulse: { value: -10 },
        uFit: { value: 1 },
        uDpr: { value: 1 },
        uSize: { value: 0.85 },
        uPointer: { value: new THREE.Vector3(40, 40, 0) },
        uPointerK: { value: 0 },
        uCore: { value: palette.core },
        uEdge: { value: palette.edge },
        // Con 48k partículas la opacidad se acumula: el organismo tiene que
        // quedarse DETRÁS del texto, nunca compitiendo con él.
        uAlpha: { value: palette.dark ? 0.5 : 0.3 },
      },
    });
    return { geometry: geo, material: mat };
    // count y palette se fijan al montar; regenerar 48k posiciones en vivo no
    // compra nada.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filaments = useMemo(() => {
    const positions = new Float32Array(FILAMENTS * 2 * 3);
    const alphas = new Float32Array(FILAMENTS * 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aA', new THREE.BufferAttribute(alphas, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: FILAMENT_VERT,
      fragmentShader: FILAMENT_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      // En oscuro el filamento es luz (additive); en claro, tinta indigo.
      blending: palette.dark ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: {
        uColor: { value: palette.core },
        uAlpha: { value: palette.dark ? 0.85 : 0.55 },
      },
    });
    return { geo, mat, positions, alphas, pool: new Array<Filament | null>(FILAMENTS).fill(null) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
      filaments.geo.dispose();
      filaments.mat.dispose();
    };
  }, [geometry, material, filaments]);

  // --- Entradas del mundo real: puntero y scroll -------------------------
  const pointerNdc = useRef(new THREE.Vector2(0, 0));
  const pointerWorld = useRef(new THREE.Vector3(40, 40, 0));
  const pointerAt = useRef(-10); // último movimiento, en tiempo de reloj
  const lastSpawnAt = useRef(0);
  const scrollTarget = useRef(0);
  const scrollCurrent = useRef(0);
  const elapsedRef = useRef(0);

  useEffect(() => {
    const onPointer = (x: number, y: number) => {
      pointerNdc.current.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
      pointerAt.current = elapsedRef.current;
    };
    const onMove = (e: PointerEvent) => onPointer(e.clientX, e.clientY);
    const onTouch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) onPointer(t.clientX, t.clientY);
    };
    const onScroll = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      scrollTarget.current = max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
    };
    onScroll();
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('touchmove', onTouch, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('touchmove', onTouch);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  // El pulso del hero: la señal llega por props; el instante se fija en tiempo
  // del reloj de la escena, que es el que corre dentro del shader.
  useEffect(() => {
    if (pulseSignal > 0) {
      material.uniforms.uPulse!.value = elapsedRef.current + 0.05;
    }
  }, [pulseSignal, material]);

  // --- Vigilancia de frame rate: si se sostiene bajo, avisa para bajar DPR.
  const fpsFrames = useRef(0);
  const fpsStart = useRef(0);
  const slowReported = useRef(false);

  const scratch = useMemo(
    () => ({ head: new THREE.Vector3(), tail: new THREE.Vector3(), dir: new THREE.Vector3() }),
    [],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    elapsedRef.current = t;
    const u = material.uniforms;

    u.uTime!.value = t;
    u.uDpr!.value = state.gl.getPixelRatio();

    // Encajar el organismo en viewports angostos sin mover la cámara.
    u.uFit!.value = Math.min(1, Math.max(0.6, state.viewport.width / 15));

    // El scroll llega a saltos; el uniforme lo alcanza con un suavizado corto.
    scrollCurrent.current +=
      (scrollTarget.current - scrollCurrent.current) * Math.min(1, delta * 5);
    u.uScroll!.value = scrollCurrent.current;

    // Puntero: de NDC al plano z=0 del organismo.
    const cam = state.camera;
    scratch.dir.set(pointerNdc.current.x, pointerNdc.current.y, 0.5).unproject(cam);
    scratch.dir.sub(cam.position).normalize();
    const reach = -cam.position.z / scratch.dir.z;
    if (Number.isFinite(reach) && reach > 0) {
      scratch.head.copy(cam.position).addScaledVector(scratch.dir, reach);
      pointerWorld.current.lerp(scratch.head, Math.min(1, delta * 9));
    }
    (u.uPointer!.value as THREE.Vector3).copy(pointerWorld.current);

    // La atención decae: 2s después del último movimiento el brillo se apaga.
    const idle = t - pointerAt.current;
    const targetK = idle < 2 ? 1 : 0;
    u.uPointerK!.value += (targetK - u.uPointerK!.value) * Math.min(1, delta * 4);

    // --- Filamentos --------------------------------------------------------
    const { pool, positions, alphas, geo } = filaments;

    // Nace uno si la mano se está moviendo y hay sitio en el pool.
    if (idle < 0.25 && t - lastSpawnAt.current > 0.09 && Math.random() < 0.8) {
      const slot = pool.indexOf(null);
      if (slot !== -1) {
        const from = pointerWorld.current
          .clone()
          .add(new THREE.Vector3(gauss() * 0.9, gauss() * 0.9, gauss() * 0.4));
        const mid = from.clone().multiplyScalar(0.5);
        const ctrl = mid.add(new THREE.Vector3(gauss() * 1.4, gauss() * 1.4, gauss() * 0.6));
        pool[slot] = { t: 0, life: 0.55 + Math.random() * 0.35, from, ctrl };
        lastSpawnAt.current = t;
      }
    }

    for (let i = 0; i < FILAMENTS; i++) {
      const f = pool[i];
      const j = i * 6;
      if (!f) {
        alphas[i * 2] = 0;
        alphas[i * 2 + 1] = 0;
        continue;
      }
      f.t += delta / f.life;
      if (f.t >= 1) {
        pool[i] = null;
        alphas[i * 2] = 0;
        alphas[i * 2 + 1] = 0;
        continue;
      }
      bezier(scratch.head, f.from, f.ctrl, f.t);
      bezier(scratch.tail, f.from, f.ctrl, Math.max(0, f.t - 0.22));
      positions[j] = scratch.tail.x;
      positions[j + 1] = scratch.tail.y;
      positions[j + 2] = scratch.tail.z;
      positions[j + 3] = scratch.head.x;
      positions[j + 4] = scratch.head.y;
      positions[j + 5] = scratch.head.z;
      const fade = Math.sin(Math.PI * f.t);
      alphas[i * 2] = fade * 0.25;
      alphas[i * 2 + 1] = fade;
    }
    geo.attributes.position!.needsUpdate = true;
    geo.attributes.aA!.needsUpdate = true;

    // --- Frame rate: promedio en ventanas de 2s ---------------------------
    fpsFrames.current += 1;
    if (t - fpsStart.current >= 2) {
      const fps = fpsFrames.current / (t - fpsStart.current);
      if (fps < 34 && !slowReported.current) {
        slowReported.current = true;
        onSlow();
      }
      fpsFrames.current = 0;
      fpsStart.current = t;
    }
  });

  return (
    <>
      <points geometry={geometry} material={material} frustumCulled={false} />
      <lineSegments geometry={filaments.geo} material={filaments.mat} frustumCulled={false} />
    </>
  );
}

/* --------------------------------------------------------------------------
 * El Canvas
 * ------------------------------------------------------------------------ */

function pickCount(): number {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const weak = coarse || (typeof memory === 'number' && memory <= 4);
  return weak ? 15_000 : 48_000;
}

export default function NeuralScene({
  pulseSignal,
  onReady,
}: {
  pulseSignal: number;
  onReady: () => void;
}) {
  const [count] = useState(pickCount);
  const [dpr, setDpr] = useState<number | [number, number]>([1, 1.5]);
  const [frameloop, setFrameloop] = useState<'always' | 'never'>('always');

  // Una pestaña oculta no dibuja. El navegador ya estrangula el rAF, pero
  // detener el loop del todo es gratis y no deja al reloj corriendo a saltos.
  useEffect(() => {
    const onVisibility = () => setFrameloop(document.hidden ? 'never' : 'always');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <Canvas
      frameloop={frameloop}
      dpr={dpr}
      camera={{ fov: 45, position: [0, 0, 17], near: 1, far: 60 }}
      gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
      onCreated={onReady}
    >
      <Organism count={count} pulseSignal={pulseSignal} onSlow={() => setDpr(1)} />
    </Canvas>
  );
}
