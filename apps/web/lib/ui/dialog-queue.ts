/**
 * COLA DE DIÁLOGOS (sustituye a window.confirm / window.prompt).
 *
 * `confirmDialog` y `promptDialog` devuelven una promesa y no saben nada de
 * React: ponen la pregunta en una cola y `DialogHost` (montado una vez en
 * `Providers`) la pinta. Si el anfitrión no está montado (pruebas, SSR) no
 * se queda colgada: responde «no» / «cancelado».
 */

export interface ConfirmRequest {
  kind: 'confirm';
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel: string;
  /** `danger` pinta el botón principal en rosa: algo que no se deshace. */
  tone: 'default' | 'danger';
  resolve(value: boolean): void;
}

export interface PromptRequest {
  kind: 'prompt';
  title: string;
  message?: string;
  label: string;
  placeholder?: string;
  initial: string;
  maxLength: number;
  confirmLabel: string;
  cancelLabel: string;
  resolve(value: string | null): void;
}

export type DialogRequest = ConfirmRequest | PromptRequest;

type Listener = (queue: DialogRequest[]) => void;

let queue: DialogRequest[] = [];
const listeners = new Set<Listener>();

function emit() {
  for (const l of listeners) l(queue);
}

export function subscribeDialogs(listener: Listener): () => void {
  listeners.add(listener);
  listener(queue);
  return () => {
    listeners.delete(listener);
  };
}

function push<T extends DialogRequest>(req: T): Promise<void> {
  if (listeners.size === 0) {
    // Sin anfitrión no hay a quién preguntar: se cancela en vez de colgarse.
    if (req.kind === 'confirm') req.resolve(false);
    else req.resolve(null);
    return Promise.resolve();
  }
  queue = [...queue, req];
  emit();
  return Promise.resolve();
}

export function settleDialog(req: DialogRequest) {
  queue = queue.filter((r) => r !== req);
  emit();
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'default' | 'danger';
}

/** «¿Seguro?»: true si la persona confirma, false si cancela, cierra o pulsa Escape. */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const o: ConfirmOptions = typeof options === 'string' ? { title: options } : options;
  return new Promise<boolean>((resolve) => {
    void push({
      kind: 'confirm',
      title: o.title,
      message: o.message,
      confirmLabel: o.confirmLabel ?? 'Confirmar',
      cancelLabel: o.cancelLabel ?? 'Cancelar',
      tone: o.tone ?? 'default',
      resolve,
    });
  });
}

export interface PromptOptions {
  title: string;
  message?: string;
  label: string;
  placeholder?: string;
  initial?: string;
  maxLength?: number;
  confirmLabel?: string;
  cancelLabel?: string;
}

/** Pide un texto: el texto (puede ser vacío) o `null` si se cancela. */
export function promptDialog(o: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    void push({
      kind: 'prompt',
      title: o.title,
      message: o.message,
      label: o.label,
      placeholder: o.placeholder,
      initial: o.initial ?? '',
      maxLength: o.maxLength ?? 300,
      confirmLabel: o.confirmLabel ?? 'Aceptar',
      cancelLabel: o.cancelLabel ?? 'Cancelar',
      resolve,
    });
  });
}
