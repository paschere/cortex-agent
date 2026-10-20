'use client';

import { previewQuery } from '@/lib/apps/preview-query';
import { inspectRoleAction } from '@/lib/apps/review-actions';
import type { InspectReport } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, ExternalLink, FlaskConical, Monitor, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  INPUT,
  requiredAttributesOf,
} from './shared';

/**
 * «VER COMO…»: la app corriendo con los ojos de un rol.
 *
 * Elige un rol (Operario, Supervisor, Gerencia, Cliente externo… los que tenga la
 * app) y con qué datos mirar:
 *   - «Datos de prueba» (lo que abre por defecto): filas de ejemplo sacadas de
 *     los campos de cada tabla. Los formularios se validan con el rol y las
 *     reglas de verdad y muestran «se habría guardado esto», pero no escriben
 *     nada en las tablas.
 *   - «Datos reales»: las filas de verdad con el alcance del rol, sólo lectura.
 *     Un rol que filtra por un dato (el «Cliente» de un portal) pide además de
 *     QUIÉN: `&atr=cliente:Andina`.
 * Debajo, «Revisión de este rol»: la misma lista que Cortex consulta antes de
 * decir «listo» (`apps.inspect`): qué pantalla abre, qué controles pinta cada
 * formulario y qué problemas hay (un desplegable sin opciones, un campo
 * obligatorio que el rol no puede escribir…).
 */

type Mode = 'prueba' | 'reales';
const PHONE = { w: 390, h: 700 };

