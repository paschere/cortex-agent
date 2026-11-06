'use client';

import {
  type BackupDetailView,
  type TableDiffView,
  backupDetailAction,
  createBackupAction,
  listBackupsAction,
  restoreCodeAction,
  restoreConfigAction,
  restoreRowAction,
  restoreTableAction,
} from '@/lib/apps/backup-actions';
import type { BackupSummary } from '@cortex/agent-tools';
import { formatDateTime } from '@cortex/agent-tools/src/format/display';
import { clsx } from 'clsx';
import { DatabaseBackup, Download, RotateCcw } from 'lucide-react';
import { useEffect, useState, useTransition } from 'react';
import {
  type AppEditorData,
  BTN_DANGER,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  ErrorLine,
  INPUT,
} from './shared';

/**
 * «COPIAS» (0247): la red de seguridad de la app. Cada noche (2:00 a. m. de
 * Bogotá) y antes de cada cambio grande queda una copia con la configuración,
 * el código y TODAS las filas de las tablas que la app usa. Aquí se ven, se
 * comparan con hoy, se descargan (Excel o JSON) y se restaura una fila, una
 * tabla, la configuración o el código. Siempre antes de restaurar se hace otra
 * copia, y todo queda en /actividad. Sólo administradores.
 */

const KIND: Record<string, { label: string; tone: string }> = {
  diaria: { label: 'Diaria', tone: 'bg-sky-soft text-sky' },
  antes_de_cambio: { label: 'Antes de un cambio', tone: 'bg-amber-soft text-amber' },
  manual: { label: 'Manual', tone: 'bg-emerald-soft text-emerald' },
};

const sizeOf = (b: number) =>
  b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
const rowsOf = (b: BackupSummary) => Object.values(b.tables).reduce((a, n) => a + n, 0);

/** Lo que se está por restaurar, dicho con cuántas filas cambian, a la espera de un sí. */
interface Ask {
  title: string;
  text: string;
  run: () => Promise<{ ok: boolean; error?: string; message?: string }>;
}

