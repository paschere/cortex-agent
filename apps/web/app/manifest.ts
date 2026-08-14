import type { MetadataRoute } from 'next';

/**
 * CORTEX, INSTALABLE.
 *
 * ===========================================================================
 * QUÉ GANA, Y QUÉ NO
 * ===========================================================================
 * Gana dejar de parecer una pestaña: icono propio en el dock, ventana sin la
 * barra del navegador, y la puerta abierta a las notificaciones que llegan con
 * la aplicación cerrada.
 *
 * NO gana funcionar sin conexión, y eso es honesto y deliberado. Este producto
 * son 48 páginas dinámicas de servidor: sin red no hay nada que enseñar, así
 * que fingir lo contrario con una caché sería enseñar datos viejos de una
 * empresa —cifras de cartera, vencimientos— sin decir de cuándo son. Ver
 * `public/sw.js`, que lo argumenta con más detalle.
 *
 * ===========================================================================
 * `start_url` ES `/chat`, NO `/`
 * ===========================================================================
 * La raíz es la página de ventas. Quien se instaló la aplicación ya compró, y
 * abrirla para leer otra vez de qué va es la peor primera impresión posible.
 * `/chat` es la superficie principal del producto y quien no tenga sesión será
 * redirigido a entrar, que es exactamente lo que tiene que pasar.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cortex — un gerente para tu empresa',
    short_name: 'Cortex',
    description:
      'Lee tus correos, tus contratos y tus reuniones, persigue lo que se prometió y te dice de dónde salió cada dato.',
    start_url: '/chat',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    lang: 'es-CO',
    dir: 'ltr',
    // Los dos del sistema de diseño: `--canvas` como fondo de arranque y el
    // índigo de marca en la barra. Nada inventado aquí.
    background_color: '#f7f7fb',
    theme_color: '#5850ec',
    categories: ['business', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      // Android recorta los iconos a la forma del sistema. El `maskable` lleva
      // su propio margen para que no le corte las orejas al cerebro.
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    /**
     * Los accesos del menú contextual del icono, y son tres porque son tres las
     * cosas que alguien quiere hacer sin abrir nada primero.
     *
     * `/chat?nueva=1` no existe como ruta aparte: es la misma pantalla, y el
     * parámetro sólo dice que no continúe el último hilo.
     */
    shortcuts: [
      { name: 'Preguntar algo', url: '/chat', description: 'Abrir una conversación nueva' },
      { name: 'Lo que te espera', url: '/approvals', description: 'Aprobaciones pendientes' },
      { name: 'Vencimientos', url: '/commitments', description: 'Lo que se vence pronto' },
    ],
  };
}
