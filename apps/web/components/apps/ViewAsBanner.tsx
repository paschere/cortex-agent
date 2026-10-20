'use client';

import { previewQuery } from '@/lib/apps/preview-query';
import { FlaskConical } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * EL AVISO DE «VER COMO…»: quién se está mirando y con qué datos.
 *
 * Aparece arriba de cualquier pantalla de una app abierta por quien
 * administra con otro rol. Dice en claro «Estás viendo la app como Operario —
 * modo prueba» (con filas de ejemplo; los formularios se validan y no se
 * guardan) o, con datos reales, que es sólo lectura. Trae el selector de rol y
 * el de datos para cambiar sin volver al editor: la dirección lleva `?como=` y
 * `&modo=prueba`, así que se conserva al navegar entre pantallas.
 */

export interface ViewAsRole {
  key: string;
  name: string;
  /** Atributos del usuario que el rol necesita para ver filas (el «Cliente» de un portal). */
  needs: string[];
}

export interface ViewAsInfo {
  roles: ViewAsRole[];
  /** Con qué datos se mira: 'prueba' = filas de ejemplo; null = datos reales en sólo lectura. */
  mode: 'prueba' | null;
  /** Esta pantalla se pintó con datos de prueba (Inicio, tableros y portal no pueden). */
  sampled: boolean;
}

export function ViewAsBanner({
  roleKey,
  roleName,
  view,
  basePath,
  current,
  attributes,
  editHref,
}: {
  roleKey: string;
  roleName: string;
  view: ViewAsInfo;
  /** `/apps/<slug>` (o la base del panel). */
  basePath: string;
  current: string;
  attributes?: Record<string, string>;
  editHref: string;
}) {
  const router = useRouter();
  const test = view.mode === 'prueba';
  const go = (role: string, mode: 'prueba' | null) =>
    router.push(
      `${basePath}/${current}${previewQuery(role, role === roleKey ? attributes : undefined, mode)}`,
    );
  const needs = view.roles.find((r) => r.key === roleKey)?.needs ?? [];
  return (
    <output
      className={`view-no-print mb-4 block rounded-card border px-4 py-3 text-sm text-ink ${
        test ? 'border-sky/40 bg-sky-soft' : 'border-amber/40 bg-amber-soft'
      }`}
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          {test && <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />}
          <span>
            Estás viendo la app como {roleName}
            {test ? ' — modo prueba' : ' — datos reales, sólo lectura'}
          </span>
        </span>
        <Link href={editHref} className="text-xs font-semibold text-primary hover:underline">
          Volver al editor
        </Link>
      </span>
      <span className="mt-1 block text-xs font-normal text-ink-muted">
        {test
          ? view.sampled
            ? 'Filas de ejemplo: los formularios se validan como de verdad y muestran «se habría guardado esto», pero no se guarda nada.'
            : 'Esta pantalla no tiene datos de prueba y se muestra con datos reales en sólo lectura. Los formularios no escriben.'
          : 'Ves lo que ese rol vería con los datos de verdad. Nada se guarda.'}
        {!test && needs.length > 0 && !attributes?.[needs[0] as string]
          ? ` Este rol filtra por ${needs.join(', ')}: elige el dato en «Ver como…» del editor o usa los datos de prueba.`
          : ''}
      </span>
      <span className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 text-xs font-semibold text-ink-muted">
          Ver como
          <select
            value={roleKey}
            onChange={(e) => go(e.target.value, view.mode)}
            className="h-8 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink outline-none focus:border-primary"
          >
            {view.roles.map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <span className="flex items-center gap-1 rounded-pill border border-border bg-surface p-0.5">
          <button
            type="button"
            aria-pressed={test}
            onClick={() => go(roleKey, 'prueba')}
            className={`min-h-7 rounded-pill px-3 text-xs font-semibold ${test ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            Datos de prueba
          </button>
          <button
            type="button"
            aria-pressed={!test}
            onClick={() => go(roleKey, null)}
            className={`min-h-7 rounded-pill px-3 text-xs font-semibold ${!test ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:text-ink'}`}
          >
            Datos reales
          </button>
        </span>
      </span>
    </output>
  );
}
