import '../_landing/landing.css';
import './legal.css';
import { CortexSignature } from '@/components/ui/cortex-signature';
import { legalEntity } from '@/lib/legal/config';
import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Las páginas legales públicas (/privacidad, /terminos, /cookies,
 * /tratamiento-de-datos), con la identidad de la landing: mismo fondo, misma
 * marca, mismo pie. Sin sesión: están en PUBLIC_PATHS del middleware, porque la
 * casilla del registro las enlaza y se leen antes de tener cuenta.
 *
 * La franja «Versión preliminar» se ve mientras LEGAL_DRAFT no sea «false» —
 * es decir, hasta que un abogado revise los textos y el dueño lo apague.
 */
export const dynamic = 'force-dynamic';

export default function LegalLayout({ children }: { children: ReactNode }) {
  const entity = legalEntity();
  return (
    <div className="cosmos legal">
      <a className="cosmos-skip" href="#contenido">
        Ir al contenido
      </a>
      {entity.draft && (
        <div className="legal-draft" role="note">
          <strong>Versión preliminar.</strong> Estos textos están en revisión jurídica y pueden
          cambiar.
          {entity.missing.length > 0 && <> Faltan por completar: {entity.missing.join(', ')}.</>}
        </div>
      )}
      <header className="cosmos-header cosmos-wrap">
        <Link href="/" className="cosmos-brand" aria-label="Cortex, inicio">
          <CortexSignature />
          <span>Cortex</span>
        </Link>
        <nav aria-label="Documentos legales" className="cosmos-nav legal-nav">
          <Link href="/privacidad">Privacidad</Link>
          <Link href="/tratamiento-de-datos">Tratamiento de datos</Link>
          <Link href="/terminos">Términos</Link>
          <Link href="/cookies">Cookies</Link>
        </nav>
        <Link className="cosmos-login" href="/login">
          Iniciar sesión
        </Link>
      </header>
      <main id="contenido" className="cosmos-wrap legal-main">
        {children}
      </main>
      <footer className="cosmos-footer cosmos-wrap">
        <Link href="/" className="cosmos-brand">
          <CortexSignature />
          <span>Cortex</span>
        </Link>
        <nav aria-label="Enlaces del pie de página" className="cosmos-footer__links">
          <Link href="/privacidad">Privacidad</Link>
          <Link href="/tratamiento-de-datos">Tratamiento de datos</Link>
          <Link href="/terminos">Términos</Link>
          <Link href="/cookies">Cookies</Link>
          <Link href="/signup">Crear mi espacio</Link>
        </nav>
        <p>
          {entity.razonSocial} · NIT {entity.nit}
        </p>
      </footer>
    </div>
  );
}
