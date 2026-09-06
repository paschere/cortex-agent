'use client';

import { CortexSignature } from '@/components/ui/cortex-signature';
import dynamic from 'next/dynamic';
import { Component, type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { useLandingScroll } from './ScrollExperience';

const ConnectionScene = dynamic(() => import('./ConnectionScene'), { ssr: false });

class SceneBoundary extends Component<
  { children: ReactNode; onFailure: () => void },
  { failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch() {
    this.props.onFailure();
  }
  override render() {
    return this.state.failed ? null : this.props.children;
  }
}

export function ConnectionStory() {
  const journey = useLandingScroll();
  const root = useRef<HTMLElement>(null);
  const progress = useRef(0);
  const track = useRef<HTMLDivElement>(null);
  const phaseRef = useRef(0);
  const stage = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [visible, setVisible] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState(0);
  const onReady = useCallback(() => setReady(true), []);
  const onFailure = useCallback(() => {
    setEnabled(false);
    setReady(false);
  }, []);

  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let supported = false;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      supported = Boolean(gl);
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* Static illustration remains visible. */
    }
    const update = () => setEnabled(supported && !motion.matches);
    update();
    motion.addEventListener('change', update);
    let inView = false;
    const visibility = () => setVisible(inView && !document.hidden);
    const observer = new IntersectionObserver(
      ([entry]) => {
        inView = entry?.isIntersecting ?? false;
        if (inView) setLoaded(true);
        visibility();
      },
      { threshold: 0.15 },
    );
    if (stage.current) observer.observe(stage.current);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      motion.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);

  const running = enabled && ready && visible;
  useEffect(() => {
    if (!enabled) return;
    if (!journey) return;
    return journey.subscribe(() => {
      if (!stage.current) return;
      const p = journey.progress.current.connection;
      progress.current = p;
      stage.current.dataset.progress = p.toFixed(3);
      stage.current.style.setProperty('--story-progress', String(p));
      const nextPhase = p < 0.3 ? 0 : p < 0.8 ? 1 : 2;
      if (nextPhase !== phaseRef.current) {
        phaseRef.current = nextPhase;
        setPhase(nextPhase);
      }
      const shock = Math.max(0, Math.min(1, (p - 0.3) / 0.13));
      stage.current.style.setProperty('--contact-light', String(Math.sin(shock * Math.PI) * 0.12));
    });
  }, [enabled, journey]);

  function restart() {
    track.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <section
      ref={root}
      className="connection-story cosmos-wrap"
      data-scroll={enabled}
      aria-labelledby="connection-title"
    >
      <div className="connection-story__heading">
        <p className="connection-story__eyebrow">El origen de una nueva forma de dirigir</p>
        <h2 id="connection-title">
          Tu experiencia.
          <br />
          <span>Su inteligencia. Una conexión.</span>
        </h2>
        <p>
          Todo empieza contigo. Cortex conecta lo que sabes con lo que tu empresa puede llegar a
          hacer.
        </p>
      </div>
      <div ref={track} className="connection-story__track">
        <div
          ref={stage}
          className="connection-story__stage"
          data-ready={enabled && ready}
          data-paused={!running}
          data-phase={phase}
        >
          <div className="connection-story__static" aria-hidden="true">
            <CortexSignature />
          </div>
          <div className="connection-story__scene" aria-hidden="true">
            {enabled && loaded && (
              <SceneBoundary onFailure={onFailure}>
                <ConnectionScene paused={!visible} progressRef={progress} onReady={onReady} />
              </SceneBoundary>
            )}
          </div>
          <div className="connection-story__wordmark" aria-hidden="true">
            Cortex<span>Tu experiencia, amplificada.</span>
          </div>
          <div className="connection-story__glow" aria-hidden="true" />
          <div className="connection-story__topline" aria-hidden="true">
            <span>CORTEX / CONEXIÓN</span>
            <span>HUMANO + INTELIGENCIA</span>
          </div>
          <div className="connection-story__bottom">
            <p>
              {!enabled
                ? 'Tu experiencia y Cortex, conectados.'
                : phase === 0
                  ? 'Todo empieza con una persona.'
                  : phase === 1
                    ? 'Una conexión lo cambia todo.'
                    : 'De esa conexión, nace Cortex.'}
            </p>
            {enabled && ready && (
              <div className="connection-story__controls">
                {phase === 2 ? (
                  <button type="button" onClick={restart}>
                    Volver al inicio
                  </button>
                ) : (
                  <span className="connection-story__scroll-hint">
                    Desliza para {phase === 0 ? 'conectar' : 'continuar'} ↓
                  </span>
                )}
                <a href="#experiencia">Saltar escena</a>
              </div>
            )}
          </div>
          {enabled && (
            <div className="connection-story__progress" aria-hidden="true">
              <span />
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
