'use client';

import { Html, OrbitControls, useCursor } from '@react-three/drei';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { num } from '../format';
import { PALETTE_FALLBACK, PALETTE_VARS, type PlacedCluster, type PlacedDocNode } from './layout';

/**
 * La constelación: el cerebro de la empresa como un organismo 3D.
 *
 * QUÉ ES CADA COSA. Cada espacio es un cúmulo con su halo; cada documento una
 * esfera cuyo tamaño es cuántos fragmentos dejó en memoria; las líneas finas
 * atan cada documento al centro de su espacio. Los cúmulos orbitan MUY lento
 * alrededor de un núcleo común — lo bastante lento para que se sienta vivo y
 * lo bastante quieto para poder señalar algo con el dedo.
 *
 * EL PRESUPUESTO DE BATERÍA. `frameloop="demand"` + DPR acotado [1, 1.5]: la
 * escena no dibuja nada si nada cambió. La animación pide sus propios frames a
 * ~30 fps con un intervalo que se apaga cuando la pestaña no se ve y cuando la
 * persona pidió `prefers-reduced-motion` — en ese caso la escena queda
 * estática (las posiciones sembradas ya son la composición) y solo se redibuja
 * al interactuar, que es exactamente lo que ese ajuste pide.
 *
 * COLORES POR TOKEN. Nada de hex inventados: los materiales leen los mismos
 * `--primary/--sky/--emerald/--amber` de globals.css en runtime, así la escena
 * cambia si la marca cambia. El fondo es `--rail` — la única superficie oscura
 * que este design system ya tiene, no un negro nuevo.
 */

/* -------------------------------------------------------------------- tokens */

/** Lee un token `R G B` de globals.css y lo vuelve color de three. */
function tokenColor(varName: string, fallback: string): THREE.Color {
  const out = new THREE.Color();
  if (typeof window === 'undefined') return out.set(fallback);
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  const parts = raw.split(/\s+/).map(Number);
  const [r, g, b] = parts;
  if (parts.length < 3 || [r, g, b].some((v) => v === undefined || Number.isNaN(v))) {
    return out.set(fallback);
  }
  // Los tokens están en sRGB; declararlo evita que el color management de
  // three los lave o los queme al pasarlos al espacio lineal de trabajo.
  return out.setRGB(
    (r as number) / 255,
    (g as number) / 255,
    (b as number) / 255,
    THREE.SRGBColorSpace,
  );
}

function usePalette(): THREE.Color[] {
  // Una sola lectura de getComputedStyle por montaje: los tokens no cambian
  // mientras la escena vive, y leerlos por frame sería trabajo de DOM en un
  // bucle de render.
  return useMemo(
    () => PALETTE_VARS.map((v, i) => tokenColor(v, PALETTE_FALLBACK[i] ?? '#5850ec')),
    [],
  );
}

/* ---------------------------------------------------------------------- glow */

/**
 * El halo de un cúmulo: un sprite con un degradado radial pintado en un
 * canvas. Procedural — sin assets externos — y un solo canvas compartido por
 * todos los halos; el tinte lo pone el material de cada sprite.
 */
function makeGlowTexture(): THREE.CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/* -------------------------------------------------------------------- motor */

/**
 * El corazón del `frameloop="demand"`: mientras el movimiento esté permitido,
 * pide un frame cada ~33 ms — y deja de pedirlos cuando la pestaña se oculta.
 * Un `useFrame` que invalidara siempre sería un frameloop continuo disfrazado.
 */
function MotionTicker({ enabled }: { enabled: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (!document.hidden) invalidate();
    }, 33);
    return () => window.clearInterval(id);
  }, [enabled, invalidate]);
  return null;
}

/* -------------------------------------------------------------------- núcleo */

