'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow } from '@/components/datagrid/types';
import { ActionNote, fieldClass, pillLink, pillPrimary } from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { FileSignature, LoaderCircle, Plus, Upload } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import type { ActionResult, ContractListItem, Option } from './types';

/**
 * /contratos (0195): los contratos en la grilla compartida, con lo que importa
 * arriba — cuántos están vigentes, cuántos tienen el aviso previo encima y
 * cuántos borradores esperan datos o revisión. Todo llega armado del servidor.
 */

const STATUS_OPTIONS = [
  { value: 'borrador', label: 'Borrador', tone: 'neutral' as const },
  { value: 'en_revision', label: 'En revisión', tone: 'amber' as const },
  { value: 'firmado', label: 'Firmado', tone: 'primary' as const },
  { value: 'vigente', label: 'Vigente', tone: 'emerald' as const },
  { value: 'vencido', label: 'Vencido', tone: 'rose' as const },
  { value: 'terminado', label: 'Terminado', tone: 'neutral' as const },
];

export function ContractsHome({
  items,
  hidden,
  types,
  onUpload,
  newHref = '/contratos/nuevo',
}: {
  items: ContractListItem[];
  hidden: number;
  types: Option[];
  onUpload: (input: {
    title: string;
    contractType: string;
    documentId: string;
    counterpartyKind: string;
    counterpartyName?: string | null;
    signedAt?: string | null;
  }) => Promise<ActionResult>;
  newHref?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const summary = useMemo(() => {
    const vigentes = items.filter((i) => i.status === 'vigente' || i.status === 'firmado').length;
    const notice = items.filter(
      (i) => i.daysToNotice !== null && i.daysToNotice >= 0 && i.daysToNotice <= 30,
    ).length;
    const drafts = items.filter(
      (i) => i.status === 'borrador' || i.status === 'en_revision',
    ).length;
    const proposals = items.reduce((s, i) => s + i.pendingObligations, 0);
    return [
      { label: 'Vigentes o firmados', value: vigentes, tone: 'text-emerald' },
      { label: 'Aviso previo en 30 días', value: notice, tone: notice ? 'text-amber' : 'text-ink' },
      { label: 'Borradores y en revisión', value: drafts, tone: 'text-ink' },
      {
        label: 'Obligaciones por confirmar',
        value: proposals,
        tone: proposals ? 'text-amber' : 'text-ink',
      },
    ];
  }, [items]);

  const columns: GridColumn[] = [
    { key: 'title', label: 'Contrato', type: 'text', pinned: true, primary: true, width: 280 },
    {
      key: 'type',
      label: 'Tipo',
      type: 'select',
      options: types.map((t) => ({ value: t.label })),
      width: 170,
    },
    { key: 'counterparty', label: 'Contraparte', type: 'text', width: 190 },
    { key: 'status', label: 'Estado', type: 'status', options: STATUS_OPTIONS, width: 120 },
    { key: 'value', label: 'Valor', type: 'money', width: 140 },
    { key: 'end', label: 'Termina', type: 'date', width: 120 },
    { key: 'renewal', label: 'Renovación', type: 'text', width: 200 },
    {
      key: 'notice',
      label: 'Avisar antes de',
      type: 'date',
      width: 140,
      description: 'Último día para avisar por escrito que no se renueva',
    },
    { key: 'pending', label: 'Por completar', type: 'text', width: 180 },
    { key: 'owner', label: 'Responsable', type: 'person', width: 150 },
  ];
  const rows: GridRow[] = items.map((i) => ({
    id: i.id,
    href: `/contratos/${i.id}`,
    values: {
      title: i.title,
      type: i.typeLabel,
      counterparty: i.counterparty,
      status: i.status,
      value: i.value,
      end: i.currentEnd,
      renewal: i.renewalLabel,
      notice: i.noticeDeadline,
      pending: [
        i.placeholders ? `${i.placeholders} datos` : '',
        i.pendingObligations ? `${i.pendingObligations} obligaciones` : '',
        !i.hasSignedCopy && (i.status === 'vigente' || i.status === 'firmado')
          ? 'sin copia firmada'
          : '',
      ]
        .filter(Boolean)
        .join(' · '),
      owner: i.owner,
    },
  }));

  return (
    <>
      <PageHeader
        title="Contratos"
        subtitle="Borradores desde plantillas para que tu abogado los revise, las copias firmadas, quién debe qué y hasta cuándo se puede avisar que no se renuevan. Nada de esto es asesoría legal."
        icon={<FileSignature className="h-5 w-5" aria-hidden />}
        actions={
          <>
            <button type="button" className={pillLink} onClick={() => setUploading((v) => !v)}>
              <Upload className="h-3.5 w-3.5" aria-hidden />
              Subir uno firmado
            </button>
            <Link href={newHref} className={pillPrimary}>
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Nuevo contrato
            </Link>
          </>
        }
      />
      {uploading && (
        <UploadPanel types={types} onUpload={onUpload} onClose={() => setUploading(false)} />
      )}
      <dl className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {summary.map((s) => (
          <div
            key={s.label}
            className="rounded-card border border-border bg-surface px-4 py-3 shadow-card"
          >
            <dt className="text-xs text-ink-muted">{s.label}</dt>
            <dd className={clsx('mt-0.5 text-2xl font-extrabold tabular-nums', s.tone)}>
              {s.value}
            </dd>
          </div>
        ))}
      </dl>
      <DataGrid
        columns={columns}
        rows={rows}
        initialView={{ sort: [{ key: 'notice', dir: 'asc' }] }}
        noun={{ one: 'contrato', many: 'contratos', gender: 'm' }}
        exportName="contratos"
        askCortexContext="Mis contratos"
        emptyState={{
          title: 'Todavía no hay contratos',
          body: 'Redacta uno desde una plantilla o sube los que ya tienes firmados para vigilar sus obligaciones y su aviso previo.',
          action: { label: 'Nuevo contrato', href: newHref },
        }}
        height="calc(100vh - 360px)"
      />
      {hidden > 0 && (
        <p className="mt-3 text-xs text-ink-faint">
          {hidden === 1
            ? 'Un contrato laboral no se muestra'
            : `${hidden} contratos laborales no se muestran`}
          : los ven quien administra la empresa, quien los creó y su responsable.
        </p>
      )}
    </>
  );
}

function UploadPanel({
  types,
  onUpload,
  onClose,
}: {
  types: Option[];
  onUpload: Parameters<typeof ContractsHome>[0]['onUpload'];
  onClose: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(form: FormData) {
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      setNote({ ok: false, text: 'Elige el archivo del contrato.' });
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const body = new FormData();
      body.append('file', file);
      const res = await fetch('/api/kb/documents', { method: 'POST', body });
      const json = (await res.json().catch(() => ({}))) as {
        document?: { id: string };
        error?: string;
      };
      if (!res.ok || !json.document) {
        setNote({ ok: false, text: json.error ?? 'No se pudo subir el archivo.' });
        return;
      }
      const r = await onUpload({
        title: String(form.get('title') ?? ''),
        contractType: String(form.get('type') ?? 'otro'),
        documentId: json.document.id,
        counterpartyKind: 'otro',
        counterpartyName: String(form.get('counterparty') ?? '') || null,
        signedAt: String(form.get('signedAt') ?? '') || null,
      });
      if (!r.ok) setNote({ ok: false, text: r.error });
      else if (r.id) router.push(`/contratos/${r.id}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel className="mb-5 p-5">
      <form action={submit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="text-xs font-semibold text-ink-muted">
          Nombre
          <input
            name="title"
            required
            minLength={3}
            className={clsx(fieldClass, 'mt-1')}
            placeholder="Arriendo bodega Itagüí"
          />
        </label>
        <label className="text-xs font-semibold text-ink-muted">
          Tipo
          <select name="type" className={clsx(fieldClass, 'mt-1')} defaultValue="otro">
            {types.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs font-semibold text-ink-muted">
          Contraparte
          <input name="counterparty" className={clsx(fieldClass, 'mt-1')} />
        </label>
        <label className="text-xs font-semibold text-ink-muted">
          Fecha de firma
          <input name="signedAt" type="date" className={clsx(fieldClass, 'mt-1')} />
        </label>
        <label className="text-xs font-semibold text-ink-muted sm:col-span-2">
          Archivo (PDF o Word)
          <input
            name="file"
            type="file"
            accept=".pdf,.docx,application/pdf"
            className={clsx(fieldClass, 'mt-1')}
          />
        </label>
        <div className="flex items-center gap-2 sm:col-span-2 lg:col-span-3">
          <button type="submit" className={pillPrimary} disabled={busy}>
            {busy ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden />
            )}
            Guardar
          </button>
          <button type="button" className={pillLink} onClick={onClose}>
            Cancelar
          </button>
          <ActionNote note={note} />
        </div>
      </form>
    </Panel>
  );
}
