'use client';

import { Bell } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

/**
 * LA CAMPANA, CON UN NÚMERO QUE ES VERDAD.
 *
 * ===========================================================================
 * LO QUE HABÍA
 * ===========================================================================
 * Un `<button>` sin `onClick` con el punto de «no leído» pintado en todas las
 * cargas: decía que había algo nuevo en cada visita a cada pantalla y no hacía
 * nada al pulsarlo. Las dos mitades eran mentira, y una luz de aviso que siempre
 * está encendida es la manera más rápida de enseñarle a alguien a no mirarla.
 * Después fue un enlace honesto a /approvals, que era lo más cercano a verdad
 * que existía porque el producto no tenía avisos.
 *
 * ===========================================================================
 * POR QUÉ SE CUENTA DESDE EL NAVEGADOR Y NO EN EL LAYOUT
 * ===========================================================================
 * Porque el layout se renderiza una vez por navegación y una campana que sólo
 * se entera al cambiar de pantalla no sirve para lo que sirve una campana: un
 * trámite que termina a los tres minutos de haberlo lanzado tiene que aparecer
 * sin que nadie navegue.
 *
 * Y porque así este componente es AUTOSUFICIENTE: se suelta en la barra
 * superior sin tocar el layout ni pasarle props, que es lo que permite que la
 * barra de navegación siga siendo de una sola persona.
 *
 * `initialUnread` está para el día en que sí se quiera pintar el primer número
 * desde el servidor; sin él, la campana empieza apagada y se enciende en cuanto
 * contesta la primera petición, que es el orden correcto — un badge que
 * parpadea con un número equivocado es peor que uno que llega medio segundo
 * tarde.
 *
 * ===========================================================================
 * SE RECUENTA CUANDO PASA ALGO, NO CADA SEGUNDO
 * ===========================================================================
 * Al montar, al volver a la pestaña, y al cambiar de pantalla. Nada de sondeo
 * en bucle: el coste de un aviso que tarda hasta que alguien vuelva a mirar la
 * ventana es cero, y el de una petición por segundo por persona conectada, no.
 */

const COUNT_URL = '/api/notifications/count';

export function NotificationBell({ initialUnread = 0 }: { initialUnread?: number }) {
  const [unread, setUnread] = useState(initialUnread);
  const pathname = usePathname();

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(COUNT_URL, { cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as { unread?: number };
      // El servidor ya devuelve 0 cuando la base no quiere contestar (ver
      // countUnread). Aquí sólo se descarta lo que no es un número, para que
      // una respuesta rara no pinte «NaN» encima de la navegación.
      if (typeof body.unread === 'number' && Number.isFinite(body.unread)) {
        setUnread(Math.max(0, Math.trunc(body.unread)));
      }
    } catch {
      // Sin red, el número se queda como estaba. Un badge no vale un error.
    }
  }, []);

  /*
   * `pathname` no se LEE dentro del efecto: se usa COMO efecto. Estar en la
   * lista de dependencias es lo que hace que cambiar de pantalla vuelva a
   * contar, y la regla —que mira qué se lee en el cuerpo— lo da por sobrante.
   * Quitarlo dejaría la campana congelada en el número de la primera carga
   * hasta que alguien cambiara de ventana.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: ver la nota de arriba
  useEffect(() => {
    void refresh();
  }, [refresh, pathname]);

  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  const label = unread > 0 ? `Avisos, ${unread} sin leer` : 'Avisos';

  return (
    <Link
      href="/notifications"
      aria-label={label}
      className="relative rounded-full p-2 text-ink-muted transition-colors duration-150 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
    >
      <Bell className="h-[18px] w-[18px]" />
      {unread > 0 && (
        // Anillado en la superficie de la barra para que conserve su borde
        // cuando el botón se rellena al pasar por encima.
        <span className="tabular-nums absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-primary px-1 text-center text-micro font-bold leading-4 text-white ring-2 ring-surface">
          {unread > 9 ? '9+' : unread}
        </span>
      )}
    </Link>
  );
}
