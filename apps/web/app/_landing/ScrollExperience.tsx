'use client';

import { type ReactNode, createContext, useContext, useEffect, useMemo, useRef } from 'react';

import { StarField } from './StarField';

type Journey = { page: number; hero: number; connection: number };
const ScrollContext = createContext<{
  progress: { current: Journey };
  subscribe: (callback: () => void) => () => void;
} | null>(null);
export const useLandingScroll = () => useContext(ScrollContext);
const clamp = (value: number) => Math.min(1, Math.max(0, value));

/** One native-scroll clock for the whole landing, shared with both WebGL scenes. */
export function ScrollExperience({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const progress = useRef<Journey>({ page: 0, hero: 0, connection: 0 });
  const listeners = useRef(new Set<() => void>());
  const context = useMemo(
    () => ({
      progress,
      subscribe(callback: () => void) {
        listeners.current.add(callback);
        callback();
        return () => {
          listeners.current.delete(callback);
        };
      },
    }),
    [],
  );
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const sections = Array.from(element.querySelectorAll<HTMLElement>('main > section'));
    const apply = () => {
      frame = 0;
      const height = window.innerHeight;
      const page = clamp(
        window.scrollY / Math.max(1, document.documentElement.scrollHeight - height),
      );
      const heroElement = element.querySelector<HTMLElement>('.cosmos-hero');
      const hero = heroElement
        ? clamp(-heroElement.getBoundingClientRect().top / Math.max(1, heroElement.offsetHeight))
        : 0;
      const track = element.querySelector<HTMLElement>('.connection-story__track');
      const stage = element.querySelector<HTMLElement>('.connection-story__stage');
      const connection =
        track && stage
          ? clamp(
              ((Number.parseFloat(getComputedStyle(stage).top) || 0) -
                track.getBoundingClientRect().top) /
                Math.max(1, track.offsetHeight - stage.offsetHeight),
            )
          : 0;
      progress.current = { page, hero, connection };
      element.dataset.journey = motion.matches ? 'static' : 'scroll';
      element.style.setProperty('--journey-progress', String(page));
      element.style.setProperty('--journey-orbit', `${page * 150}deg`);
      element.style.setProperty('--journey-travel', `${page * -260}px`);
      element.style.setProperty('--hero-travel', `${hero * -70}px`);
      element.style.setProperty('--hero-scale', String(1 + hero * 0.28));
      for (const section of sections) {
        const bounds = section.getBoundingClientRect();
        const enter = clamp((height - bounds.top) / (height * 0.7));
        section.style.setProperty('--chapter-rise', `${(1 - enter) * 64}px`);
        section.style.setProperty('--chapter-opacity', String(0.45 + enter * 0.55));
      }
      for (const callback of listeners.current) callback();
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    motion.addEventListener('change', schedule);
    apply();
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      motion.removeEventListener('change', schedule);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <ScrollContext.Provider value={context}>
      <div ref={root} className="cosmos">
        <div className="journey-space" aria-hidden="true">
          <StarField />
          <div className="journey-space__orbit" />
        </div>
        <div className="journey-progress" aria-hidden="true">
          <span />
        </div>
        {children}
      </div>
    </ScrollContext.Provider>
  );
}
