'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import './auth-experience.css';

export function AuthExperience({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [paused, setPaused] = useState(false);
  const signup = pathname === '/signup';
  if (pathname !== '/login' && !signup) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-8">
        <main className="w-full max-w-[25rem]">{children}</main>
      </div>
    );
  }
  return (
    <div className={`auth-experience${paused ? ' auth-experience-paused' : ''}`}>
      <header className="auth-experience-nav">
        <Link href="/" className="auth-experience-brand">
          <img src="/icon.png" alt="" width={32} height={32} />
          Cortex
        </Link>
        <Link href="/">
          Explorar Cortex <span aria-hidden="true">↗</span>
        </Link>
      </header>
      <div className="auth-experience-grid">
        <section className="auth-experience-story" aria-label="Bienvenido a Cortex">
          <p className="auth-experience-kicker">El conocimiento encuentra su siguiente paso.</p>
          <h2>
            {signup ? (
              <>
                Tu próxima etapa
                <br />
                comienza aquí.
              </>
            ) : (
              <>
                Bienvenido
                <br />a tu universo.
              </>
            )}
          </h2>
          <p className="auth-experience-intro">
            {signup
              ? 'Conecta lo que tu empresa sabe con lo que tu equipo necesita hacer.'
              : 'Tus fuentes, tus conversaciones y tus próximos pasos. Vuelve a conectar con tu operación.'}
          </p>
          <div className="auth-experience-universe" aria-hidden="true">
            {Array.from({ length: 42 }, (_, i) => i).map((i) => (
              <i
                className="auth-experience-star"
                key={`star-${i}`}
                style={{
                  left: `${(i * 37 + 9) % 100}%`,
                  top: `${(i * 61 + 4) % 100}%`,
                  opacity: 0.2 + (i % 5) * 0.15,
                  width: i % 7 === 0 ? 3 : 1.5,
                  height: i % 7 === 0 ? 3 : 1.5,
                }}
              />
            ))}
            <div className="auth-experience-disc">
              {Array.from({ length: 9 }, (_, i) => i).map((i) => (
                <span
                  key={`orbit-${i}`}
                  style={{ inset: `${i * 4}%`, animationDelay: `${i * -0.7}s` }}
                />
              ))}
            </div>
            <div className="auth-experience-core">
              <img src="/icon.png" alt="" width={56} height={56} />
            </div>
            <span className="auth-experience-orbit-label">Conocimiento</span>
            <span className="auth-experience-orbit-label">Contexto</span>
            <span className="auth-experience-orbit-label">Acción</span>
          </div>
          <div className="auth-experience-caption">
            <p>
              Una nueva forma de trabajar.
              <br />
              <strong>Con tu equipo al mando.</strong>
            </p>
            <button type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
              {paused ? 'Activar movimiento' : 'Pausar movimiento'}
            </button>
          </div>
        </section>
        <main className="auth-experience-form">{children}</main>
      </div>
      <footer className="auth-experience-footer">
        Cortex · Inteligencia conectada a tu operación.
      </footer>
    </div>
  );
}
