import './globals.css';
import 'highlight.js/styles/github-dark-dimmed.css';
import { REPORT_CSS_HREF } from '@/lib/report-css';
import type { Metadata, Viewport } from 'next';
import { JetBrains_Mono, Manrope } from 'next/font/google';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { ServiceWorker } from './service-worker';

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

/**
 * LOS DATOS DE LA APLICACIÓN INSTALADA, Y UNA CORRECCIÓN VIEJA.
 *
 * La descripción decía «Your workspace AI co-pilot» — en inglés, y describiendo
 * un copiloto. Este producto se vende como un gerente, no como un asistente, y
 * quien lo lee es una empresa colombiana. Es lo primero que ve alguien en una
 * pestaña, en un resultado de búsqueda y ahora también bajo el icono instalado.
 *
 * `appleWebApp` existe porque iOS NO LEE EL MANIFIESTO. Sin estas tres líneas,
 * «Añadir a pantalla de inicio» en un iPhone produce un marcador que abre
 * Safari con su barra, en vez de una aplicación. Y `black-translucent` hace que
 * el contenido pase por debajo de la barra de estado, que es lo que hace que se
 * vea como una aplicación y no como una página a la que le sobra un borde.
 */
export const metadata: Metadata = {
  title: { default: 'Cortex', template: '%s · Cortex' },
  description:
    'Un gerente para tu empresa: lee tus correos, tus contratos y tus reuniones, persigue lo que se prometió y te dice de dónde salió cada dato.',
  applicationName: 'Cortex',
  appleWebApp: { capable: true, title: 'Cortex', statusBarStyle: 'black-translucent' },
  icons: {
    icon: [
      { url: '/icon.svg', type: 'image/svg+xml' },
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: '/apple-touch-icon.png',
  },
  formatDetection: { telephone: false },
};

/**
 * El color de la barra del sistema cuando está instalada, y el aire de seguridad
 * en un teléfono con muesca — sin `viewport-fit: cover`, `black-translucent`
 * deja una franja en blanco donde debería estar el contenido.
 */
export const viewport: Viewport = {
  themeColor: '#5850ec',
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `es-CO` y no `en`. Todo el producto está en español de Colombia, y con el
    // documento declarado en inglés un lector de pantalla lo lee entero con voz
    // inglesa: «vencimientos» pronunciado como si fuera una palabra inglesa no
    // se entiende. Era un fallo de accesibilidad, no un detalle.
    <html lang="es-CO" className={`${manrope.variable} ${jetbrainsMono.variable}`}>
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
        <ServiceWorker />
      </body>
    </html>
  );
}
