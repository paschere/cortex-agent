'use client';

import { useEffect } from 'react';

/**
 * REGISTRAR EL SERVICE WORKER, QUE ES LO QUE HACE QUE APAREZCA «INSTALAR».
 *
 * No dibuja nada. Existe porque el registro tiene que pasar en el navegador y
 * el layout raíz es un componente de servidor.
 *
 * ===========================================================================
 * DESPUÉS DE `load`, Y ESO NO ES CEREMONIA
 * ===========================================================================
 * Registrar un service worker durante el arranque compite por ancho de banda y
 * por hilo principal con lo único que le importa a quien acaba de abrir: que
 * salga la conversación. Esperar a `load` lo saca por completo del camino de la
 * primera pantalla, y el precio es que el botón de instalar aparece unas
 * décimas más tarde — que no lo nota nadie, porque nadie llega buscándolo.
 *
 * ===========================================================================
 * UN FALLO AQUÍ NO PUEDE COSTAR NADA
 * ===========================================================================
 * `navigator.serviceWorker` no existe en contextos no seguros y hay navegadores
 * donde el registro falla por política del propio navegador. Ninguna de esas
 * cosas tiene por qué salir en pantalla: lo único que se pierde es el botón de
 * instalar, y la aplicación funciona igual. Por eso se traga el error en vez de
 * avisarlo — es la única clase de fallo de este producto que de verdad no le
 * importa a nadie.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // Sin service worker no hay botón de instalar, y ya está.
      });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  return null;
}
