'use client';

import { Canvas, useFrame, useLoader, useThree } from '@react-three/fiber';
import { type MutableRefObject, Suspense, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';

const HUMAN = '/images/cortex-human-connection.png';
const humanVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }
`;
const humanFragment = /* glsl */ `
  uniform sampler2D uImage;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    vec3 color = texture2D(uImage,vUv).rgb;
    float light = max(color.r,max(color.g,color.b));
    float edge = smoothstep(0.,.06,vUv.y) * smoothstep(0.,.02,min(vUv.x,1.-vUv.x));
    if(light < .008) discard;
    gl_FragColor = vec4(color / max(light,.008), light * edge * uOpacity);
  }
`;
const vertex = /* glsl */ `
  attribute vec3 aOrigin;
  attribute float aSeed;
  uniform float uProgress;
  uniform float uTime;
  uniform float uFigureSize;
  uniform vec2 uFigure;
  uniform vec2 uCore;
  uniform float uDpr;
  varying float vAlpha;
  varying float vSeed;
  void main() {
    float reach = smoothstep(0.05, 0.3, uProgress);
    vec3 origin = vec3(aOrigin.xy * uFigureSize + uFigure, aOrigin.z);
    origin.x += reach * uFigureSize * .075;
    float burst = smoothstep(.30, .56, uProgress);
    float form = smoothstep(.52, .95, uProgress);
    vec3 direction = normalize(origin - vec3(uCore,0.) + vec3(sin(aSeed*71.),cos(aSeed*39.),sin(aSeed*27.)) * .7);
    vec3 dispersed = origin + direction * burst * (2. + aSeed * 3.);
    dispersed += vec3(sin(aSeed*48. + uTime*.45),cos(aSeed*73. + uTime*.35),sin(aSeed*21.)) * burst * (1.-form) * .35;
    vec3 target = position * min(uFigureSize * .30, 2.);
    float angle = uTime * .045;
    target.xy = mat2(cos(angle),-sin(angle),sin(angle),cos(angle)) * target.xy;
    vec3 point = mix(dispersed, target, form);
    vec4 mv = modelViewMatrix * vec4(point, 1.);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp((1.1 + aSeed * 1.1) * uDpr * (9. / -mv.z), 1., 5.);
    vAlpha = smoothstep(.26,.34,uProgress) * (.3 + aSeed*.65);
    vSeed = aSeed;
  }
`;
const fragment = /* glsl */ `
  varying float vAlpha;
  varying float vSeed;
  void main() {
    float radius = length(gl_PointCoord - .5);
    float alpha = (1. - smoothstep(.1, .5, radius)) * vAlpha;
    if(alpha < .01) discard;
    gl_FragColor = vec4(mix(vec3(.55,.64,.83), vec3(.94,.92,1.),vSeed),alpha);
  }