function ReviewCard({ appId, roleKey, tick }: { appId: string; roleKey: string; tick: number }) {
  const [report, setReport] = useState<InspectReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` vuelve a revisar al pedirlo
  useEffect(() => {
    let live = true;
    setReport(null);
    setError(null);
    inspectRoleAction(appId, roleKey, 'draft').then((res) => {
      if (!live) return;
      if (res.ok) {
        setReport(res.report);
        setVersion(res.publishedNumber);
      } else setError(res.error);
    });
    return () => {
      live = false;
    };
  }, [appId, roleKey, tick]);
  if (error) return <p className="text-xs text-rose">{error}</p>;
  if (!report) return <p className="text-xs text-ink-muted">Revisando lo que ve este rol…</p>;
  const forms = report.screens.flatMap((s) =>
    s.blocks.filter((b) => b.fields?.length).map((b) => ({ screen: s.title, block: b })),
  );
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 text-sm font-semibold text-ink">
        {report.problems.length ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
        ) : (
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald" aria-hidden />
        )}
        {report.problems.length
          ? `${report.problems.length} ${report.problems.length === 1 ? 'problema' : 'problemas'} para ${report.role.name}`
          : `Sin problemas para ${report.role.name}`}
      </p>
      {report.problems.length > 0 && (
        <ul className="space-y-1.5">
          {report.problems.map((p) => (
            <li key={p} className="rounded-sm bg-amber-soft px-3 py-2 text-xs leading-relaxed text-ink">
              {p}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-ink-muted">
        Abre en: {report.screens.find((s) => s.slug === report.startScreen)?.title ?? 'nada (no ve pantallas)'} ·
        Ve {report.screens.length} {report.screens.length === 1 ? 'pantalla' : 'pantallas'}
        {report.hiddenScreens.length ? ` (no ve: ${report.hiddenScreens.join(', ')})` : ''}.
        {version === null
          ? ' La app nunca se ha publicado.'
          : ` Esto es el borrador; los usuarios ven la versión ${version} hasta que publiques.`}
      </p>
      {forms.map(({ screen, block }) => (
        <details key={`${screen}:${block.id}`} className="rounded-card border border-border bg-surface-2/50 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-ink">
            Formulario «{block.title ?? block.label}» en «{screen}» · {block.fields?.length} campos
            {block.canCreate ? '' : ' · este rol NO puede registrar'}
          </summary>
          <ul className="mt-2 space-y-1">
            {block.fields?.map((f) => (
              <li key={f.key} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                <span className="font-semibold text-ink">
                  {f.label}
                  {f.required ? ' *' : ''}
                </span>
                <span className={clsx(f.options === 0 ? 'font-semibold text-rose' : 'text-ink-muted')}>
                  {f.control}
                </span>
                {!f.writable && <span className="text-ink-faint">· solo lectura para este rol</span>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}

export function PreviewTab({ data }: { data: AppEditorData }) {
  const { app, roles, attributeValues } = data;
  const [roleKey, setRoleKey] = useState(roles[0]?.key ?? '');
  const [mode, setMode] = useState<Mode>('prueba');
  const [phone, setPhone] = useState(true);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [tick, setTick] = useState(0);
  const role = roles.find((r) => r.key === roleKey);
  const needs = role ? requiredAttributesOf(role.permissions) : [];
  const attrs = Object.fromEntries(needs.map((a) => [a, (picked[`${roleKey}:${a}`] ?? '').trim()]));
  const ready = mode === 'prueba' || needs.every((a) => attrs[a]);
  const query = previewQuery(
    roleKey,
    mode === 'reales' ? attrs : undefined,
    mode === 'prueba' ? 'prueba' : null,
  );
  const src = `/apps/${app.slug}${query}`;
  // Dentro de la página, la app sin el espacio de trabajo alrededor (el mismo marco del panel del chat).
  const frameSrc = `/panel/apps/${app.slug}/vista${query}`;

  if (roles.length === 0)
    return (
      <section className={CARD}>
        <p className="text-xs text-ink-muted">
          Todavía no hay roles. Créalos en «Roles y permisos» para poder ver la app como cada uno.
        </p>
        <Link href={`/apps/${app.slug}`} className={`${BTN_PRIMARY} mt-3`}>
          Abrir como administrador
        </Link>
      </section>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <section className={`${CARD} space-y-4`}>
        <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
          Mira la aplicación exactamente como la ve cada rol: sus pantallas, sus campos y sus
          permisos. Con datos de prueba puedes llenar los formularios sin guardar nada.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-0 basis-44">
            <span className="mb-1 block text-micro font-semibold text-ink-muted">Ver como</span>
            <select
              value={roleKey}
              onChange={(e) => setRoleKey(e.target.value)}
              className={`${INPUT} w-full`}
            >
              {roles.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-1 rounded-pill border border-border bg-surface p-0.5">
            <button
              type="button"
              aria-pressed={mode === 'prueba'}
              onClick={() => setMode('prueba')}
              className={clsx(
                'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold',
                mode === 'prueba' ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Datos de prueba
            </button>
            <button
              type="button"
              aria-pressed={mode === 'reales'}
              onClick={() => setMode('reales')}
              className={clsx(
                'min-h-8 rounded-pill px-3 text-xs font-semibold',
                mode === 'reales' ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              Datos reales (solo lectura)
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-pill border border-border bg-surface p-0.5">
            <button
              type="button"
              aria-pressed={phone}
              onClick={() => setPhone(true)}
              className={clsx(
                'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold',
                phone ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Smartphone className="h-3.5 w-3.5" aria-hidden /> Teléfono
            </button>
            <button
              type="button"
              aria-pressed={!phone}
              onClick={() => setPhone(false)}
              className={clsx(
                'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold',
                !phone ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink',
              )}
            >
              <Monitor className="h-3.5 w-3.5" aria-hidden /> Ancho
            </button>
          </div>
        </div>
        {mode === 'reales' && needs.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {needs.map((a) => (
              <label key={a} className="min-w-0 basis-44">
                <span className="mb-1 block text-micro font-semibold text-ink-muted">
                  {a.charAt(0).toUpperCase() + a.slice(1).replace(/_/g, ' ')}
                </span>
                <input
                  value={picked[`${roleKey}:${a}`] ?? ''}
                  onChange={(e) => setPicked({ ...picked, [`${roleKey}:${a}`]: e.target.value })}
                  list={`ver-como-${roleKey}-${a}`}
                  placeholder="Elige o escribe"
                  className={`${INPUT} w-full`}
                />
                <datalist id={`ver-como-${roleKey}-${a}`}>
                  {(attributeValues[a] ?? []).map((v) => (
                    <option key={v} value={v} />
                  ))}
                </datalist>
              </label>
            ))}
          </div>
        )}
        {ready ? (
          <>
            <div className="flex justify-center">
              <div
                className={clsx(
                  'overflow-hidden bg-canvas',
                  phone
                    ? 'rounded-[2.25rem] border-[10px] border-ink/80 shadow-pop'
                    : 'w-full rounded-card border border-border shadow-card',
                )}
                style={phone ? { width: PHONE.w + 20 } : undefined}
              >
                <iframe
                  key={frameSrc}
                  title={`La app vista como ${role?.name ?? roleKey}`}
                  src={frameSrc}
                  className="block w-full border-0"
                  style={{ height: phone ? PHONE.h : 640 }}
                />
              </div>
            </div>
            <Link href={src} className={BTN_SECONDARY} target="_blank" rel="noreferrer">
              <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Abrir en pantalla completa
            </Link>
          </>
        ) : (
          <p className="text-xs text-ink-faint">
            Elige {needs.length === 1 ? 'el dato' : 'los datos'} para ver como {role?.name}.
          </p>
        )}
        <Link href={`/apps/${app.slug}`} className={BTN_SECONDARY}>
          Abrir como administrador
        </Link>
      </section>

      <section className={`${CARD} space-y-3 self-start`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">Revisión de este rol</h3>
          <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setTick(tick + 1)}>
            Volver a revisar
          </button>
        </div>
        <ReviewCard appId={app.id} roleKey={roleKey} tick={tick} />
      </section>
    </div>
  );
}