function Nucleus({ color, glow }: { color: THREE.Color; glow: THREE.Texture }) {
  return (
    <group>
      <mesh>
        <sphereGeometry args={[0.55, 24, 24]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={0.8}
          roughness={0.35}
        />
      </mesh>
      <sprite scale={[3.4, 3.4, 1]}>
        <spriteMaterial
          map={glow}
          color={color}
          transparent
          opacity={0.5}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </sprite>
    </group>
  );
}

/* -------------------------------------------------------------------- cúmulo */

function DocNode({
  node,
  color,
  onOpen,
}: {
  node: PlacedDocNode;
  color: THREE.Color;
  onOpen: (id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  // Cursor de mano sobre una esfera: es la misma promesa que un enlace.
  useCursor(hovered);

  return (
    <group position={node.position}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: <mesh> no es un elemento
          DOM — es un objeto de three dentro del canvas y no puede recibir foco
          ni eventos de teclado. El camino de teclado hacia estos mismos
          documentos es la vista Lista, que sigue siendo el default. */}
      <mesh
        // Geometría unitaria escalada por mesh: el hover cambia una escala, no
        // reconstruye buffers. 16×16 segmentos porque una esfera de este tamaño
        // en pantalla no gana nada con más.
        scale={hovered ? node.radius * 1.35 : node.radius}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
        }}
        onPointerOut={() => setHovered(false)}
        onClick={(e) => {
          e.stopPropagation();
          onOpen(node.id);
        }}
      >
        <sphereGeometry args={[1, 16, 16]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={hovered ? 1 : 0.4}
          roughness={0.4}
          metalness={0.1}
        />
      </mesh>
      {hovered && (
        <Html
          position={[0, node.radius + 0.3, 0]}
          center
          zIndexRange={[40, 10]}
          style={{ pointerEvents: 'none' }}
        >
          {/* La ficha del documento, con la tinta del rail: este tooltip vive
              sobre la única superficie oscura del design system y usa SU
              familia de tintas, nunca la del lienzo claro. */}
          <div className="pointer-events-none whitespace-nowrap rounded-card border border-rail-border bg-rail-2 px-2.5 py-1.5 shadow-pop">
            <p className="max-w-[220px] truncate text-xs font-bold text-rail-ink">{node.title}</p>
            <p className="stat-num mt-0.5 text-micro text-rail-ink-muted">
              {num(node.chunkCount)}{' '}
              <span className="font-sans font-medium text-rail-ink-faint">fragmentos</span>
            </p>
          </div>
        </Html>
      )}
    </group>
  );
}

function Cluster({
  cluster,
  color,
  glow,
  animate,
  onOpen,
}: {
  cluster: PlacedCluster;
  color: THREE.Color;
  glow: THREE.Texture;
  animate: boolean;
  onOpen: (id: string) => void;
}) {
  const orbit = useRef<THREE.Group>(null);

  // La órbita: el grupo exterior gira sobre el núcleo y el cúmulo cuelga a
  // `orbitRadius` de distancia. Con movimiento reducido el ángulo se queda en
  // su fase sembrada — la composición estática ES el layout, no un fotograma
  // congelado a mitad de algo.
  useFrame(({ clock }) => {
    if (!orbit.current) return;
    const t = animate ? clock.elapsedTime : 0;
    orbit.current.rotation.y = cluster.phase + t * cluster.speed * cluster.direction;
  });

  // Documento → centro del espacio, en un solo lineSegments por cúmulo: dos
  // vértices por documento, un draw call, y el aditivo hace el resto.
  const lines = useMemo(() => {
    const positions = new Float32Array(cluster.docs.length * 6);
    cluster.docs.forEach((doc, i) => {
      positions.set([0, 0, 0, ...doc.position], i * 6);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }, [cluster.docs]);

  return (
    <group ref={orbit} rotation={[0, cluster.phase, 0]}>
      <group position={[cluster.orbitRadius, cluster.yOffset, 0]}>
        <sprite scale={[cluster.radius * 2.6, cluster.radius * 2.6, 1]}>
          <spriteMaterial
            map={glow}
            color={color}
            transparent
            opacity={0.28}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
        <lineSegments geometry={lines}>
          <lineBasicMaterial
            color={color}
            transparent
            opacity={0.3}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </lineSegments>
        {cluster.docs.map((doc) => (
          <DocNode key={doc.id} node={doc} color={color} onOpen={onOpen} />
        ))}
        {/* El nombre del espacio, como HTML de verdad: tipografía del producto
            y truncado honesto, no texto extruido en 3D. */}
        <Html
          position={[0, cluster.radius + 0.5, 0]}
          center
          zIndexRange={[20, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <span className="pointer-events-none max-w-[180px] truncate text-micro font-semibold text-rail-ink-muted">
            {cluster.name}
          </span>
        </Html>
      </group>
    </group>
  );
}

/* --------------------------------------------------------------------- todo */

export function ConstellationScene({
  clusters,
  reduced,
  onOpenDocument,
}: {
  clusters: PlacedCluster[];
  /** `prefers-reduced-motion`: sin órbitas ni auto-rotación; interacción sí. */
  reduced: boolean;
  onOpenDocument: (id: string) => void;
}) {
  const palette = usePalette();
  const [interacting, setInteracting] = useState(false);
  const resume = useRef<number | null>(null);

  // La textura del halo se crea una vez y se libera al desmontar; crearla por
  // sprite serían N canvases idénticos.
  const glow = useMemo(() => makeGlowTexture(), []);
  useEffect(() => () => glow.dispose(), [glow]);

  useEffect(
    () => () => {
      if (resume.current) window.clearTimeout(resume.current);
    },
    [],
  );

  const colorOf = (cluster: PlacedCluster): THREE.Color =>
    cluster.color
      ? new THREE.Color().set(cluster.color)
      : (palette[cluster.paletteIndex % palette.length] ?? new THREE.Color('#5850ec'));

  return (
    <Canvas
      // El presupuesto: dibujar solo cuando algo lo pide, y nunca por encima
      // de 1.5x de densidad de píxeles — en un retina 3x el 3D a DPR completo
      // cuadruplica el trabajo de la GPU para un detalle que nadie ve.
      frameloop="demand"
      dpr={[1, 1.5]}
      camera={{ position: [0, 7, 17], fov: 50 }}
      gl={{ antialias: true, alpha: true }}
    >
      <MotionTicker enabled={!reduced} />

      <ambientLight intensity={0.85} />
      <directionalLight position={[8, 12, 6]} intensity={1.1} />
      {/* La luz del núcleo: los cúmulos cercanos reciben un baño índigo. */}
      <pointLight position={[0, 0, 0]} intensity={40} color={palette[0]} />

      {palette[0] && <Nucleus color={palette[0]} glow={glow} />}

      {clusters.map((cluster) => (
        <Cluster
          key={cluster.id}
          cluster={cluster}
          color={colorOf(cluster)}
          glow={glow}
          animate={!reduced}
          onOpen={onOpenDocument}
        />
      ))}

      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={7}
        maxDistance={38}
        // El amortiguado necesita frames después de soltar; el ticker los da
        // cuando hay movimiento, y sin movimiento se apaga para que el control
        // responda 1:1 sin pedir frames que nadie va a dar.
        enableDamping={!reduced}
        dampingFactor={0.08}
        // La rotación automática se pausa mientras la mano está encima y
        // vuelve sola a los pocos segundos — la escena es de quien la toca.
        autoRotate={!reduced && !interacting}
        autoRotateSpeed={0.4}
        onStart={() => {
          if (resume.current) window.clearTimeout(resume.current);
          setInteracting(true);
        }}
        onEnd={() => {
          if (resume.current) window.clearTimeout(resume.current);
          resume.current = window.setTimeout(() => setInteracting(false), 4000);
        }}
      />
    </Canvas>
  );
}