`;

function Actors({
  progressRef,
  onReady,
}: { progressRef: MutableRefObject<number>; onReady: () => void }) {
  const texture = useLoader(THREE.TextureLoader, HUMAN);
  const viewport = useThree((state) => state.viewport);
  const human = useRef<THREE.Mesh>(null);
  const core = useRef<THREE.Group>(null);
  const beam = useRef<THREE.Mesh>(null);
  const shock = useRef<THREE.Mesh>(null);
  const time = useRef(0);
  const smoothed = useRef(0);
  const wide = viewport.width > viewport.height;
  const figureSize = wide ? viewport.height * 0.92 : viewport.width * 1.05;
  const figureX = wide ? -viewport.width * 0.21 : -viewport.width * 0.12;
  const figureY = wide ? 0 : -viewport.height * 0.03;
  const coreX = viewport.width * 0.28;
  const coreY = viewport.height * (wide ? 0.28 : 0.26);
  const portraitUniforms = useMemo(
    () => ({ uImage: { value: texture }, uOpacity: { value: 1 } }),
    [texture],
  );
  const coreCurve = useMemo(
    () =>
      new THREE.CatmullRomCurve3(
        Array.from({ length: 160 }, (_, i) => {
          const t = i / 159;
          const a = -Math.PI / 2 + t * Math.PI * 4.6;
          const r = 0.035 + t * 0.48;
          return new THREE.Vector3(Math.cos(a) * r, Math.sin(a) * r, 0);
        }),
      ),
    [],
  );
  const field = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 384;
    canvas.height = 384;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('No se pudo preparar la figura');
    ctx.drawImage(texture.image, 0, 0, 384, 384);
    const pixels = ctx.getImageData(0, 0, 384, 384).data;
    const cells: number[] = [];
    for (let i = 0; i < 384 * 384; i++) if ((pixels[i * 4] ?? 0) > 36) cells.push(i);
    if (!cells.length) throw new Error('La figura no contiene puntos visibles');
    const count = matchMedia('(max-width: 700px)').matches ? 6500 : 14000;
    const origin = new Float32Array(count * 3);
    const target = new Float32Array(count * 3);
    const seeds = new Float32Array(count);
    let seed = 42;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const cell = cells[Math.floor(random() * cells.length)] ?? 0;
      origin[i * 3] = ((cell % 384) + random()) / 384 - 0.5;
      origin[i * 3 + 1] = 0.5 - (Math.floor(cell / 384) + random()) / 384;
      origin[i * 3 + 2] = (random() - 0.5) * 0.06;
      const u = Math.sqrt(random());
      const a = -Math.PI / 2 + u * Math.PI * 4.6;
      const radius = 0.065 + 0.935 * u + (random() - 0.5) * 0.046;
      target[i * 3] = Math.cos(a) * radius;
      target[i * 3 + 1] = Math.sin(a) * radius;
      target[i * 3 + 2] = (random() - 0.5) * 0.045;
      seeds[i] = random();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(target, 3));
    geometry.setAttribute('aOrigin', new THREE.BufferAttribute(origin, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const uniforms = {
      uProgress: { value: 0 },
      uTime: { value: 0 },
      uFigureSize: { value: 1 },
      uFigure: { value: new THREE.Vector2() },
      uCore: { value: new THREE.Vector2() },
      uDpr: { value: 1 },
    };
    const material = new THREE.ShaderMaterial({
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms,
    });
    return { geometry, material, uniforms };
  }, [texture]);
  useEffect(() => {
    onReady();
    return () => {
      field.geometry.dispose();
      field.material.dispose();
    };
  }, [field, onReady]);
  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    smoothed.current = THREE.MathUtils.damp(smoothed.current, progressRef.current, 9, dt);
    const p = smoothed.current;
    time.current = p * 18.5;
    const reach = THREE.MathUtils.smoothstep(p, 0.05, 0.3);
    const fade = 1 - THREE.MathUtils.smoothstep(p, 0.3, 0.43);
    const x = figureX + reach * figureSize * 0.075;
    const u = field.uniforms;
    u.uProgress.value = p;
    u.uTime.value = time.current;
    u.uDpr.value = state.gl.getPixelRatio();
    u.uFigureSize.value = figureSize;
    u.uFigure.value.set(figureX, figureY);
    if (human.current) {
      human.current.position.set(x, figureY, 0);
      human.current.scale.setScalar(figureSize);
      const opacity = (human.current.material as THREE.ShaderMaterial).uniforms.uOpacity;
      if (opacity) opacity.value = fade;
    }
    const finger = new THREE.Vector3(x + figureSize * 0.426, figureY + figureSize * 0.27, 0);
    const destination = new THREE.Vector3(coreX, coreY, 0).lerp(finger, reach);
    u.uCore.value.set(destination.x, destination.y);
    if (core.current) {
      core.current.position.copy(destination);
      core.current.rotation.z = time.current * 0.12;
      core.current.scale.setScalar((1 + reach * 0.3) * fade * (wide ? 1 : 0.8));
    }
    if (beam.current) {
      const direction = destination.clone().sub(finger);
      beam.current.position.copy(finger).addScaledVector(direction, 0.5);
      beam.current.scale.set(0.006, direction.length(), 1);
      beam.current.rotation.z = -Math.atan2(direction.x, direction.y);
      (beam.current.material as THREE.MeshBasicMaterial).opacity = reach * fade * 0.6;
    }
    if (shock.current) {
      const burst = THREE.MathUtils.smoothstep(p, 0.3, 0.55);
      shock.current.position.copy(destination);
      shock.current.scale.setScalar(0.1 + burst * 8);
      (shock.current.material as THREE.MeshBasicMaterial).opacity =
        Math.sin(burst * Math.PI) * 0.23;
    }
  });
  return (
    <>
      <mesh ref={human}>
        <planeGeometry args={[1, 1]} />
        <shaderMaterial
          uniforms={portraitUniforms}
          vertexShader={humanVertex}
          fragmentShader={humanFragment}
          transparent
          depthWrite={false}
        />
      </mesh>
      <points geometry={field.geometry} material={field.material} frustumCulled={false} />
      <group ref={core}>
        <mesh>
          <tubeGeometry args={[coreCurve, 180, 0.009, 6, false]} />
          <meshBasicMaterial color="#dad5f4" toneMapped={false} />
        </mesh>
      </group>
      <mesh ref={beam}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color="#dad8ff" transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh ref={shock}>
        <ringGeometry args={[0.98, 1, 96]} />
        <meshBasicMaterial
          color="#c8d7f3"
          transparent
          opacity={0}
          depthWrite={false}
          side={THREE.DoubleSide}
        />
      </mesh>
    </>
  );
}

export default function ConnectionScene({
  paused,
  progressRef,
  onReady,
}: { paused: boolean; progressRef: MutableRefObject<number>; onReady: () => void }) {
  return (
    <Canvas
      frameloop={paused ? 'demand' : 'always'}
      camera={{ position: [0, 0, 10], fov: 45 }}
      dpr={[1, 1.5]}
      gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
    >
      <Suspense fallback={null}>
        <Actors progressRef={progressRef} onReady={onReady} />
      </Suspense>
    </Canvas>
  );
}
