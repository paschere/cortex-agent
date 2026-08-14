'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { AlertTriangle, ChevronDown, ChevronRight, KeyRound, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Conceder un mandato.
 *
 * DOS DECISIONES DE INTERFAZ QUE SON DE SEGURIDAD, NO DE ESTILO:
 *
 * 1. La lista de herramientas cubiertas se enseña RESUELTA y completa antes de
 *    conceder, y la resuelve el servidor (PUT /api/mandates) con la misma
 *    función que después congela la instantánea. Enseñar «gmail.*» y que la
 *    persona descubra después qué había ahí dentro es la manera más rápida de
 *    que un mandato haga algo que su dueño no quería.
 *
 * 2. El botón dice «Conceder el mandato» y el resumen de encima dice en una
 *    frase completa qué se está autorizando. Nada de «Guardar»: esto no guarda
 *    una preferencia, autoriza a actuar sin preguntar.
 */

export interface CatalogueFamily {
  family: string;
  label: string;
  tools: { id: string; label: string }[];
}

type Ceiling = 'low' | 'medium' | 'high';

const RISK_COPY: Record<Ceiling, { title: string; blurb: string }> = {
  low: {
    title: 'Bajo',
    blurb: 'Solo consultas y escrituras internas sin nada delicado dentro.',
  },
  medium: {
    title: 'Medio',
    blurb: 'Además, escrituras en sistemas internos y envíos de poco alcance.',
  },
  high: {
    title: 'Alto',
    blurb:
      'Además, correos y publicaciones que salen de la empresa. Es el techo más alto que existe: lo crítico no se delega nunca.',
  },
};

