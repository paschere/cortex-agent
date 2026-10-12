import { clearEverything, loadOps, loadQueue } from '@/lib/views/offline-store';

/**
 * CERRAR SESIÓN: lo guardado en el teléfono se va con la sesión.
 *
 * Es un módulo chico a propósito (lo importa la barra lateral, que está en todas
 * las pantallas): el buzón de salida de las apps (lib/apps/app-outbox.ts, que
 * arrastra la subida de archivos y las acciones del servidor) se registra aquí
 * cuando una app lo abre, y sólo entonces hay algo que enviar antes de borrar.
 */

interface BoxHandle {
  drain: () => Promise<void>;
  stop: () => void;
}

const boxes = new Map<string, BoxHandle>();

export function registerBox(appKey: string, box: BoxHandle): void {
  boxes.set(appKey, box);
}

export function unregisterBox(appKey: string): void {
  boxes.delete(appKey);
}

/** Cuántas cosas sin enviar hay en este teléfono (formularios y operaciones). */
export async function pendingOnDevice(): Promise<number> {
  try {
    const [ops, forms] = await Promise.all([loadOps(), loadQueue()]);
    return ops.filter((o) => !o.rejected).length + forms.filter((f) => !f.rejected).length;
  } catch {
    return 0;
  }
}

/**
 * Borra TODO lo de esta persona en el teléfono (cola, fotos pendientes, copias de
 * pantallas, cachés de las apps). Antes intenta enviar lo pendiente (si hay señal,
 * máx. 5 s); si aún quedan cosas y `ask`, pregunta; devuelve false si la persona
 * se arrepiente. Un navegador que no deja borrar nunca impide salir.
 */
export async function clearCaptureData(opts: { ask?: boolean } = {}): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.onLine !== false && boxes.size)
      await Promise.race([
        Promise.all([...boxes.values()].map((box) => box.drain().catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    if (opts.ask) {
      const n = await pendingOnDevice();
      if (
        n > 0 &&
        !window.confirm(
          `Tienes ${n} ${n === 1 ? 'cosa' : 'cosas'} sin enviar en este teléfono. Si cierras sesión ahora se pierden. ¿Cerrar sesión de todos modos?`,
        )
      )
        return false;
    }
    for (const box of boxes.values()) box.stop();
    boxes.clear();
    await clearEverything();
    if (typeof caches !== 'undefined') {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith('cortex-app-')).map((n) => caches.delete(n)),
      );
    }
  } catch {
    // Borrar es lo mejor que se puede hacer.
  }
  return true;
}
