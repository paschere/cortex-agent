'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { BlockFixActions } from './blocks/BlockFix';

/**
 * UN BLOQUE QUE FALLA NO TUMBA LA PANTALLA.
 *
 * Cada bloque de una vista (tabla, gráfico, formulario, mapa…) se pinta dentro
 * de este límite: si su pintado lanza, queda una tarjeta tranquila «No se pudo
 * cargar este bloque · Reintentar» en su lugar y el resto de la pantalla sigue
 * viva. El detalle técnico va a la consola, no a la cara de quien trabaja.
 * Si llegan datos nuevos (`resetKey` cambia), se vuelve a intentar solo.
 */
interface Props {
  children: ReactNode;
  /** Cambia cuando el bloque trae datos nuevos: el límite se rearma. */
  resetKey?: unknown;
  /** Nombre del bloque, para el lector de pantalla y el registro. */
  name?: string;
  /** Id del bloque, para «Arreglar con Cortex» / «Avisar al administrador». */
  blockId?: string;
}

interface State {
  failed: boolean;
  /** El mensaje técnico, sólo para el contexto que se le da a Cortex (no se muestra). */
  detail?: string;
}

export class BlockBoundary extends Component<Props, State> {
  override state: State = { failed: false };
  private lastKey: unknown;

  static getDerivedStateFromError(error: unknown): State {
    return { failed: true, detail: error instanceof Error ? error.message.slice(0, 300) : undefined };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[views] bloque con error:', this.props.name ?? '', error.message, info.componentStack?.split('\n')[1]?.trim());
  }

  override componentDidUpdate() {
    if (this.state.failed && this.props.resetKey !== this.lastKey) {
      this.lastKey = this.props.resetKey;
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) {
      this.lastKey = this.props.resetKey;
      return this.props.children;
    }
    return (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-card border border-amber/30 bg-amber-soft/50 px-4 py-3"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-amber-soft text-amber">
          <AlertTriangle className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-ink">
            No se pudo cargar este bloque
            {this.props.name ? <span className="font-normal text-ink-muted"> · {this.props.name}</span> : null}
          </p>
          <BlockFixActions
            className="mt-2"
            blockId={this.props.blockId}
            blockTitle={this.props.name}
            message={`No se pudo cargar este bloque${this.state.detail ? ` (${this.state.detail})` : ''}`}
          />
        </div>
        <button
          type="button"
          onClick={() => this.setState({ failed: false })}
          className="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 text-xs font-semibold text-ink hover:bg-surface-2"
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden /> Reintentar
        </button>
      </div>
    );
  }
}
