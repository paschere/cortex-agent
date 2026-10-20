/**
 * EL ESTADO HONESTO DE LA CONEXIÓN, PURO.
 *
 * `navigator.onLine` sólo sabe si hay una red enlazada, no si Cortex contesta
 * (un wifi sin salida, una zona de sombra de la bodega). Por eso el estado no es
 * un booleano: es una máquina chica que se alimenta de tres cosas — los eventos
 * `online`/`offline` del navegador, el resultado de pedirle algo al servidor, y
 * la cola de envíos — y le dice a la persona la verdad en pocas palabras:
 *
 *   online        todo sale; no se dice nada de más.
 *   offline       no hay señal: lo que se registre se guarda en el teléfono.
 *   reconnecting  volvió la red (o un pedido falló con red): se comprueba, y la
 *                 cola se envía en cuanto el servidor conteste.
 *
 * Sin DOM ni reloj: lo prueba connection-state.test.ts.
 */

export type ConnectionState = 'online' | 'offline' | 'reconnecting';

export type ConnectionEvent =
  /** El navegador dice que hay red (`online`) o que no (`offline`). */
  | { type: 'browser'; online: boolean }
  /** Un pedido al servidor terminó: contestó o no pudo ni llegar. */
  | { type: 'probe'; ok: boolean }
  /** Un envío o una lectura falló por red aunque el navegador crea que hay. */
  | { type: 'network-failure' };

export function nextConnection(state: ConnectionState, event: ConnectionEvent): ConnectionState {
  switch (event.type) {
    case 'browser':
      if (!event.online) return 'offline';
      // Volvió la red: no se canta victoria hasta que el servidor conteste.
      return state === 'offline' ? 'reconnecting' : state;
    case 'probe':
      if (event.ok) return 'online';
      return state === 'online' ? 'reconnecting' : state === 'reconnecting' ? 'offline' : 'offline';
    case 'network-failure':
      return state === 'offline' ? 'offline' : 'reconnecting';
  }
}

export interface ConnectionLabel {
  /** Texto corto de la píldora. */
  text: string;
  /** Una línea más larga para quien toca la píldora o la lee con lector de pantalla. */
  detail: string;
  tone: 'ok' | 'warn' | 'busy';
  /** ¿Vale la pena mostrarla siempre? En línea y sin nada pendiente es sólo un puntico. */
  prominent: boolean;
}

/** Lo que se le dice a la persona, en español, según el estado y la cola. */
export function connectionLabel(
  state: ConnectionState,
  pending: number,
  syncing = false,
): ConnectionLabel {
  const por = pending === 1 ? '1 registro por enviar' : `${pending} registros por enviar`;
  if (state === 'offline')
    return {
      text: pending ? `Sin conexión · ${por}` : 'Sin conexión',
      detail: pending
        ? 'No hay señal. Lo registrado está guardado en el teléfono y sale solo al volver.'
        : 'No hay señal. Lo que registres se guarda en el teléfono y sale solo al volver.',
      tone: 'warn',
      prominent: true,
    };
  if (state === 'reconnecting')
    return {
      text: pending ? `Reconectando · ${por}` : 'Reconectando…',
      detail: 'Comprobando la conexión con Cortex. En cuanto conteste, se envía lo pendiente.',
      tone: 'busy',
      prominent: true,
    };
  if (syncing && pending)
    return {
      text: pending === 1 ? 'Enviando 1 registro…' : `Enviando ${pending} registros…`,
      detail: 'Hay conexión: se está enviando lo que estaba guardado en el teléfono.',
      tone: 'busy',
      prominent: true,
    };
  if (pending)
    return {
      text: por.charAt(0).toUpperCase() + por.slice(1),
      detail: 'Hay conexión; estos registros salen en unos segundos o con «Reintentar ahora».',
      tone: 'warn',
      prominent: true,
    };
  return {
    text: 'En línea',
    detail: 'Todo lo que registres se envía al instante.',
    tone: 'ok',
    prominent: false,
  };
}

/** Espera antes de volver a comprobar, con tope: 4 s, 8 s, 16 s… hasta 60 s. */
export function probeDelayMs(failures: number): number {
  return Math.min(60_000, 4_000 * 2 ** Math.max(0, failures));
}

/** Espera extra del sondeo en vivo tras fallos seguidos del servidor: 0, 10 s, 20 s, 40 s… hasta 2 min. */
export function pollBackoffMs(failures: number): number {
  return failures <= 1 ? 0 : Math.min(120_000, 10_000 * 2 ** (failures - 2));
}
