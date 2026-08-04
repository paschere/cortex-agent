import './globals.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { JetBrains_Mono, Manrope } from 'next/font/google';
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
