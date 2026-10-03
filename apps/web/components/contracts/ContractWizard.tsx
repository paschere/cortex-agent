'use client';

import { ActionNote, fieldClass, pillLink, pillPrimary } from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Database,
  FilePenLine,
  LoaderCircle,
  Scale,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ActionResult, TemplateCard, WizardData } from './types';

/**
 * El asistente para redactar un contrato (0195), en tres pasos: la plantilla,
 * con quién y las fechas, y los datos que la plantilla no puede sacar de los
 * registros. Lo que se deja en blanco sale como «[COMPLETAR: …]» en el
 * borrador; nada se inventa. Al final se abre la ficha con el texto, el PDF y
 * el Word, siempre marcados como borrador para revisión de un abogado.
 */

const KIND_LABEL: Record<string, string> = {
  cliente: 'Un cliente',
  proveedor: 'Un proveedor',
  empleado: 'Alguien del equipo',
  otro: 'Otra persona o empresa',
};

const RECORD_FIELDS = new Set([
  'empresa_nombre',
  'empresa_nit',
  'empresa_direccion',
  'empresa_representante',
  'empresa_representante_id',
  'contraparte_nombre',
  'contraparte_id',
  'contraparte_direccion',
  'contraparte_correo',
  'fecha_inicio',
  'fecha_fin',
  'valor',
  'salario',
  'canon',
  'precio',
  'preaviso_dias',
  'duracion',
  'fecha_firma',
  'ciudad',
  'fecha_entrega',
  'fecha_efectiva',
  'fecha_terminacion',
]);

export type CreateDraft = (input: {
  templateKey: string;
  title?: string;
  counterpartyKind: string;
  clientId?: string | null;
  supplierId?: string | null;
  employeeUserId?: string | null;
  counterpartyName?: string | null;
  counterpartyId?: string | null;
  values: Record<string, string>;
  startOn?: string | null;
  endOn?: string | null;
  valueAmount?: number | null;
  noticeDays?: number | null;
  renewal?: string | null;
}) => Promise<ActionResult>;

