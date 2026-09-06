'use client';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { useEffect, useState } from 'react';
type Policy = {
  labels: string[];
  senders: string[];
  alerts: boolean;
  replies: boolean;
  learning: boolean;
};
export function MailPolicyControls() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [labels, setLabels] = useState<{ id: string; name: string }[]>([]);
  const [senders, setSenders] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/gmail/policy')
      .then(async (r) => {
        if (!r.ok) throw new Error();
        return r.json();
      })
      .then((d) => {
        if (!alive) return;
        setPolicy(d.policy);
        setLabels(d.labels);
        setSenders(d.policy.senders.join(', '));
        if (d.labelsUnavailable) setMessage('Conecta Gmail para cargar las etiquetas.');
      })
      .catch(() => {
        if (alive) setMessage('No se pudieron cargar las preferencias. Actualiza la página.');
      });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <section className="space-y-5 border-t border-border pt-5">
      <div className="grid gap-4 sm:grid-cols-3">
        {[
          [
            '01',
            'Consultar',
            'Busca en Gmail cuando lo necesites. Los hilos no se copian al cerebro.',
          ],
          [
            '02',
            'Gestionar',
            'Activa avisos o borradores por separado. Cada envío conserva su aprobación.',
          ],
          ['03', 'Aprender', 'Revisa propuestas privadas y decide qué merece conservarse.'],
        ].map(([n, title, body]) => (
          <div key={n}>
            <p className="text-xs text-primary">{n}</p>
            <h3 className="mt-1 font-medium">{title}</h3>
            <p className="mt-1 text-sm text-ink-muted">{body}</p>
          </div>
        ))}
      </div>
      {policy && (
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setMessage('');
            try {
              const r = await fetch('/api/gmail/policy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  ...policy,
                  senders: senders
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                }),
              });
              const d = await r.json();
              if (!r.ok) throw new Error(d.error);
              setPolicy(d.policy);
              setMessage(
                'Preferencias guardadas. Se aplican a las siguientes revisiones automáticas.',
              );
            } catch (e) {
              setMessage(e instanceof Error ? e.message : 'No se pudo guardar.');
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <legend className="font-medium">Qué puede revisar automáticamente</legend>
            <p className="text-xs text-ink-muted">
              Sin filtros, revisa el correo no masivo. Si eliges etiquetas y remitentes, ambos
              filtros deben cumplirse. Las búsquedas que pidas expresamente en el chat consultan
              Gmail en vivo.
            </p>
            <div className="flex max-h-40 flex-wrap gap-3 overflow-y-auto">
              {labels
                .filter((l) => !['SPAM', 'TRASH'].includes(l.id))
                .map((l) => (
                  <label key={l.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.labels.includes(l.id)}
                      onChange={(e) =>
                        setPolicy({
                          ...policy,
                          labels: e.target.checked
                            ? [...policy.labels, l.id]
                            : policy.labels.filter((id) => id !== l.id),
                        })
                      }
                    />
                    {l.name}
                  </label>
                ))}
            </div>
            <label className="block text-sm">
              Remitentes concretos, separados por coma
              <input
                value={senders}
                onChange={(e) => setSenders(e.target.value)}
                placeholder="proveedor@empresa.com"
                className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
            {(
              [
                ['alerts', 'Avisarme de correos que requieren atención'],
                ['replies', 'Preparar borradores de respuesta para mi aprobación'],
                ['learning', 'Proponer aprendizajes para revisión privada'],
              ] as const
            ).map(([key, label]) => (
              <label className="flex items-center gap-3 text-sm" key={key}>
                <input
                  type="checkbox"
                  checked={policy[key]}
                  onChange={(e) => setPolicy({ ...policy, [key]: e.target.checked })}
                />
                {label}
              </label>
            ))}
            <p className="text-xs text-ink-muted">
              Los avisos respetan también tus horarios y límites del resumen. Las propuestas
              conservan extractos y quedan pendientes hasta que las revises. Ningún aprendizaje se
              comparte automáticamente.
            </p>
            <Button disabled={busy}>
              {busy ? 'Guardando…' : 'Guardar preferencias de correo'}
            </Button>
          </fieldset>
        </form>
      )}
      {message && <output className="block text-sm text-ink-muted">{message}</output>}
      <div className="flex flex-wrap gap-4 text-sm text-primary">
        <Link href="/settings/mail-learning">Revisar aprendizajes propuestos →</Link>
        <Link href="/chat?prompt=Consulta%20mi%20Gmail%20en%20vivo%20sin%20archivar%20correos%20en%20el%20cerebro.">
          Consultar mi correo →
        </Link>
      </div>
      <p className="text-xs text-ink-muted">
        Los correos archivados anteriormente siguen disponibles en sus espacios, pero quedan fuera
        de la búsqueda general del cerebro. El registro técnico de consultas conserva
        identificadores y huellas durante 90 días; no guarda cuerpos ni adjuntos.
      </p>
    </section>
  );
}
