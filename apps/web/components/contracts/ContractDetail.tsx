'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  BellRing,
  CalendarClock,
  Check,
  Copy,
  Download,
  FileSignature,
  FileText,
  History,
  ListChecks,
  LoaderCircle,
  Pencil,
  Quote,
  ScanText,
  Send,
  Upload,
  X,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type {
  ActionResult,
  ContractActions,
  ContractDetailData,
  ObligationItem,
  Option,
} from './types';

/**
 * La ficha de un contrato (0195). A la izquierda el texto (el borrador, con
 * sus marcadores resaltados, editable mientras no se firme); a la derecha el
 * estado y lo que sigue, la vigencia con su aviso previo, las obligaciones
 * (las leídas esperan confirmación con su frase a la vista) y la línea de
 * tiempo. La franja de borrador está siempre arriba del texto.
 */

const money = (n: number | null, c: string) =>
  n === null
    ? '—'
    : c === 'COP'
      ? `$ ${Math.round(n).toLocaleString('es-CO')}`
      : `${n.toLocaleString('es-CO')} ${c}`;

function useAct() {
  const router = useRouter();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { ok: true, text: r.note ?? 'Listo.' } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return { note, pending, run };
}

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\[COMPLETAR: [^\]]+\])/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('[COMPLETAR:') ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: el texto no cambia de orden
          <mark key={i} className="rounded-[3px] bg-amber-soft px-0.5 text-amber">
            {p}
          </mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: el texto no cambia de orden
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

