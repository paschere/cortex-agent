'use client';

import { Button } from '@/components/ui/button';
import { clsx } from 'clsx';
import { LayoutGrid, Loader2, ShieldOff } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { runRecipeAction } from '../actions';

/**
 * Los informes a la medida que ya se armaron, listos para volver a correr.
 *
 * ===========================================================================
 * POR QUÉ AQUÍ NO HAY UN ARMADOR
 * ===========================================================================
 * La tentación era una cuarta tarjeta con un selector de bloques y un botón de
 * «armar». Se descartó por una medida y no por gusto: armar un informe es
 * escoger de seis bloques con sus parámetros, ponerle nombre, título y periodo
 * — un formulario de cinco campos que hay que rellenar bien la primera vez para
 * que sirva la décima. Eso en el chat es una frase («júntame lo que se vence y
 * el estado de la flota en un papel para la junta»), y el modelo escoge los
 * bloques y los parametriza, que es exactamente y únicamente lo que se le
 * permite hacer.
 *
 * Lo que esta pantalla sí tiene que dar es lo que el chat da mal: VOLVER A
 * CORRERLO. Nadie va a reabrir una conversación de hace un mes para pedir el
 * mismo informe otra vez. Así que aquí está la lista, con un botón cada uno.
 *
 * ===========================================================================
 * «GENERAR» HACE UNA FOTO NUEVA, Y SE DICE
 * ===========================================================================
 * El botón no actualiza el informe: crea otro, con la fecha de hoy, y el
 * anterior se queda en el estante. Es la propiedad que hace citable a todo este
 * módulo, así que la pantalla la dice en vez de dejar que se descubra al ver
 * dos filas donde se esperaba una.
 */

export interface SavedRecipe {
  id: string;
  name: string;
  blocks: string[];
  blockLabels: string[];
  restricted: boolean;
  lastRunLabel: string | null;
}

export function SavedRecipes({ recipes }: { recipes: SavedRecipe[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (id: string) => {
    setError(null);
    setBusy(id);
    startTransition(async () => {
      const result = await runRecipeAction(id);
      setBusy(null);
      if (!result.ok || !result.reportId) {
        setError(result.error ?? 'No se pudo generar el informe.');
        return;
      }
      router.push(`/reports/${result.reportId}`);
    });
  };

  if (recipes.length === 0) {
    return (
      <section className="mt-6">
        <h2 className="field-label mb-3">A la medida</h2>
        <div className="rounded-card border border-dashed border-border bg-surface-2 p-5">
          <p className="max-w-prose text-xs leading-relaxed text-ink-muted">
            ¿Necesitas uno que no es ninguno de los tres de arriba? Pídeselo a Cortex en el chat:
            «júntame lo que se vence este trimestre y el estado de la flota en un solo informe para
            la junta». Cortex arma el informe con los bloques que sabe calcular, le pone nombre, y
            desde acá lo vuelves a correr cuando quieras — o lo programas para que llegue solo cada
            lunes.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="mt-6">
      <h2 className="field-label mb-3">A la medida</h2>
      <ul className="grid gap-2.5 sm:grid-cols-2">
        {recipes.map((r) => {
          const running = pending && busy === r.id;
          return (
            <li
              key={r.id}
              className="flex flex-col rounded-card border border-border bg-surface p-4 shadow-card"
            >
              <div className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
                  <LayoutGrid className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <h3 className="text-sm font-semibold leading-snug text-ink">{r.name}</h3>
                  <p className="mt-1 text-micro leading-snug text-ink-faint">
                    {r.blockLabels.join(' · ')}
                  </p>
                </div>
              </div>

              <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-ink-faint">
                {r.lastRunLabel ? (
                  <>
                    <span className="field-label">Última vez</span>
                    <span className="tabular">{r.lastRunLabel}</span>
                  </>
                ) : (
                  <span>Todavía sin correr.</span>
                )}
                {r.restricted && (
                  <span
                    className="inline-flex items-center gap-1 text-amber"
                    title="Nombra a personas del equipo, así que no se puede compartir por enlace público."
                  >
                    <ShieldOff className="h-3 w-3" aria-hidden />
                    sólo adentro
                  </span>
                )}
              </p>

              <div className="mt-auto pt-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => run(r.id)}
                  disabled={pending}
                  className="w-full"
                >
                  {running ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      Generando…
                    </>
                  ) : (
                    'Generar de nuevo'
                  )}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      <p className={clsx('mt-3 text-micro leading-snug text-ink-faint')}>
        Generar de nuevo hace una fotografía nueva con los datos de hoy. La anterior se queda donde
        está: las dos siguen existiendo, cada una con su fecha.
      </p>
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-sm border border-rose/20 bg-rose-soft px-4 py-2.5 text-xs text-rose"
        >
          {error}
        </p>
      )}
    </section>
  );
}
