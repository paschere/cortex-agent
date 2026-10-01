import { type ViewSummary, ViewsLibrary } from '@/components/views/gallery/ViewsLibrary';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { relativeTime } from '@/lib/views/studio';
import {
  BLOCK_LABEL,
  internalShareRefusal,
  internalSourcesOf,
  listTrackers,
  listViews,
  publicViewUrl,
  shareIsOpen,
} from '@cortex/agent-tools';

/**
 * Vistas: las pantallas que esta empresa se armó.
 *
 * El servidor lee las vistas y las resume para la estantería
 * (`ViewsLibrary`): la forma de cada una para su miniatura, su acento, quién
 * la tocó por última vez y lo que necesita el diálogo de compartir —el mismo
 * que la barra de la vista, con las mismas reglas: quién puede cambiarlo y por
 * qué una vista con fuentes internas no sale de Cortex—. No calcula ninguna:
 * la miniatura sale del spec.
 *
 * Las frases sugeridas para «Describir con Cortex» salen de las tablas que el
 * espacio ya tiene, para que el primer clic produzca algo con sus datos y no
 * un ejemplo de mentira.
 */

export const dynamic = 'force-dynamic';

export default async function ViewsPage() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const [views, trackers] = await Promise.all([listViews(db, 60), listTrackers(db, 6)]);

  // Quién editó cada una. Si el directorio no contesta, las tarjetas dicen
  // sólo cuándo: no vale la pena tumbar la lista por un nombre.
  const people = new Map<string, string>();
  const ids = [
    ...new Set(views.map((v) => v.updated_by ?? v.created_by).filter((id): id is string => !!id)),
  ];
  if (ids.length) {
    const { data } = await db.from('users').select('id,name,email').in('id', ids);
    for (const row of (data ?? []) as Array<{ id: string; name: string | null; email: string }>)
      people.set(
        row.id,
        row.id === user.id ? 'ti' : ((row.name?.trim() || row.email).split(' ')[0] ?? row.email),
      );
  }

  const now = new Date();
  const summaries: ViewSummary[] = views.map((v) => {
    const internal = internalSourcesOf(v.spec);
    const open = Boolean(v.share_token) && shareIsOpen(v);
    const theme = (v.spec as { theme?: { accent?: string } }).theme;
    const editorId = v.updated_by ?? v.created_by;
    return {
      id: v.id,
      slug: v.slug,
      name: v.name,
      description: v.description,
      blocks: v.spec.blocks.map((b) => ({ type: b.type, width: b.width })),
      accent: theme?.accent ?? v.spec.accent ?? 'primary',
      kinds: [...new Set(v.spec.blocks.map((b) => BLOCK_LABEL[b.type] ?? b.type))],
      pinned: v.pinned,
      visibility: v.visibility,
      expired: v.visibility !== 'workspace' && !shareIsOpen(v),
      mine: v.created_by === user.id,
      updatedAt: v.updated_at,
      createdAt: v.created_at,
      edited: relativeTime(v.updated_at, now),
      editor: editorId ? (people.get(editorId) ?? null) : null,
      share: {
        id: v.id,
        name: v.name,
        version: v.version,
        visibility: v.visibility,
        pinned: v.pinned,
        publicUrl: open && v.share_token ? publicViewUrl(v.share_token) : null,
        expiresAt: v.share_expires_at,
        opens: v.share_views,
        canManage: user.role === 'org_admin' || v.created_by === user.id,
        shareBlocked: internal.length ? internalShareRefusal(internal) : null,
      },
    };
  });

  const suggestions = trackers.length
    ? trackers
        .slice(0, 3)
        .map(
          (t) =>
            `Tablero de ${t.name.toLowerCase()} con las cifras clave, un gráfico y la lista completa`,
        )
        .concat('Un formulario público para que los clientes nos dejen solicitudes')
    : [
        'Seguimiento de solicitudes de clientes por estado, con un formulario para registrarlas',
        'Tablero de ventas del mes: total, por cliente y la lista de facturas',
        'Control de facturas de proveedores con las que vencen esta semana',
      ];

  return <ViewsLibrary views={summaries} suggestions={suggestions} />;
}
