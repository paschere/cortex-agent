'use client';

import { CortexSignature } from '@/components/ui/cortex-signature';
import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

import { useLandingScroll } from './ScrollExperience';

const SpaceScene = dynamic(() => import('./SpaceScene'), { ssr: false });

export function SpaceHero() {
  const journey = useLandingScroll();
  const host = useRef<HTMLDivElement>(null);
  const [enabled, setEnabled] = useState(false);
  const [active, setActive] = useState(false);
  const [paused, setPaused] = useState(false);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const small = matchMedia('(max-width: 700px)');
    const update = () => {
      setEnabled(!motion.matches);
      setCompact(small.matches);
    };
    update();
    motion.addEventListener('change', update);
    small.addEventListener('change', update);
    let visible = false;
    const visibility = () => setActive(visible && !document.hidden);
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? false;
      visibility();
    });
    if (host.current) observer.observe(host.current);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', visibility);
      motion.removeEventListener('change', update);
      small.removeEventListener('change', update);
    };
  }, []);
  return (
    <div ref={host} className="space-art" data-paused={paused || !active}>
      <div className="space-art__fallback" aria-hidden="true">
        <i />
        <i />
        <i />
      </div>
      <div className="space-art__canvas" aria-hidden="true">
        {enabled && (
          <SpaceScene active={active && !paused} compact={compact} journey={journey?.progress} />
        )}
      </div>
      <div className="space-art__core" aria-hidden="true">
        <CortexSignature />
      </div>
      <span className="space-art__caption">El contexto de tu empresa, conectado.</span>
      {enabled && (
        <button
          className="space-motion"
          type="button"
          aria-pressed={paused}
          onClick={() => setPaused(!paused)}
        >
          {paused ? 'Reanudar movimiento' : 'Pausar movimiento'}
        </button>
      )}
    </div>
  );
}