export function GrantForm({
  catalogue,
  defaultDays,
}: {
  catalogue: CatalogueFamily[];
  defaultDays: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const [label, setLabel] = useState('');
  const [reason, setReason] = useState('');
  const [patterns, setPatterns] = useState<string[]>([]);
  const [maxRiskLevel, setMaxRiskLevel] = useState<Ceiling>('medium');
  const [amountCeiling, setAmountCeiling] = useState('');
  const [currency, setCurrency] = useState('COP');
  const [appliesUnattended, setAppliesUnattended] = useState(false);
  const [maxUsesPerDay, setMaxUsesPerDay] = useState('');
  const [days, setDays] = useState(String(defaultDays));

  const [covered, setCovered] = useState<string[]>([]);
  const [resolving, setResolving] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // La cobertura la resuelve siempre el servidor, con la misma función que
  // congela la instantánea al conceder. Recalcularla aquí sería una segunda
  // implementación de la regla, y dos implementaciones de una regla divergen.
  useEffect(() => {
    if (patterns.length === 0) {
      setCovered([]);
      return;
    }
    let cancelled = false;
    setResolving(true);
    fetch('/api/mandates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ toolPatterns: patterns }),
    })
      .then((r) => r.json())
      .then((j: { covered?: string[] }) => {
        if (!cancelled) setCovered(j.covered ?? []);
      })
      .catch(() => {
        if (!cancelled) setCovered([]);
      })
      .finally(() => {
        if (!cancelled) setResolving(false);
      });
    return () => {
      cancelled = true;
    };
  }, [patterns]);

  function toggle(pattern: string) {
    setPatterns((prev) =>
      prev.includes(pattern) ? prev.filter((p) => p !== pattern) : [...prev, pattern],
    );
  }

  async function submit() {
    setError(null);
    setSaving(true);
    const ceiling =
      amountCeiling.trim() === '' ? null : Number(amountCeiling.replace(/[^\d.]/g, ''));
    try {
      const res = await fetch('/api/mandates', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          label,
          reason,
          toolPatterns: patterns,
          maxRiskLevel,
          amountCeiling: ceiling,
          currency: ceiling === null ? null : currency.trim().toUpperCase(),
          appliesUnattended,
          maxUsesPerDay: maxUsesPerDay.trim() === '' ? null : Number(maxUsesPerDay),
          days: Number(days),
        }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? 'No se pudo conceder el mandato.');
        return;
      }
      setOpen(false);
      setLabel('');
      setReason('');
      setPatterns([]);
      router.refresh();
    } catch {
      setError('No se pudo hablar con el servidor.');
    } finally {
      setSaving(false);
    }
  }

  const ready = label.trim().length >= 3 && covered.length > 0 && !resolving;

  if (!open) {
    return (
      <Panel className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div>
          <div className="text-sm font-bold text-ink">Conceder un mandato nuevo</div>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
            Elige qué herramientas quedan autorizadas, hasta qué nivel de riesgo y por cuánto
            tiempo. Cortex dejará de preguntarte antes de usarlas.
          </p>
        </div>
        <Button onClick={() => setOpen(true)}>
          <KeyRound className="h-4 w-4" />
          Conceder un mandato
        </Button>
      </Panel>
    );
  }

  return (
    <Panel className="p-4">
      <div className="field-label mb-3">Mandato nuevo</div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <label className="block" htmlFor="mandate-label">
            <span className="field-label">Cómo se llama</span>
            <Input
              id="mandate-label"
              className="mt-1"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Correos a clientes"
              maxLength={80}
            />
            <span className="mt-1 block text-micro text-ink-faint">
              Este nombre es el que Cortex cita cuando actúa sin preguntar.
            </span>
          </label>

          <label className="block">
            <span className="field-label">Para qué se concede</span>
            <textarea
              className="mt-1 w-full rounded-[10px] border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={500}
              placeholder="El equipo comercial responde a clientes todo el día y confirmar cada correo cuesta más de lo que protege."
            />
            <span className="mt-1 block text-micro text-ink-faint">
              Es lo único que dentro de seis meses servirá para decidir si se renueva.
            </span>
          </label>

          <div>
            <span className="field-label">Hasta qué nivel de riesgo</span>
            <div className="mt-1 space-y-1.5">
              {(['low', 'medium', 'high'] as const).map((level) => (
                <button
                  type="button"
                  key={level}
                  onClick={() => setMaxRiskLevel(level)}
                  className={clsx(
                    'block w-full rounded-sm border px-3 py-2 text-left transition-colors',
                    maxRiskLevel === level
                      ? 'border-primary/40 bg-primary-soft'
                      : 'border-border bg-surface-2 hover:border-border-strong',
                  )}
                >
                  <span className="text-xs font-bold text-ink">{RISK_COPY[level].title}</span>
                  <span className="mt-0.5 block text-micro leading-relaxed text-ink-muted">
                    {RISK_COPY[level].blurb}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="block" htmlFor="mandate-ceiling">
              <span className="field-label">Techo de dinero</span>
              <Input
                id="mandate-ceiling"
                className="mt-1"
                inputMode="decimal"
                value={amountCeiling}
                onChange={(e) => setAmountCeiling(e.target.value)}
                placeholder="500000"
              />
            </label>
            <label className="block" htmlFor="mandate-currency">
              <span className="field-label">Moneda</span>
              <Input
                id="mandate-currency"
                className="mt-1"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))}
                placeholder="COP"
                disabled={amountCeiling.trim() === ''}
              />
            </label>
          </div>
          <p className="text-micro leading-relaxed text-ink-faint">
            Un techo de dinero solo muerde en herramientas que declaran el importe y su moneda en su
            propia entrada. Hoy casi ninguna lo hace: en las demás, poner un techo hace que el
            mandato no se aplique y la acción vuelva a pedirte confirmación. No se busca la cifra
            dentro del texto de un correo — equivocarse ahí autorizaría de más.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <label className="block" htmlFor="mandate-days">
              <span className="field-label">Caduca en (días)</span>
              <Input
                id="mandate-days"
                className="mt-1"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
              />
            </label>
            <label className="block" htmlFor="mandate-uses">
              <span className="field-label">Máximo de usos al día</span>
              <Input
                id="mandate-uses"
                className="mt-1"
                inputMode="numeric"
                value={maxUsesPerDay}
                onChange={(e) => setMaxUsesPerDay(e.target.value.replace(/\D/g, ''))}
                placeholder="sin tope"
              />
            </label>
          </div>

          <label className="flex items-start gap-2.5 rounded-sm border border-border bg-surface-2 p-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={appliesUnattended}
              onChange={(e) => setAppliesUnattended(e.target.checked)}
            />
            <span className="text-xs leading-relaxed text-ink-muted">
              <span className="font-bold text-ink">Vale también en rutinas automáticas</span>,
              cuando no hay nadie delante. Aun marcándolo, nada que salga de la empresa se ejecuta
              sin persona: eso se bloquea siempre, a cualquier hora.
            </span>
          </label>
        </div>

        <div className="space-y-3">
          <div>
            <span className="field-label">Qué herramientas cubre</span>
            <div className="mt-1 max-h-[320px] overflow-y-auto rounded-sm border border-border bg-surface-2 p-2">
              {catalogue.map((fam) => {
                const all = `${fam.family}.*`;
                const isOpen = expanded === fam.family;
                return (
                  <div key={fam.family} className="mb-1 last:mb-0">
                    <div className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-surface">
                      <input
                        type="checkbox"
                        checked={patterns.includes(all)}
                        onChange={() => toggle(all)}
                      />
                      <span className="flex-1 truncate text-xs font-semibold text-ink">
                        {fam.label}
                      </span>
                      <button
                        type="button"
                        onClick={() => setExpanded(isOpen ? null : fam.family)}
                        className="inline-flex items-center gap-1 text-micro text-ink-faint hover:text-ink"
                      >
                        {fam.tools.length}
                        {isOpen ? (
                          <ChevronDown className="h-3 w-3" />
                        ) : (
                          <ChevronRight className="h-3 w-3" />
                        )}
                      </button>
                    </div>
                    {isOpen && (
                      <div className="ml-6 border-l border-border pl-2">
                        {fam.tools.map((t) => (
                          <label
                            key={t.id}
                            className="flex items-center gap-2 rounded-sm px-1.5 py-1 hover:bg-surface"
                          >
                            <input
                              type="checkbox"
                              checked={patterns.includes(t.id) || patterns.includes(all)}
                              disabled={patterns.includes(all)}
                              onChange={() => toggle(t.id)}
                            />
                            <span className="truncate text-xs text-ink-muted">{t.label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-sm border border-border bg-surface-2 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="field-label">Queda autorizado exactamente esto</span>
              <span className={chipClass(covered.length > 0 ? 'amber' : 'neutral')}>
                {resolving ? '…' : `${covered.length} herramientas`}
              </span>
            </div>
            {covered.length === 0 ? (
              <p className="mt-2 text-micro leading-relaxed text-ink-muted">
                Todavía no has elegido nada. Un mandato que no cubre ninguna herramienta no se
                guarda.
              </p>
            ) : (
              <ul className="tabular mt-2 max-h-[160px] space-y-0.5 overflow-y-auto text-micro text-ink-muted">
                {covered.map((id) => (
                  <li key={id}>{id}</li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-micro leading-relaxed text-ink-faint">
              Esta lista se congela al conceder. Una herramienta instalada después no entra, aunque
              el patrón la nombrara.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-3 flex items-start gap-2 rounded-sm border border-rose/20 bg-rose-soft p-3 text-xs leading-relaxed text-rose">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <p className="max-w-xl text-xs leading-relaxed text-ink-muted">
          {covered.length > 0 ? (
            <>
              A partir de ahora Cortex usará esas{' '}
              <strong className="text-ink">{covered.length} herramientas</strong> sin preguntarte,
              hasta nivel{' '}
              <strong className="text-ink">{RISK_COPY[maxRiskLevel].title.toLowerCase()}</strong>
              {amountCeiling.trim() !== '' && (
                <>
                  {' '}
                  y hasta{' '}
                  <strong className="text-ink">
                    {amountCeiling} {currency}
                  </strong>
                </>
              )}
              , durante <strong className="text-ink">{days || '0'} días</strong>
              {appliesUnattended ? ', incluidas las rutinas automáticas' : ''}.
            </>
          ) : (
            'Elige al menos una herramienta para ver qué se estaría autorizando.'
          )}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={!ready || saving}>
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            Conceder el mandato
          </Button>
        </div>
      </div>
    </Panel>
  );
}