export function CopiasTab({ data }: { data: AppEditorData }) {
  const appId = data.app.id;
  const [pending, start] = useTransition();
  const [backups, setBackups] = useState<BackupSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<BackupDetailView | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);

  function reload() {
    listBackupsAction(appId).then((r) => (r.ok ? setBackups(r.backups) : setError(r.error)));
  }
  useEffect(reload, []);

  function make() {
    setError(null);
    setNote(null);
    start(async () => {
      const r = await createBackupAction(appId, reason);
      if (!r.ok) return setError(r.error);
      setReason('');
      setNote('Copia hecha.');
      reload();
    });
  }

  function view(id: string) {
    setAsk(null);
    if (open === id) {
      setOpen(null);
      return setDetail(null);
    }
    setOpen(id);
    setDetail(null);
    setError(null);
    start(async () => {
      const r = await backupDetailAction(appId, id);
      if (!r.ok) return setError(r.error);
      setDetail(r.detail);
    });
  }

  function confirm() {
    const a = ask;
    if (!a) return;
    setError(null);
    setNote(null);
    start(async () => {
      const r = await a.run();
      setAsk(null);
      if (!r.ok) return setError(r.error ?? 'No se pudo restaurar.');
      setNote(r.message ?? 'Listo.');
      reload();
      if (open) {
        const d = await backupDetailAction(appId, open);
        if (d.ok) setDetail(d.detail);
      }
    });
  }

  return (
    <div className="space-y-4">
      <section className={clsx(CARD, 'space-y-3')}>
        <div className="flex items-start gap-3">
          <DatabaseBackup className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-ink">Copias de esta aplicación</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Cada noche a las 2:00 a. m. y antes de publicar o migrar se guarda una foto:
              configuración, código y todas las filas de las tablas que usa. Se conservan 30 diarias
              y 90 días de las demás. Antes de restaurar siempre se hace otra copia.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={clsx(INPUT, 'min-w-0 flex-1')}
            placeholder="Motivo (opcional), p. ej. «antes de cargar los vuelos de noviembre»"
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
          />
          <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={make}>
            Hacer copia ahora
          </button>
        </div>
        <ErrorLine error={error} />
        {note && <p className="text-xs text-emerald">{note}</p>}
      </section>

      <section className={clsx(CARD, 'p-0')}>
        {backups === null ? (
          <p className="p-4 text-xs text-ink-muted">Cargando…</p>
        ) : backups.length === 0 ? (
          <p className="p-4 text-xs text-ink-muted">
            Todavía no hay copias. La primera llega esta noche, o hazla ahora.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {backups.map((b) => (
              <li key={b.id} className="p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={clsx(
                      'rounded-pill px-2 py-0.5 text-micro font-semibold',
                      KIND[b.kind]?.tone,
                    )}
                  >
                    {KIND[b.kind]?.label ?? b.kind}
                  </span>
                  {b.status === 'failed' && (
                    <span className="rounded-pill bg-rose-soft px-2 py-0.5 text-micro font-semibold text-rose">
                      Falló
                    </span>
                  )}
                  <span className="text-xs font-semibold text-ink">
                    {formatDateTime(b.createdAt)}
                  </span>
                  <span className="tabular text-micro text-ink-faint">
                    {b.status === 'ok'
                      ? `${rowsOf(b)} filas · ${Object.keys(b.tables).length} tablas · ${sizeOf(b.sizeBytes)}`
                      : ''}
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {b.status === 'ok' && (
                      <>
                        <a
                          className={BTN_SECONDARY}
                          href={`/api/apps/${appId}/backups/${b.id}/download?formato=xlsx`}
                        >
                          <Download className="h-3.5 w-3.5" /> Excel
                        </a>
                        <a
                          className={BTN_SECONDARY}
                          href={`/api/apps/${appId}/backups/${b.id}/download?formato=json`}
                        >
                          <Download className="h-3.5 w-3.5" /> JSON
                        </a>
                        <button
                          type="button"
                          className={BTN_SECONDARY}
                          disabled={pending}
                          onClick={() => view(b.id)}
                        >
                          {open === b.id ? 'Cerrar' : 'Ver y restaurar'}
                        </button>
                      </>
                    )}
                  </span>
                </div>
                {b.reason && <p className="mt-1 text-xs text-ink-muted">{b.reason}</p>}
                {open === b.id && (
                  <div className="mt-3">
                    {detail ? (
                      <Detail
                        detail={detail}
                        pending={pending}
                        onAsk={setAsk}
                        appId={appId}
                        backupId={b.id}
                      />
                    ) : (
                      <p className="text-xs text-ink-muted">Comparando con hoy…</p>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ask && (
        <dialog
          open
          className="fixed inset-0 z-50 m-0 grid h-full w-full max-w-none place-items-center bg-black/40 p-4"
        >
          <div className={clsx(CARD, 'w-full max-w-md space-y-3')}>
            <h3 className="text-sm font-semibold text-ink">{ask.title}</h3>
            <p className="text-xs text-ink-muted">{ask.text}</p>
            <p className="text-micro text-ink-faint">
              Antes de hacerlo se guarda una copia de cómo está hoy.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={pending}
                onClick={() => setAsk(null)}
              >
                Cancelar
              </button>
              <button type="button" className={BTN_DANGER} disabled={pending} onClick={confirm}>
                Sí, restaurar
              </button>
            </div>
          </div>
        </dialog>
      )}
    </div>
  );
}

function Detail({
  detail,
  pending,
  onAsk,
  appId,
  backupId,
}: {
  detail: BackupDetailView;
  pending: boolean;
  onAsk: (a: Ask) => void;
  appId: string;
  backupId: string;
}) {
  const cfg = detail.config;
  const cfgChanged = cfg.screensChanged.length + cfg.rolesChanged.length + cfg.automationsChanged;
  const code = detail.code;
  const codeChanged = code ? code.added.length + code.removed.length + code.changed.length : 0;
  return (
    <div className="space-y-4 rounded-card border border-border bg-canvas p-3">
      {detail.warnings.length > 0 && (
        <ul className="space-y-0.5 text-micro text-amber">
          {detail.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <div>
        <h3 className="text-xs font-semibold text-ink">Tablas (contra hoy)</h3>
        {detail.tables.length === 0 ? (
          <p className="mt-1 text-xs text-ink-muted">
            Esta app no usaba tablas cuando se hizo la copia.
          </p>
        ) : (
          <div className="mt-2 space-y-2">
            {detail.tables.map((t) => (
              <TableBlock
                key={t.slug}
                t={t}
                pending={pending}
                onAsk={onAsk}
                appId={appId}
                backupId={backupId}
              />
            ))}
          </div>
        )}
        {detail.appDbTables.length > 0 && (
          <p className="mt-2 text-micro text-ink-faint">
            Base propia incluida en la copia (sólo para descargar):{' '}
            {detail.appDbTables
              .map((t) => `${t.name} (${t.rows}${t.truncated ? '+' : ''})`)
              .join(', ')}
            .
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <p className="text-xs text-ink-muted">
          <span className="font-semibold text-ink">Configuración:</span> {cfg.screens} pantallas,{' '}
          {cfg.roles} roles, {cfg.automations} reglas.{' '}
          {cfgChanged
            ? `Cambiaron desde entonces: ${[...cfg.screensChanged, ...cfg.rolesChanged].join(', ') || 'reglas'}${cfg.automationsChanged ? ` · ${cfg.automationsChanged} regla(s)` : ''}.`
            : 'Igual que hoy.'}
        </p>
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={pending || !cfgChanged}
          onClick={() =>
            onAsk({
              title: 'Restaurar la configuración',
              text: `Pantallas, roles, reglas, avisos y ubicación vuelven a como estaban en esta copia (en el borrador; publica para que lo vean los usuarios). Hoy difieren: ${[...cfg.screensChanged, ...cfg.rolesChanged].join(', ') || 'las reglas'}${cfg.automationsChanged ? ` y ${cfg.automationsChanged} regla(s)` : ''}. Los datos de las tablas no se tocan.`,
              run: () => restoreConfigAction(appId, backupId),
            })
          }
        >
          <RotateCcw className="h-3.5 w-3.5" /> Restaurar configuración
        </button>
      </div>

      {code && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
          <p className="text-xs text-ink-muted">
            <span className="font-semibold text-ink">Código:</span> {code.files} archivos.{' '}
            {codeChanged
              ? `Hoy difieren ${codeChanged} (${code.changed.length} cambiados, ${code.added.length} nuevos, ${code.removed.length} borrados).`
              : 'Igual que hoy.'}{' '}
            Los secretos no se copian (
            {code.secretNames.length ? code.secretNames.join(', ') : 'ninguno'}).
          </p>
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={pending || !codeChanged}
            onClick={() =>
              onAsk({
                title: 'Restaurar el código',
                text: `El borrador del código vuelve a los ${code.files} archivos de esta copia: ${code.changed.length} cambian, ${code.added.length} se borran (son nuevos) y ${code.removed.length} se recrean. Lo publicado no cambia hasta que compiles y publiques.`,
                run: () => restoreCodeAction(appId, backupId),
              })
            }
          >
            <RotateCcw className="h-3.5 w-3.5" /> Restaurar código
          </button>
        </div>
      )}
    </div>
  );
}

function TableBlock({
  t,
  pending,
  onAsk,
  appId,
  backupId,
}: {
  t: TableDiffView;
  pending: boolean;
  onAsk: (a: Ask) => void;
  appId: string;
  backupId: string;
}) {
  const [more, setMore] = useState(false);
  const total = t.removed.count + t.changed.count + t.added.count;
  return (
    <div className="rounded-card border border-border bg-surface p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-ink">{t.slug}</span>
        <span className="tabular text-micro text-ink-faint">
          {t.unchanged + t.changed.count + t.removed.count} en la copia · {t.removed.count} borradas
          · {t.changed.count} cambiadas · {t.added.count} nuevas
        </span>
        <span className="ml-auto flex gap-1.5">
          {total > 0 && (
            <button type="button" className={BTN_SECONDARY} onClick={() => setMore(!more)}>
              {more ? 'Ocultar filas' : 'Ver filas'}
            </button>
          )}
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={pending || total === 0}
            onClick={() =>
              onAsk({
                title: `Restaurar la tabla «${t.slug}»`,
                text: `${t.restoreText} Las demás tablas no se tocan.`,
                run: () => restoreTableAction(appId, backupId, t.slug),
              })
            }
          >
            <RotateCcw className="h-3.5 w-3.5" /> Restaurar tabla
          </button>
        </span>
      </div>
      {more && (
        <div className="mt-2 space-y-2 text-xs">
          {t.removed.sample.length > 0 && (
            <RowList
              title="Borradas desde la copia"
              rows={t.removed.sample.map((r) => ({
                ...r,
                note: 'se vuelve a crear con el mismo id',
              }))}
              extra={t.removed.count - t.removed.sample.length}
              action={(r) =>
                onAsk({
                  title: 'Restaurar la fila',
                  text: `La fila «${r.label}» fue borrada: se vuelve a crear con el mismo id (1 fila). Nada más cambia.`,
                  run: () => restoreRowAction(appId, backupId, t.slug, r.id),
                })
              }
              pending={pending}
            />
          )}
          {t.changed.sample.length > 0 && (
            <RowList
              title="Cambiadas desde la copia"
              rows={t.changed.sample.map((r) => ({
                id: r.id,
                label: r.label,
                note: r.changes.map((c) => `${c.field}: ${c.was} → ${c.now} (hoy)`).join(' · '),
              }))}
              extra={t.changed.count - t.changed.sample.length}
              action={(r) =>
                onAsk({
                  title: 'Restaurar la fila',
                  text: `La fila «${r.label}» vuelve a sus valores de la copia (1 fila cambia). Nada más cambia.`,
                  run: () => restoreRowAction(appId, backupId, t.slug, r.id),
                })
              }
              pending={pending}
            />
          )}
          {t.added.sample.length > 0 && (
            <div>
              <p className="font-semibold text-ink">Nuevas desde la copia ({t.added.count})</p>
              <p className="text-micro text-ink-faint">
                {t.added.sample.map((r) => r.label).join(', ')}
                {t.added.count > t.added.sample.length ? '…' : ''}. Sólo «Restaurar tabla» las
                borra.
              </p>
            </div>
          )}
          {t.truncated && (
            <p className="text-micro text-amber">
              La copia de esta tabla es parcial: restaurar no borra filas nuevas.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RowList({
  title,
  rows,
  extra,
  action,
  pending,
}: {
  title: string;
  rows: Array<{ id: string; label: string; note: string }>;
  extra: number;
  action: (r: { id: string; label: string }) => void;
  pending: boolean;
}) {
  return (
    <div>
      <p className="font-semibold text-ink">{title}</p>
      <ul className="mt-1 divide-y divide-border rounded-card border border-border">
        {rows.map((r) => (
          <li key={r.id} className="flex items-center gap-2 px-2 py-1.5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-ink">{r.label}</p>
              <p className="truncate text-micro text-ink-faint">{r.note}</p>
            </div>
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={pending}
              onClick={() => action(r)}
            >
              Restaurar fila
            </button>
          </li>
        ))}
      </ul>
      {extra > 0 && (
        <p className="mt-1 text-micro text-ink-faint">
          y {extra} más (usa «Restaurar tabla» o descarga la copia).
        </p>
      )}
    </div>
  );
}
