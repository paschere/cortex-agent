import './globals.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Archivo, IBM_Plex_Mono } from 'next/font/google';
import { Providers } from './providers';

/**
 * Two faces, two jobs.
 *
 * Archivo is a grotesque drawn for signage and forms — institutional without
 * being bureaucratic, and it holds up at the small sizes a dense operations
 * tool lives at. It replaces Plus Jakarta, whose rounded warmth belonged to a
 * consumer product.
 *
 * IBM Plex Mono carries every piece of evidence: plates, waybill numbers, peso
 * figures, timestamps. Monospace here is not a style — it is what makes a
 * column of figures scannable and stops a plate from being misread.
 */
const archivo = Archivo({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-sans',
  display: 'swap',
});

const plexMono = IBM_Plex_Mono({
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
    <html lang="en" className={`${archivo.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-canvas font-sans text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
