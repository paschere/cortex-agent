'use client';

import { savePortalAction, suggestPortalAction } from '@/lib/apps/phase6-actions';
import type { ClientPortal } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { Sparkles } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { type AppEditorData, BTN_PRIMARY, BTN_SECONDARY, CARD, ErrorLine, INPUT } from './shared';

/**
 * «PORTAL» (0225): un rol «cliente» donde cada cliente ve SÓLO lo suyo. Se
 * configura qué tabla muestra sus envíos, cuál sus facturas, cuál sus documentos
 * y a qué tabla llegan los soportes que suba. El rol, la pantalla «Subir
 * soporte» y el aviso a la empresa se crean solos. Cada cliente se invita en
 * «Usuarios» con el rol y su cliente (el valor exacto de la columna).
 * «Pagar» sólo aparece si las facturas tienen una columna con el enlace de pago.
 */

type SectionKey = 'shipments' | 'invoices' | 'documents' | 'upload';
interface FieldDef {
  key: string;
  label: string;
  types?: string[];
  required?: boolean;
}

const SECTIONS: Array<{ key: SectionKey; label: string; help: string; fields: FieldDef[] }> = [
  {
    key: 'shipments',
    label: 'Envíos o pedidos',
    help: 'Lo que el cliente espera: estado y datos clave.',
    fields: [
      { key: 'clientField', label: 'Columna del cliente', required: true },
      { key: 'statusField', label: 'Columna de estado', types: ['select'] },
    ],
  },
  {
    key: 'invoices',
    label: 'Facturas y cartera',
    help: 'Lo que debe, con vencimientos.',
    fields: [
      { key: 'clientField', label: 'Columna del cliente', required: true },
      { key: 'amountField', label: 'Valor', types: ['money', 'number'] },
      { key: 'dueField', label: 'Vencimiento', types: ['date'] },
      { key: 'statusField', label: 'Estado (Pagada…)', types: ['select'] },
      { key: 'payUrlField', label: 'Enlace de pago (activa «Pagar»)', types: ['text'] },
    ],
  },
  {
    key: 'documents',
    label: 'Documentos para descargar',
    help: 'Certificados, contratos, guías en PDF.',
    fields: [
      { key: 'clientField', label: 'Columna del cliente', required: true },
      { key: 'fileField', label: 'Columna del archivo', types: ['file'], required: true },
      { key: 'labelField', label: 'Nombre a mostrar', types: ['text'] },
    ],
  },
  {
    key: 'upload',
    label: 'Subir soportes',
    help: 'Soporte de pago u otros archivos: llegan a una tabla tuya y te avisan.',
    fields: [
      { key: 'clientField', label: 'Columna del cliente', required: true },
      { key: 'fileField', label: 'Columna del archivo', types: ['file'], required: true },
      { key: 'noteField', label: 'Nota (opcional)', types: ['text', 'longtext'] },
      { key: 'kindField', label: 'Tipo (opcional)', types: ['select'] },
    ],
  },
];

const SELECT = `${INPUT} pr-7 w-full`;
type Cfg = Record<string, unknown> & { source: string };

