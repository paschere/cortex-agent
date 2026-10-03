'use client';

import { ExpirationsList } from '@/components/doc-expirations/ExpirationsList';
import { NewExpirationButton } from '@/components/doc-expirations/NewExpiration';
import { ReviewQueue } from '@/components/doc-expirations/ReviewQueue';
import {
  type SubjectExpirationItem,
  SubjectExpirations,
} from '@/components/doc-expirations/SubjectExpirations';
import type { ActionResult, Option } from '@/components/doc-expirations/types';
import { PageHeader } from '@/components/ui/page-header';
import type { ExpirationsScreenData } from '@/lib/doc-expirations/grid';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CalendarClock } from 'lucide-react';
import { useEffect } from 'react';

/**
 * Documentos que vencen con datos inventados. Las acciones son de mentira:
 * contestan en pantalla sin tocar ninguna base.
 */

const fake = async (note: string): Promise<ActionResult> => {
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true, note: `(escaparate) ${note}` };
};

const KINDS: Option[] = [
  { value: 'poliza', label: 'Póliza' },
  { value: 'soat', label: 'SOAT' },
  { value: 'tecnomecanica', label: 'Tecnomecánica' },
  { value: 'licencia', label: 'Licencia' },
  { value: 'permiso', label: 'Permiso' },
  { value: 'contrato', label: 'Contrato' },
  { value: 'certificado', label: 'Certificado' },
  { value: 'habilitacion', label: 'Habilitación' },
  { value: 'otro', label: 'Otro' },
];

const SUBJECTS: Option[] = [
  { value: 'vehiculo', label: 'Vehículo' },
  { value: 'cliente', label: 'Cliente' },
  { value: 'empleado', label: 'Persona del equipo' },
  { value: 'empresa', label: 'La empresa' },
  { value: 'otro', label: 'Otro' },
];

export function VencimientosShowcase({
  dark,
  pantalla,
  screen,
  team,
  clientItems,
}: {
  dark: boolean;
  pantalla: 'lista' | 'revisar' | 'ficha';
  screen: ExpirationsScreenData;
  team: Option[];
  clientItems: SubjectExpirationItem[];
}) {
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }, [dark]);

  if (pantalla === 'ficha') {
    return (
      <div className="cortex-workspace min-h-screen bg-canvas px-4 py-8">
        <div className="mx-auto max-w-[380px]">
          <SubjectExpirations
            items={clientItems}
            href="/documentos-vencen?sujeto=Nexa%20Log%C3%ADstica"
          />
        </div>
      </div>
    );
  }

  const tabs = [
    { id: 'lista', label: 'Vencimientos', count: 2, tone: 'rose' as const },
    { id: 'revisar', label: 'Por revisar', count: screen.review.length, tone: 'amber' as const },
  ];

  return (
    <div className="cortex-workspace min-h-screen bg-canvas">
      <div className="mx-auto max-w-[1320px] px-4 py-6 sm:px-6 sm:py-8">
        <PageHeader
          title="Documentos que vencen"
          subtitle="SOAT, tecnomecánica, pólizas, licencias, permisos y contratos: cuándo vencen, de dónde salió cada fecha y quién los renueva. La renovación de la Cámara de Comercio está en Impuestos."
          icon={<CalendarClock className="h-5 w-5" aria-hidden />}
        />
        <nav className="mb-5 flex gap-1 border-b border-border" aria-label="Secciones">
          {tabs.map((t) => (
            <a
              key={t.id}
              href={`?pantalla=${t.id}${dark ? '&modo=oscuro' : ''}`}
              aria-current={pantalla === t.id ? 'page' : undefined}
              className={clsx(
                '-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-semibold',
                pantalla === t.id
                  ? 'border-primary text-ink'
                  : 'border-transparent text-ink-muted hover:text-ink',
              )}
            >
              {t.label}
              {t.count > 0 && <span className={chipClass(t.tone)}>{t.count}</span>}
            </a>
          ))}
        </nav>
        {pantalla === 'revisar' ? (
          <ReviewQueue
            items={screen.review}
            kinds={KINDS}
            team={team}
            onConfirm={() => fake('Confirmado: el aviso sale 30 días antes.')}
            onDiscard={() => fake('Descartado.')}
          />
        ) : (
          <ExpirationsList
            columns={screen.columns}
            rows={screen.rows}
            details={screen.details}
            presets={screen.presets}
            pending={screen.review.length}
            reviewHref="?pantalla=revisar"
            handlers={{
              edit: async () => {},
              linkRenewal: () => fake('Subido.'),
              backfill: () => fake('Revisé 40 documentos y encontré 3 fechas por confirmar.'),
            }}
            createSlot={
              <NewExpirationButton
                kinds={KINDS}
                subjectKinds={SUBJECTS}
                team={team}
                leadDays={{ soat: 30, tecnomecanica: 30, poliza: 45, contrato: 60, licencia: 60 }}
                onTrack={() => fake('Registrado.')}
              />
            }
          />
        )}
      </div>
    </div>
  );
}
