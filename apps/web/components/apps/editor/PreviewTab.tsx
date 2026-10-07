'use client';

import { Eye } from 'lucide-react';
import Link from 'next/link';
import { type AppEditorData, BTN_PRIMARY, BTN_SECONDARY, CARD } from './shared';

/**
 * «Ver como…»: la app corriendo con datos reales y los ojos de un rol.
 * Es sólo lectura (`?como=<rol>`): sirve para comprobar que cada rol ve lo
 * que debe antes de darle la app a nadie.
 */
export function PreviewTab({ data }: { data: AppEditorData }) {
  const { app, roles } = data;
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
        <ul className="flex flex-wrap gap-2">
          {roles.map((r) => (
            <li key={r.key}>
              <Link
                href={`/apps/${app.slug}?como=${encodeURIComponent(r.key)}`}
                className={BTN_SECONDARY}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden /> Ver como {r.name}
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Link href={`/apps/${app.slug}`} className={BTN_PRIMARY}>
        Abrir como administrador
      </Link>
    </section>
  );
}
