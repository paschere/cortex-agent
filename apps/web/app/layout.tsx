import './globals.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import { REPORT_CSS_HREF } from '@/lib/report-css';
import type { Metadata } from 'next';
import { JetBrains_Mono, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from './providers';

/**
 * Two faces, two jobs.
 *
 * Manrope is a modern geometric sans with slightly open, rounded terminals —
 * it reads as a product rather than as an administrative tool, which is the
 * whole point of the direction. It replaces Archivo, whose signage-grotesque
 * squareness pulled everything toward a form.
 *
 * JetBrains Mono carries the evidence: plates, waybill numbers, peso figures,
 * timestamps. Monospace here is legibility, not styling — a column that lines
 * up and a zero that cannot be misread as an O.
 */
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-sans',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Cortex',
  description: 'Your workspace AI co-pilot',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${manrope.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        {/*
          La hoja de los gráficos y los informes, enlazada una vez para toda la
          aplicación. Antes era un `<style>` de cuatro kilobytes dentro del
          layout del chat, que viajaba en cada carga útil de RSC y que sólo
          existía en una de las dos mitades — ver `app/report.css/route.ts`.
          React 19 iza el `<link>` al `<head>` gracias a `precedence`, y todas
          sus reglas están acotadas a `.rp-doc`.
        */}
        <link rel="stylesheet" href={REPORT_CSS_HREF} precedence="default" />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