export function ContractDetail({
  data,
  team,
  actions,
}: {
  data: ContractDetailData;
  team: Option[];
  actions: ContractActions;
}) {
  const { note, pending, run } = useAct();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(data.bodyText ?? '');
  const [copied, setCopied] = useState(false);
  const signedLike =
    data.status === 'firmado' || data.status === 'vigente' || data.status === 'vencido';

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            href="/contratos"
            className="inline-flex items-center gap-1 text-xs font-semibold text-ink-muted hover:text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Contratos
          </Link>
          <h1 className="mt-2 text-balance text-xl font-extrabold text-ink md:text-display">
            {data.title}
          </h1>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-muted">
            <span className={statusPill(data.statusTone)}>{data.statusLabel}</span>
            <span>{data.typeLabel}</span>
            {data.counterparty && (
              <span>
                · {data.counterpartyKindLabel}:{' '}
                <strong className="text-ink">{data.counterparty}</strong>
              </span>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {data.bodyText && (
            <>
              <a href={data.pdfHref} target="_blank" rel="noreferrer" className={pillLink}>
                <Download className="h-3.5 w-3.5" aria-hidden /> PDF
              </a>
              <a href={data.docxHref} className={pillLink}>
                <FileText className="h-3.5 w-3.5" aria-hidden /> Word
              </a>
              <button
                type="button"
                className={pillLink}
                onClick={async () => {
                  await navigator.clipboard.writeText(data.bodyText ?? '').catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Copy className="h-3.5 w-3.5" aria-hidden />
                )}
                {copied ? 'Copiado' : 'Copiar texto'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="min-w-0 space-y-5">
          <Panel className="overflow-hidden">
            <div className="flex items-center justify-between gap-3 border-b border-amber/25 bg-amber-soft px-5 py-2.5">
              <p className="text-xs font-bold uppercase tracking-wide text-amber">
                Borrador para revisión de un abogado · no es asesoría legal
              </p>
              {data.editable && data.bodyText && !editing && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-semibold text-amber hover:underline"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden /> Editar
                </button>
              )}
            </div>
            {data.placeholders.length > 0 && (
              <div className="border-b border-border px-5 py-3 text-xs text-ink-muted">
                <strong className="text-ink">Faltan {data.placeholders.length} datos:</strong>{' '}
                {data.placeholders.slice(0, 10).join(' · ')}
                {data.placeholders.length > 10 ? '…' : ''}
              </div>
            )}
            {data.bodyText ? (
              editing ? (
                <div className="p-5">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    rows={28}
                    className={clsx(fieldClass, 'font-mono text-xs leading-relaxed')}
                  />
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      className={pillPrimary}
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          const r = await actions.saveText({ id: data.id, text });
                          if (r.ok) setEditing(false);
                          return r;
                        })
                      }
                    >
                      Guardar texto
                    </button>
                    <button
                      type="button"
                      className={pillLink}
                      onClick={() => {
                        setText(data.bodyText ?? '');
                        setEditing(false);
                      }}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <article className="max-h-[70vh] overflow-y-auto whitespace-pre-wrap px-6 py-6 font-serif text-base leading-7 text-ink sm:px-10">
                  <Highlighted text={data.bodyText} />
                </article>
              )
            ) : (
              <div className="px-6 py-10 text-center text-sm text-ink-muted">
                Este contrato llegó firmado: su texto está en el documento.
                {data.documentHref && (
                  <>
                    {' '}
                    <Link href={data.documentHref} className="font-semibold text-primary underline">
                      Abrir el documento
                    </Link>
                  </>
                )}
              </div>
            )}
          </Panel>
          <Obligations data={data} team={team} actions={actions} />
        </div>

        <aside className="space-y-5">
          <Panel className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <FileSignature className="h-4 w-4 text-ink-faint" aria-hidden /> Estado
            </h2>
            <div className="mt-3 space-y-3">
              {data.status === 'borrador' && (
                <button
                  type="button"
                  className={pillLink}
                  disabled={pending}
                  onClick={() => run(() => actions.sendToReview({ id: data.id }))}
                >
                  <Send className="h-3.5 w-3.5" aria-hidden /> Mandar a revisión del abogado
                </button>
              )}
              {(data.status === 'borrador' ||
                data.status === 'en_revision' ||
                (signedLike && !data.documentId)) && (
                <SignedUpload id={data.id} onSigned={actions.markSigned} status={data.status} />
              )}
              {signedLike && data.documentId && data.documentHref && (
                <p className="text-xs text-ink-muted">
                  Copia firmada{data.signedAt ? ` el ${data.signedAt}` : ''}:{' '}
                  <Link href={data.documentHref} className="font-semibold text-primary underline">
                    abrir
                  </Link>
                </p>
              )}
              {data.status !== 'terminado' && (
                <Terminate id={data.id} onTerminate={actions.terminate} />
              )}
            </div>
            <div className="mt-3">
              <ActionNote note={note} />
            </div>
          </Panel>
          <Term data={data} team={team} actions={actions} />
          {data.legalNotes.length > 0 && (
            <Panel className="p-5">
              <h2 className="text-sm font-bold text-ink">Para tu abogado</h2>
              <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs leading-relaxed text-ink-muted">
                {data.legalNotes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Panel>
          )}
          <Panel className="p-5">
            <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
              <History className="h-4 w-4 text-ink-faint" aria-hidden /> Línea de tiempo
            </h2>
            <ol className="mt-3 space-y-3 border-l border-border pl-4">
              {data.timeline.map((e) => (
                <li key={e.id} className="relative text-xs">
                  <span
                    className="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-primary"
                    aria-hidden
                  />
                  <p className="font-semibold text-ink">{e.detail ?? e.kind}</p>
                  <p className="text-ink-faint">
                    {new Date(e.at).toLocaleString('es-CO', {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                      timeZone: 'America/Bogota',
                    })}
                    {e.actor ? ` · ${e.actor}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </Panel>
        </aside>
      </div>
    </>
  );
}

function SignedUpload({
  id,
  status,
  onSigned,
}: {
  id: string;
  status: string;
  onSigned: ContractActions['markSigned'];
}) {
  const { note, pending, run } = useAct();
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState('');
  async function upload(file: File) {
    setBusy(true);
    const body = new FormData();
    body.append('file', file);
    const res = await fetch('/api/kb/documents', { method: 'POST', body });
    const json = (await res.json().catch(() => ({}))) as {
      document?: { id: string };
      error?: string;
    };
    setBusy(false);
    if (!res.ok || !json.document) return;
    const documentId = json.document.id;
    run(() => onSigned({ id, documentId, signedAt: date || null }));
  }
  return (
    <div className="rounded-sm border border-border p-3">
      <p className="text-xs font-semibold text-ink">
        {status === 'borrador' || status === 'en_revision'
          ? 'Ya se firmó'
          : 'Sube la copia firmada'}
      </p>
      <label className="mt-2 block text-xs text-ink-muted">
        Fecha de firma
        <input
          type="date"
          className={clsx(fieldClass, 'mt-1')}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      <div className="mt-2 flex flex-wrap gap-2">
        <label
          className={clsx(
            pillPrimary,
            'cursor-pointer',
            (busy || pending) && 'pointer-events-none opacity-60',
          )}
        >
          {busy || pending ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Upload className="h-3.5 w-3.5" aria-hidden />
          )}
          Subir copia firmada
          <input
            type="file"
            accept=".pdf,.docx,application/pdf"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
            }}
          />
        </label>
        {date && (
          <button
            type="button"
            className={pillLink}
            disabled={pending}
            onClick={() => run(() => onSigned({ id, signedAt: date }))}
          >
            Marcar firmado sin copia
          </button>
        )}
      </div>
      <div className="mt-2">
        <ActionNote note={note} />
      </div>
    </div>
  );
}

function Terminate({ id, onTerminate }: { id: string; onTerminate: ContractActions['terminate'] }) {
  const { note, pending, run } = useAct();
  const [open, setOpen] = useState(false);
  const [on, setOn] = useState('');
  const [reason, setReason] = useState('');
  if (!open)
    return (
      <button
        type="button"
        className="text-xs font-semibold text-ink-muted underline hover:text-rose"
        onClick={() => setOpen(true)}
      >
        Terminar este contrato
      </button>
    );
  return (
    <div className="rounded-sm border border-rose/20 p-3">
      <input
        type="date"
        className={fieldClass}
        value={on}
        onChange={(e) => setOn(e.target.value)}
        aria-label="Fecha de terminación"
      />
      <input
        className={clsx(fieldClass, 'mt-2')}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Por qué termina"
      />
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className={pillPrimary}
          disabled={pending || !on || !reason}
          onClick={() => run(() => onTerminate({ id, terminatedOn: on, reason }))}
        >
          Terminar
        </button>
        <button type="button" className={pillLink} onClick={() => setOpen(false)}>
          Cancelar
        </button>
      </div>
      <ActionNote note={note} />
    </div>
  );
}

function Term({
  data,
  team,
  actions,
}: { data: ContractDetailData; team: Option[]; actions: ContractActions }) {
  const { note, pending, run } = useAct();
  const [startOn, setStartOn] = useState(data.startOn ?? '');
  const [endOn, setEndOn] = useState(data.endOn ?? '');
  const [renewal, setRenewal] = useState(data.renewal);
  const [months, setMonths] = useState(data.renewalMonths?.toString() ?? '');
  const [notice, setNotice] = useState(data.noticeDays?.toString() ?? '');
  const [value, setValue] = useState(data.value?.toString() ?? '');
  const [owner, setOwner] = useState(data.ownerId ?? '');
  return (
    <Panel className="p-5">
      <h2 className="flex items-center gap-2 text-sm font-bold text-ink">
        <CalendarClock className="h-4 w-4 text-ink-faint" aria-hidden /> Vigencia y aviso previo
      </h2>
      {data.noticeDeadline && (
        <p
          className={clsx(
            'mt-3 flex items-start gap-2 rounded-sm px-3 py-2 text-xs',
            (data.daysToNotice ?? 99) <= 15
              ? 'bg-amber-soft text-amber'
              : 'bg-surface-2 text-ink-muted',
          )}
        >
          <BellRing className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            Para no renovarlo, el aviso por escrito sale a más tardar el{' '}
            <strong>{data.noticeDeadline}</strong>
            {data.daysToNotice !== null ? ` (en ${data.daysToNotice} días)` : ''}.{' '}
            {data.noticeWatched ? 'Está vigilado.' : ''}
          </span>
        </p>
      )}
      <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
        <dt className="text-ink-muted">Valor</dt>
        <dd className="text-right font-semibold tabular-nums text-ink">
          {money(data.value, data.currency)}
        </dd>
        <dt className="text-ink-muted">Fin del período</dt>
        <dd className="text-right font-semibold text-ink">{data.currentEnd ?? '—'}</dd>
        <dt className="text-ink-muted">Renovación</dt>
        <dd className="text-right text-ink">{data.renewalLabel}</dd>
      </dl>
      {data.expirationHref && (
        <p className="mt-2 text-xs text-ink-muted">
          Su vencimiento lo vigila{' '}
          <Link href={data.expirationHref} className="font-semibold text-primary underline">
            Documentos que vencen
          </Link>
          .
        </p>
      )}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="text-xs text-ink-muted">
          Inicio
          <input
            type="date"
            className={clsx(fieldClass, 'mt-1')}
            value={startOn}
            onChange={(e) => setStartOn(e.target.value)}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Terminación
          <input
            type="date"
            className={clsx(fieldClass, 'mt-1')}
            value={endOn}
            onChange={(e) => setEndOn(e.target.value)}
          />
        </label>
        <label className="col-span-2 text-xs text-ink-muted">
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
        <label className="text-xs text-ink-muted">
          Meses por renovación
          <input
            inputMode="numeric"
            className={clsx(fieldClass, 'mt-1')}
            value={months}
            onChange={(e) => setMonths(e.target.value.replace(/\D/g, ''))}
            placeholder="igual al primero"
          />
        </label>
        <label className="text-xs text-ink-muted">
          Días de aviso
          <input
            inputMode="numeric"
            className={clsx(fieldClass, 'mt-1')}
            value={notice}
            onChange={(e) => setNotice(e.target.value.replace(/\D/g, ''))}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Valor
          <input
            inputMode="numeric"
            className={clsx(fieldClass, 'mt-1')}
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Responsable
          <select
            className={clsx(fieldClass, 'mt-1')}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">—</option>
            {team.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          className={pillPrimary}
          disabled={pending}
          onClick={() =>
            run(() =>
              actions.saveTerm({
                id: data.id,
                startOn: startOn || null,
                endOn: endOn || null,
                renewal,
                renewalMonths: months ? Number(months) : null,
                noticeDays: notice ? Number(notice) : null,
                valueAmount: value ? Number(value) : null,
                ownerUserId: owner || null,
              }),
            )
          }
        >
          Guardar fechas
        </button>
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}

function Obligations({
  data,
  team,
  actions,
}: { data: ContractDetailData; team: Option[]; actions: ContractActions }) {
  const { note, pending, run } = useAct();
  const proposals = data.obligations.filter((o) => o.status === 'propuesta');
  const confirmed = data.obligations.filter(
    (o) => o.status === 'confirmada' || o.status === 'cumplida',
  );
  const [adding, setAdding] = useState(false);
  const [desc, setDesc] = useState('');
  const [party, setParty] = useState('nosotros');
  const [due, setDue] = useState('');
  const [rec, setRec] = useState('none');
  return (
    <Panel className="p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-base font-bold text-ink">
          <ListChecks className="h-4 w-4 text-ink-faint" aria-hidden /> Obligaciones
        </h2>
        <div className="flex gap-2">
          {data.documentId && (
            <button
              type="button"
              className={pillLink}
              disabled={pending}
              onClick={() => run(() => actions.extract({ id: data.id }))}
            >
              {pending ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <ScanText className="h-3.5 w-3.5" aria-hidden />
              )}
              Leer del contrato firmado
            </button>
          )}
          <button type="button" className={pillLink} onClick={() => setAdding((v) => !v)}>
            Agregar a mano
          </button>
        </div>
      </div>
      <div className="mt-2">
        <ActionNote note={note} />
      </div>
      {adding && (
        <div className="mt-3 grid gap-2 rounded-sm border border-border p-3 sm:grid-cols-[1fr_140px_150px_140px_auto]">
          <input
            className={fieldClass}
            value={desc}
            onChange={(e) => setDesc(e.target.value)}
            placeholder="Qué hay que hacer"
          />
          <select
            className={fieldClass}
            value={party}
            onChange={(e) => setParty(e.target.value)}
            aria-label="Quién"
          >
            <option value="nosotros">Nosotros</option>
            <option value="contraparte">La contraparte</option>
            <option value="ambas">Ambas</option>
          </select>
          <input
            type="date"
            className={fieldClass}
            value={due}
            onChange={(e) => setDue(e.target.value)}
            aria-label="Para cuándo"
          />
          <select
            className={fieldClass}
            value={rec}
            onChange={(e) => setRec(e.target.value)}
            aria-label="Se repite"
          >
            <option value="none">Una vez</option>
            <option value="monthly">Cada mes</option>
            <option value="quarterly">Cada trimestre</option>
            <option value="yearly">Cada año</option>
          </select>
          <button
            type="button"
            className={pillPrimary}
            disabled={pending || desc.trim().length < 3}
            onClick={() =>
              run(async () => {
                const r = await actions.addObligation({
                  contractId: data.id,
                  party,
                  description: desc,
                  dueOn: due || null,
                  recurrence: rec,
                });
                if (r.ok) {
                  setDesc('');
                  setDue('');
                  setAdding(false);
                }
                return r;
              })
            }
          >
            Agregar
          </button>
        </div>
      )}
      {proposals.length > 0 && (
        <section className="mt-4">
          <h3 className="text-xs font-bold uppercase tracking-wide text-amber">
            Leídas del contrato · por confirmar ({proposals.length})
          </h3>
          <ul className="mt-2 space-y-3">
            {proposals.map((o) => (
              <Proposal key={o.id} o={o} team={team} actions={actions} />
            ))}
          </ul>
        </section>
      )}
      <section className="mt-4">
        {confirmed.length === 0 && proposals.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Todavía no hay obligaciones.{' '}
            {data.documentId
              ? 'Léelas del contrato firmado o agrégalas a mano.'
              : 'Sube la copia firmada para leerlas, o agrégalas a mano.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {confirmed.map((o) => (
              <li key={o.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p
                    className={clsx(
                      'text-sm font-semibold',
                      o.status === 'cumplida' ? 'text-ink-muted line-through' : 'text-ink',
                    )}
                  >
                    {o.description}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {o.partyLabel} · {o.dueOn ? `para el ${o.dueOn}` : (o.dueNote ?? 'sin fecha')}
                    {o.recurrence !== 'none' ? ` · ${o.recurrenceLabel.toLowerCase()}` : ''}
                    {o.owner ? ` · responde ${o.owner}` : ''}
                    {o.watched ? ' · vigilada' : ''}
                  </p>
                  {o.penalty && <p className="mt-1 text-xs text-rose">Sanción: «{o.penalty}»</p>}
                </div>
                {o.status === 'confirmada' && (
                  <button
                    type="button"
                    className={pillLink}
                    disabled={pending}
                    onClick={() => run(() => actions.completeObligation({ id: o.id }))}
                  >
                    <Check className="h-3.5 w-3.5" aria-hidden /> Cumplida
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Panel>
  );
}

function Proposal({
  o,
  team,
  actions,
}: { o: ObligationItem; team: Option[]; actions: ContractActions }) {
  const { note, pending, run } = useAct();
  const [due, setDue] = useState(o.dueOn ?? '');
  const [owner, setOwner] = useState(o.ownerId ?? '');
  return (
    <li className="rounded-sm border border-amber/25 bg-surface p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-ink">{o.description}</span>
        <span
          className={statusPill(
            o.confidence === 'alta' ? 'emerald' : o.confidence === 'media' ? 'amber' : 'rose',
          )}
        >
          confianza {o.confidence ?? 'baja'}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-muted">
        {o.partyLabel}
        {o.responsible ? ` (${o.responsible})` : ''} · {o.categoryLabel}
        {o.recurrence !== 'none' ? ` · ${o.recurrenceLabel.toLowerCase()}` : ''}
        {o.dueNote ? ` · ${o.dueNote}` : ''}
      </p>
      {o.quote && (
        <blockquote className="mt-2 flex gap-2 rounded-sm bg-surface-2 px-3 py-2 text-xs italic text-ink">
          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />«{o.quote}»
        </blockquote>
      )}
      {o.penalty && <p className="mt-1 text-xs text-rose">Sanción: «{o.penalty}»</p>}
      {o.reviewNote && <p className="mt-1 text-xs text-amber">Ojo: {o.reviewNote}</p>}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-ink-muted">
          Fecha
          <input
            type="date"
            className={clsx(fieldClass, 'mt-1 min-h-9 w-40')}
            value={due}
            onChange={(e) => setDue(e.target.value)}
          />
        </label>
        <label className="text-xs text-ink-muted">
          Responde
          <select
            className={clsx(fieldClass, 'mt-1 min-h-9 w-44')}
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">—</option>
            {team.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={pillPrimary}
          disabled={pending}
          onClick={() =>
            run(() =>
              actions.confirmObligation({
                id: o.id,
                dueOn: due || null,
                ownerUserId: owner || null,
              }),
            )
          }
        >
          <Check className="h-3.5 w-3.5" aria-hidden /> Confirmar
        </button>
        <button
          type="button"
          className={pillLink}
          disabled={pending}
          onClick={() =>
            run(() => actions.discardObligation({ id: o.id, reason: 'No es una obligación' }))
          }
        >
          <X className="h-3.5 w-3.5" aria-hidden /> Descartar
        </button>
        <ActionNote note={note} />
      </div>
    </li>
  );
}
