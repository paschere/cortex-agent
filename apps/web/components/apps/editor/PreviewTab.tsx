'use client';

import { previewQuery } from '@/lib/apps/preview-query';
import { Eye } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  INPUT,
  requiredAttributesOf,
} from './shared';

/**
 * «Ver como…»: la app corriendo con datos reales y los ojos de un rol.
 * Es sólo lectura (`?como=<rol>`): sirve para comprobar que cada rol ve lo
 * que debe antes de darle la app a nadie. Un rol que filtra filas por atributo
 * (el «Cliente» de un portal) pide además de QUIÉN: «Ver como cliente Andina»
 * (`&atr=cliente:Andina`), con los valores reales de esa columna.
 */
export function PreviewTab({ data }: { data: AppEditorData }) {
  const { app, roles, attributeValues } = data;
  const [picked, setPicked] = useState<Record<string, string>>({});
  return (
    <section className={`${CARD} space-y-4`}>
      <p className="max-w-2xl text-sm leading-relaxed text-ink-muted">
        Abre la aplicación como si fueras alguien de cada rol. Ves las pantallas y las filas que ese
        rol vería, sin poder escribir nada. Publicar o no sigue mandando para quien no administra.
      </p>
      {roles.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Todavía no hay roles. Créalos en «Roles y permisos» para poder verlos desde aquí.
        </p>
      ) : (
        <ul className="space-y-3">
          {roles.map((r) => {
            const needs = requiredAttributesOf(r.permissions);
            const attrs = Object.fromEntries(
              needs.map((a) => [a, (picked[`${r.key}:${a}`] ?? '').trim()]),
            );
            const ready = needs.every((a) => attrs[a]);
            return (
              <li key={r.key} className="flex flex-wrap items-end gap-2">
                {needs.map((a) => (
                  <label key={a} className="min-w-0 basis-44">
                    <span className="mb-1 block text-micro font-semibold text-ink-muted">
                      {a.charAt(0).toUpperCase() + a.slice(1).replace(/_/g, ' ')}
                    </span>
                    <input
                      value={picked[`${r.key}:${a}`] ?? ''}
                      onChange={(e) => setPicked({ ...picked, [`${r.key}:${a}`]: e.target.value })}
                      list={`ver-como-${r.key}-${a}`}
                      placeholder="Elige o escribe"
                      className={`${INPUT} w-full`}
                    />
                    <datalist id={`ver-como-${r.key}-${a}`}>
                      {(attributeValues[a] ?? []).map((v) => (
                        <option key={v} value={v} />
                      ))}
                    </datalist>
                  </label>
                ))}
                {ready ? (
                  <Link
                    href={`/apps/${app.slug}${previewQuery(r.key, attrs)}`}
                    className={BTN_SECONDARY}
                  >
                    <Eye className="h-3.5 w-3.5" aria-hidden /> Ver como {r.name}
                    {needs.length > 0 && ` ${Object.values(attrs).join(' · ')}`}
                  </Link>
                ) : (
                  <span className="text-micro text-ink-faint">
                    Elige {needs.length === 1 ? 'el dato' : 'los datos'} para ver como {r.name}.
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Link href={`/apps/${app.slug}`} className={BTN_PRIMARY}>
        Abrir como administrador
      </Link>
    </section>
  );
}
