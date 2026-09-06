'use client';
import { Button } from '@/components/ui/button';
import type { ManagementProfile, ManagementProfileData } from '@/lib/management/shape';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { saveProfile } from './actions';
import { Alert, Field, type Person, PersonOptions, Select } from './form-fields';
export function ProfileEditor({
  profile,
  people,
  isAdmin,
  onSaved,
  onManageProcesses,
}: {
  profile: ManagementProfile;
  people: Person[];
  isAdmin: boolean;
  onSaved: () => void;
  onManageProcesses: () => void;
}) {
  const [data, setData] = useState<ManagementProfileData>(profile.data);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const field = <K extends keyof ManagementProfileData>(key: K, value: ManagementProfileData[K]) =>
    setData((d) => ({ ...d, [key]: value }));
  return (
    <form
      className="max-w-4xl space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        start(async () => {
          try {
            const r = await saveProfile(data, profile.revision);
            if (r.ok) onSaved();
            else setError(r.error);
          } catch {
            setError('No se pudo guardar la configuración.');
          }
        });
      }}
    >
      <div>
        <h2 className="font-bold">El encargo de esta empresa</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Acuerda el alcance con el cliente y documenta cómo se evaluará el servicio.
        </p>
      </div>
      {error && <Alert>{error}</Alert>}
      <fieldset disabled={!isAdmin || pending} className="space-y-5">
        <Field
          label="Qué gestiona Cortex y qué queda fuera del alcance"
          value={data.scope}
          onChange={(v) => field('scope', v)}
          required
          multiline
        />
        <Field
          label="Prioridades de la empresa"
          value={data.priorities}
          onChange={(v) => field('priorities', v)}
          required
          multiline
        />
        <Field
          label="Cómo mediremos el éxito del servicio"
          value={data.successMeasures}
          onChange={(v) => field('successMeasures', v)}
          required
          multiline
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            label="A quién escalar los bloqueos"
            value={data.escalationOwnerId ?? ''}
            onChange={(v) => field('escalationOwnerId', v || null)}
          >
            <PersonOptions people={people} />
          </Select>
          <Field
            label="Días hasta la primera revisión de un asunto (1–30)"
            type="number"
            value={String(data.reviewAfterDays)}
            onChange={(v) => field('reviewAfterDays', Number(v))}
            required
          />
        </div>
        <div className="space-y-2 rounded-lg border border-border p-4 text-sm">
          <h3 className="font-semibold">Autoridad para actuar</h3>
          <p className="text-ink-muted">
            Esta ficha define el trabajo. Los permisos de ejecución se administran en Mandatos y las
            decisiones pendientes en Aprobaciones. Los cierres de asuntos requieren verificación de
            un administrador.
          </p>
          <div className="flex flex-wrap gap-4">
            {isAdmin && (
              <Link href="/admin/mandates" className="font-semibold text-primary">
                Configurar mandatos →
              </Link>
            )}
            <Link href="/approvals" className="font-semibold text-primary">
              Revisar aprobaciones →
            </Link>
            <Link href="/company" className="font-semibold text-primary">
              Ficha y responsables de la empresa →
            </Link>
            <Link href="/goals" className="font-semibold text-primary">
              Metas medibles →
            </Link>
          </div>
        </div>
        <div className="rounded-2xl border border-border p-5">
          <h3 className="font-semibold">Manuales de procesos</h3>
          <p className="mt-2 text-sm text-ink-muted">
            Cuenta, dicta y revisa cada proceso en su propio espacio.
          </p>
          <Button className="mt-4" type="button" variant="outline" onClick={onManageProcesses}>
            Abrir biblioteca de procesos
          </Button>
        </div>
      </fieldset>
      {isAdmin ? (
        <Button type="submit" disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar configuración'}
        </Button>
      ) : (
        <p className="text-sm text-ink-muted">
          Puedes consultar esta configuración. Solo los administradores pueden cambiarla.
        </p>
      )}
    </form>
  );
}
