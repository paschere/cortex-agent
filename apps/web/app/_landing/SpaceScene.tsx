'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { Component, type ReactNode, useMemo, useRef } from 'react';
import * as THREE from 'three';

// A deterministic five-arm spiral: no asset downloads or per-frame particle allocations.
function particleField(count: number, stars: boolean) {
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  let seed = 73;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const inner = new THREE.Color('#e7e2ff');
  const outer = new THREE.Color('#657bd8');
  const color = new THREE.Color();
  for (let i = 0; i < count; i++) {
    const radius = 0.35 + random() ** 0.7 * 3.5;
    const angle = (i % 5) * ((Math.PI * 2) / 5) + radius * 1.65;
    const spread = random() ** 2 * 0.65;
    positions[i * 3] = stars
      ? (random() - 0.5) * 24
      : Math.cos(angle) * radius + (random() - 0.5) * spread;
    positions[i * 3 + 1] = stars ? (random() - 0.5) * 15 : (random() - 0.5) * 0.22 * radius;
    positions[i * 3 + 2] = stars
      ? (random() - 0.5) * 12 - 3
      : Math.sin(angle) * radius + (random() - 0.5) * spread;
    color.copy(inner).lerp(outer, radius / 4);
    color.multiplyScalar(stars ? 0.35 + random() * 0.4 : 0.65 + random() * 0.6);
    color.toArray(colors, i * 3);
  }
  return { positions, colors };
}

function Dust({ stars = false, compact }: { stars?: boolean; compact: boolean }) {
  const { positions, colors } = useMemo(
    () => particleField(stars ? 550 : compact ? 4500 : 10000, stars),
    [stars, compact],
  );
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <shaderMaterial
        transparent
        depthWrite={false}
        vertexColors
        blending={THREE.AdditiveBlending}
        uniforms={{ size: { value: stars ? 12 : compact ? 30 : 28 } }}
        vertexShader={`uniform float size; varying vec3 tint;
          void main(){ tint=color; vec4 p=modelViewMatrix*vec4(position,1.);
          gl_Position=projectionMatrix*p; gl_PointSize=clamp(size/-p.z,1.,9.); }`}
        fragmentShader={`varying vec3 tint;
          void main(){ float r=length(gl_PointCoord-.5)*2.;
          float a=pow(max(0.,1.-r),2.); gl_FragColor=vec4(pow(tint,vec3(.65)),a*.9); }`}
      />
    </points>
  );
}

function Galaxy({ compact }: { compact: boolean }) {
  const orbit = useRef<THREE.Group>(null);
  const world = useRef<THREE.Group>(null);
  useFrame(({ pointer }, delta) => {
    const dt = Math.min(delta, 0.05);
    if (orbit.current) orbit.current.rotation.y += dt * 0.045;
    if (world.current) {
      world.current.rotation.z = THREE.MathUtils.damp(
        world.current.rotation.z,
        -0.28 + pointer.x * 0.08,
        2,
        dt,
      );
      world.current.rotation.x = THREE.MathUtils.damp(
        world.current.rotation.x,
        0.48 + pointer.y * 0.06,
        2,
        dt,
      );
    }
  });
  return (
    <>
      <Dust stars compact={compact} />
      <group ref={world} rotation={[0.48, 0, -0.28]}>
        <group ref={orbit}>
          <Dust compact={compact} />
          {[2.65, 3.55, 4.35].map((radius, i) => (
            <mesh key={radius} rotation={[Math.PI / 2 + i * 0.12, i * 0.1, 0]}>
              <torusGeometry args={[radius, 0.004, 4, 180]} />
              <meshBasicMaterial color="#969cdd" transparent opacity={0.2 - i * 0.035} />
            </mesh>
          ))}
        </group>
        <mesh rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[3, 3]} />
          <shaderMaterial
            transparent
            depthWrite={false}
            blending={THREE.AdditiveBlending}
            vertexShader={
              'varying vec2 uvp; void main(){uvp=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}'
            }
            fragmentShader={
              'varying vec2 uvp;void main(){float r=length(uvp-.5)*2.;float a=exp(-r*r*8.);gl_FragColor=vec4(.5,.4,.9,a*.42);}'
            }
          />
        </mesh>
      </group>
    </>
  );
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function SpaceScene({ active, compact }: { active: boolean; compact: boolean }) {
  return (
    <SceneBoundary>
      <Canvas
        camera={{ position: [0, 5.3, 7.7], fov: 49 }}
        dpr={[1, 1.5]}
        frameloop={active ? 'always' : 'demand'}
        gl={{ alpha: true, antialias: false, powerPreference: 'low-power' }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0);
        }}
        fallback={<span />}
      >
        <Galaxy compact={compact} />
      </Canvas>
    </SceneBoundary>
  );
}