export function PortalTab({ data }: { data: AppEditorData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const initial = data.portal;
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [roleKey, setRoleKey] = useState(initial?.roleKey ?? 'cliente');
  const [attribute, setAttribute] = useState(initial?.attribute ?? 'cliente');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [welcome, setWelcome] = useState(initial?.welcome ?? '');
  const [cfg, setCfg] = useState<Partial<Record<SectionKey, Cfg>>>({
    shipments: initial?.shipments as Cfg | undefined,
    invoices: initial?.invoices as Cfg | undefined,
    documents: initial?.documents as Cfg | undefined,
    upload: initial?.upload as Cfg | undefined,
  });
  const first = data.homeTrackers[0]?.slug ?? '';

  const clear = () => {
    setNote(null);
    setError(null);
  };
  const setSection = (k: SectionKey, v: Cfg | undefined) => {
    clear();
    setCfg((c) => ({ ...c, [k]: v }));
  };

  function apply(p: ClientPortal) {
    setEnabled(p.enabled);
    setRoleKey(p.roleKey);
    setAttribute(p.attribute);
    setCfg({
      shipments: p.shipments as Cfg | undefined,
      invoices: p.invoices as Cfg | undefined,
      documents: p.documents as Cfg | undefined,
      upload: p.upload as Cfg | undefined,
    });
  }

  function suggest() {
    clear();
    start(async () => {
      const res = await suggestPortalAction();
      if (!res.ok) return setError(res.error);
      apply({ ...res.portal, enabled });
      setNote('Armé una propuesta con tus tablas: revísala y guarda.');
    });
  }

  function save() {
    clear();
    start(async () => {
      const clean = (c?: Cfg) =>
        c
          ? Object.fromEntries(
              Object.entries(c).filter(
                ([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length),
              ),
            )
          : null;
      const res = await savePortalAction(data.app.id, {
        enabled,
        roleKey,
        attribute,
        title: title || null,
        welcome: welcome || null,
        shipments: clean(cfg.shipments),
        invoices: clean(cfg.invoices),
        documents: clean(cfg.documents),
        upload: clean(cfg.upload),
      });
      if (!res.ok) return setError(res.error);
      setNote(`Guardado en el borrador (${res.notes.join('; ') || 'sin cambios de estructura'}).`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className={clsx(CARD, 'space-y-3')}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-ink">Portal de clientes</h3>
            <p className="mt-0.5 text-xs text-ink-muted">
              Cada cliente entra con un código por correo y ve sólo sus filas. No cuenta como
              usuario del plan.
            </p>
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-ink">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                clear();
                setEnabled(e.target.checked);
              }}
            />
            Portal encendido
          </label>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-micro font-semibold text-ink-muted">
            Clave del rol de los clientes
            <input
              className={INPUT}
              value={roleKey}
              onChange={(e) => {
                clear();
                setRoleKey(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''));
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-micro font-semibold text-ink-muted">
            Atributo que dice de qué cliente es cada usuario
            <input
              className={INPUT}
              value={attribute}
              onChange={(e) => {
                clear();
                setAttribute(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''));
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-micro font-semibold text-ink-muted">
            Título del portal (opcional)
            <input
              className={INPUT}
              maxLength={60}
              value={title}
              onChange={(e) => {
                clear();
                setTitle(e.target.value);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-micro font-semibold text-ink-muted">
            Mensaje de bienvenida (opcional)
            <input
              className={INPUT}
              maxLength={240}
              value={welcome}
              onChange={(e) => {
                clear();
                setWelcome(e.target.value);
              }}
            />
          </label>
        </div>
        <p className="text-xs text-ink-faint">
          Los colores y el logo son los de la pestaña «Apariencia». Para invitar: pestaña
          «Usuarios», rol «{roleKey}» y{` ${attribute} = `}el nombre del cliente tal como está en la
          tabla.
        </p>
      </div>

      {SECTIONS.map((sec) => {
        const c = cfg[sec.key];
        const tracker = c ? data.homeTrackers.find((t) => t.slug === c.source) : undefined;
        return (
          <section key={sec.key} className={clsx(CARD, 'space-y-3')}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={Boolean(c)}
                onChange={(e) =>
                  setSection(sec.key, e.target.checked ? { source: first } : undefined)
                }
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{sec.label}</span>
                <span className="block text-xs text-ink-muted">{sec.help}</span>
              </span>
            </label>
            {c && (
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-micro font-semibold text-ink-muted">
                  Tabla
                  <select
                    className={SELECT}
                    value={c.source}
                    onChange={(e) => setSection(sec.key, { source: e.target.value })}
                  >
                    {data.homeTrackers.map((t) => (
                      <option key={t.slug} value={t.slug}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                {sec.fields.map((f) => (
                  <label
                    key={f.key}
                    className="flex flex-col gap-1 text-micro font-semibold text-ink-muted"
                  >
                    {f.label}
                    <select
                      className={SELECT}
                      value={String(c[f.key] ?? '')}
                      onChange={(e) =>
                        setSection(sec.key, { ...c, [f.key]: e.target.value || undefined })
                      }
                    >
                      <option value="">{f.required ? 'Elige…' : 'Ninguna'}</option>
                      {(tracker?.fields ?? [])
                        .filter((x) => !f.types || f.types.includes(x.type))
                        .map((x) => (
                          <option key={x.key} value={x.key}>
                            {x.label}
                          </option>
                        ))}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </section>
        );
      })}

      <ErrorLine error={error} />
      {note && (
        <p className="rounded-card bg-emerald-soft px-3 py-2 text-xs text-emerald">{note}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={BTN_SECONDARY} disabled={pending} onClick={suggest}>
          <Sparkles className="h-3.5 w-3.5" aria-hidden /> Proponer con mis tablas
        </button>
        <button type="button" className={BTN_PRIMARY} disabled={pending} onClick={save}>
          Guardar portal
        </button>
      </div>
    </div>
  );
}
