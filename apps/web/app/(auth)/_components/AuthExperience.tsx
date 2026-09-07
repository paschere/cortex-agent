'use client';

import { SpaceHero } from '@/app/_landing/SpaceHero';
import { CortexSignature } from '@/components/ui/cortex-signature';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import './auth-experience.css';

export function AuthExperience({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const signup = pathname === '/signup';
  if (pathname !== '/login' && !signup) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4 py-8">
        <main className="w-full max-w-[25rem]">{children}</main>
      </div>
    );
  }
  return (
    <div className="auth-experience">
      <header className="auth-experience-nav">
        <Link href="/" className="auth-experience-brand">
          <CortexSignature />
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
          <div className="auth-shared-space">
            <SpaceHero />
          </div>
          <div className="auth-experience-caption">
            <p>
              Una nueva forma de trabajar.
              <br />
              <strong>Con tu equipo al mando.</strong>
            </p>
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