export function ContractWizard({
  data,
  initialTemplate,
  onCreate,
}: {
  data: WizardData;
  initialTemplate: string | null;
  onCreate: CreateDraft;
}) {
  const router = useRouter();
  const first = data.templates.find((t) => t.key === initialTemplate) ?? null;
  const [step, setStep] = useState(first ? 2 : 1);
  const [template, setTemplate] = useState<TemplateCard | null>(first);
  const [kind, setKind] = useState(first?.counterpartyKind ?? 'cliente');
  const [party, setParty] = useState('');
  const [partyName, setPartyName] = useState('');
  const [partyId, setPartyId] = useState('');
  const [startOn, setStartOn] = useState('');
  const [endOn, setEndOn] = useState('');
  const [value, setValue] = useState('');
  const [notice, setNotice] = useState(first?.defaults.noticeDays?.toString() ?? '');
  const [renewal, setRenewal] = useState(first?.defaults.renewal ?? 'ninguna');
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const pick = (t: TemplateCard) => {
    setTemplate(t);
    setKind(t.counterpartyKind);
    setNotice(t.defaults.noticeDays?.toString() ?? '');
    setRenewal(t.defaults.renewal);
    setStep(2);
  };
  const options =
    kind === 'cliente'
      ? data.clients
      : kind === 'proveedor'
        ? data.suppliers
        : kind === 'empleado'
          ? data.team
          : [];
  const ownFields = template?.fields.filter((f) => !RECORD_FIELDS.has(f.key)) ?? [];
  const missingCompany =
    !data.companyReady.name || !data.companyReady.nit || !data.companyReady.representative;

  async function create() {
    if (!template) return;
    setBusy(true);
    setNote(null);
    const amount = Number(value.replace(/[^\d]/g, ''));
    const r = await onCreate({
      templateKey: template.key,
      counterpartyKind: kind,
      clientId: kind === 'cliente' ? party || null : null,
      supplierId: kind === 'proveedor' ? party || null : null,
      employeeUserId: kind === 'empleado' ? party || null : null,
      counterpartyName: partyName.trim() || null,
      counterpartyId: partyId.trim() || null,
      values,
      startOn: startOn || null,
      endOn: endOn || null,
      valueAmount: Number.isFinite(amount) && amount > 0 ? amount : null,
      noticeDays: notice === '' ? null : Number(notice),
      renewal,
    });
    setBusy(false);
    if (!r.ok) setNote({ ok: false, text: r.error });
    else if (r.id) router.push(`/contratos/${r.id}`);
  }

  return (
    <>
      <PageHeader
        title="Nuevo contrato"
        subtitle="Un borrador desde una plantilla, con los datos de tu empresa y de la contraparte. Lo que no sepamos queda marcado para completar. Es un borrador para revisión de un abogado, no asesoría legal."
        icon={<FilePenLine className="h-5 w-5" aria-hidden />}
        actions={
          <Link href="/contratos" className={pillLink}>
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
            Contratos
          </Link>
        }
      />
      <ol className="mb-6 flex flex-wrap gap-2 text-xs font-semibold" aria-label="Pasos">
        {['Plantilla', 'Con quién y cuándo', 'Los datos del contrato'].map((label, i) => (
          <li
            key={label}
            className={clsx(
              'inline-flex items-center gap-2 rounded-pill border px-3 py-1.5',
              step === i + 1
                ? 'border-primary bg-primary-soft text-primary-ink'
                : step > i + 1
                  ? 'border-emerald/30 text-emerald'
                  : 'border-border text-ink-muted',
            )}
          >
            {step > i + 1 ? (
              <Check className="h-3.5 w-3.5" aria-hidden />
            ) : (
              <span className="tabular-nums">{i + 1}</span>
            )}
            {label}
          </li>
        ))}
      </ol>

      {missingCompany && (
        <p className="mb-5 rounded-card border border-amber/30 bg-amber-soft px-4 py-3 text-sm text-amber">
          La ficha de la empresa no tiene{' '}
          {[
            !data.companyReady.name && 'razón social',
            !data.companyReady.nit && 'NIT',
            !data.companyReady.representative && 'representante legal',
          ]
            .filter(Boolean)
            .join(', ')}
          : esos datos saldrán para completar.{' '}
          <Link href="/company" className="font-semibold underline">
            Llenar la ficha
          </Link>
        </p>
      )}

      {step === 1 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.templates.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => pick(t)}
              className="group flex flex-col rounded-card border border-border bg-surface p-5 text-left shadow-card transition-colors hover:border-primary/40"
            >
              <span className="text-base font-bold text-ink">{t.name}</span>
              <span className="mt-1 flex-1 text-sm text-ink-muted">{t.description}</span>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                Usar esta plantilla{' '}
                <ArrowRight
                  className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </span>
            </button>
          ))}
        </div>
      )}

      {step === 2 && template && (
        <Panel className="p-5 sm:p-7">
          <h2 className="text-lg font-extrabold text-ink">{template.name}</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="text-xs font-semibold text-ink-muted">
              La contraparte es
              <select
                className={clsx(fieldClass, 'mt-1')}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setParty('');
                }}
              >
                {Object.entries(KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {options.length > 0 ? (
              <label className="text-xs font-semibold text-ink-muted">
                ¿Quién?
                <select
                  className={clsx(fieldClass, 'mt-1')}
                  value={party}
                  onChange={(e) => setParty(e.target.value)}
                >
                  <option value="">Elige…</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <span />
            )}
            <label className="text-xs font-semibold text-ink-muted">
              Nombre o razón social{' '}
              {options.length > 0 && <span className="font-normal">(si no está en la lista)</span>}
              <input
                className={clsx(fieldClass, 'mt-1')}
                value={partyName}
                onChange={(e) => setPartyName(e.target.value)}
              />
            </label>
            <label className="text-xs font-semibold text-ink-muted">
              Cédula o NIT <span className="font-normal">(sólo si lo sabes)</span>
              <input
                className={clsx(fieldClass, 'mt-1')}
                value={partyId}
                onChange={(e) => setPartyId(e.target.value)}
              />
            </label>
            <label className="text-xs font-semibold text-ink-muted">
              Inicio
              <input
                type="date"
                className={clsx(fieldClass, 'mt-1')}
                value={startOn}
                onChange={(e) => setStartOn(e.target.value)}
              />
            </label>
            <label className="text-xs font-semibold text-ink-muted">
              Terminación
              <input
                type="date"
                className={clsx(fieldClass, 'mt-1')}
                value={endOn}
                onChange={(e) => setEndOn(e.target.value)}
              />
            </label>
            <label className="text-xs font-semibold text-ink-muted">
              Valor (salario, canon o total)
              <input
                inputMode="numeric"
                className={clsx(fieldClass, 'mt-1')}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="$ 0"
              />
            </label>
            <label className="text-xs font-semibold text-ink-muted">
              Renovación
              <select
                className={clsx(fieldClass, 'mt-1')}
                value={renewal}
                onChange={(e) => setRenewal(e.target.value)}
              >
                <option value="ninguna">Termina en su fecha</option>
                <option value="automatica">Se renueva sola si nadie avisa</option>
                <option value="prorroga">Sólo con prórroga pactada</option>
              </select>
            </label>
            <label className="text-xs font-semibold text-ink-muted">
              Días de aviso previo
              <input
                inputMode="numeric"
                className={clsx(fieldClass, 'mt-1')}
                value={notice}
                onChange={(e) => setNotice(e.target.value.replace(/\D/g, ''))}
              />
            </label>
          </div>
          <div className="mt-6 flex gap-2">
            <button type="button" className={pillLink} onClick={() => setStep(1)}>
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Otra plantilla
            </button>
            <button type="button" className={pillPrimary} onClick={() => setStep(3)}>
              Seguir <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
        </Panel>
      )}

      {step === 3 && template && (
        <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
          <Panel className="p-5 sm:p-7">
            <h2 className="text-lg font-extrabold text-ink">Lo que dice este contrato</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Escribe sólo lo que sabes. Lo que dejes en blanco queda como «[COMPLETAR]» en el
              borrador.
            </p>
            <div className="mt-4 space-y-4">
              {ownFields.map((f) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: el control está dentro, en una rama del ternario.
                <label key={f.key} className="block text-xs font-semibold text-ink-muted">
                  {f.label}
                  {f.required && <span className="text-rose"> *</span>}
                  {f.kind === 'longtext' ? (
                    <textarea
                      rows={3}
                      className={clsx(fieldClass, 'mt-1')}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      type={f.kind === 'date' ? 'date' : 'text'}
                      className={clsx(fieldClass, 'mt-1')}
                      value={values[f.key] ?? ''}
                      onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    />
                  )}
                  {f.hint && (
                    <span className="mt-1 block font-normal text-ink-faint">{f.hint}</span>
                  )}
                </label>
              ))}
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <button type="button" className={pillLink} onClick={() => setStep(2)}>
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Atrás
              </button>
              <button type="button" className={pillPrimary} onClick={create} disabled={busy}>
                {busy ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" aria-hidden />
                )}
                Crear el borrador
              </button>
              <ActionNote note={note} />
            </div>
          </Panel>
          <aside className="space-y-4">
            <Panel className="p-5">
              <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
                <Database className="h-4 w-4 text-ink-faint" aria-hidden /> Sale de tus registros
              </h3>
              <p className="mt-1 text-xs text-ink-muted">
                Razón social, NIT y representante de la ficha de la empresa; nombre, NIT, dirección
                y correo de la contraparte; fechas, valor y aviso de lo que escribiste.
              </p>
            </Panel>
            {template.legalNotes.length > 0 && (
              <Panel className="border-amber/30 p-5">
                <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
                  <Scale className="h-4 w-4 text-amber" aria-hidden /> Para tu abogado
                </h3>
                <ul className="mt-2 space-y-2 text-xs leading-relaxed text-ink-muted">
                  {template.legalNotes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </Panel>
            )}
          </aside>
        </div>
      )}
    </>
  );
}
