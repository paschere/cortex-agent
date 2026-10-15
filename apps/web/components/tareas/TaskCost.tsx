'use client';

import { useEffect, useState } from 'react';

/**
 * «Costo» de una tarea (0228): lo que gastó el modelo en sus tandas, en pesos y
 * tokens. Mientras la tarea sigue viva se relee con ella. Sin consumo registrado
 * (tareas anteriores) muestra sólo los tokens que la tarea guardaba.
 */
export function TaskCost({
  taskId,
  live,
  fixtureLine,
}: {
  taskId: string;
  live: boolean;
  /** Pantallas de muestra: una cifra fija y nada de consultas. */
  fixtureLine?: string;
}) {
  const [line, setLine] = useState<string | null>(fixtureLine ?? null);
  useEffect(() => {
    if (fixtureLine) return;
    let alive = true;
    const load = async () => {
      try {
        const r = await fetch(`/api/tasks/${taskId}/cost`, { cache: 'no-store' });
        if (!r.ok) return;
        const body = (await r.json()) as {
          cost: { line: string } | null;
          tokens?: number;
        };
        if (!alive) return;
        if (body.cost) setLine(body.cost.line);
        else if (body.tokens) setLine(`${Math.round(body.tokens).toLocaleString('es-CO')} tokens`);
      } catch {
        // La próxima lo repone.
      }
    };
    void load();
    if (!live)
      return () => {
        alive = false;
      };
    const t = setInterval(() => void load(), 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [taskId, live, fixtureLine]);
  if (!line) return null;
  return (
    <p className="tabular mt-3 text-xs text-ink-faint" title="Estimado con el precio del modelo">
      Costo: <span className="font-mono text-ink-muted">{line}</span>
    </p>
  );
}
