import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConstellationData, ConstellationDoc } from '../_components/types';

/**
 * Los datos de la constelación 3D, leídos en el servidor.
 *
 * POR QUÉ EL RPC Y NO UNA QUERY NUEVA. La escena necesita el conteo de
 * fragmentos POR DOCUMENTO, y ese agregado ya existe en `kb_brain_graph`
 * (migración 0062): es exactamente el mismo número que el mapa 2D dibuja como
 * elevación cuando entras a un espacio. Reusar la función mantiene una sola
 * fuente de verdad — si la constelación contara distinto que el mapa, una de
 * las dos estaría mintiendo — y respeta la regla de visibilidad
 * (`kb_visible_space_ids`) sin re-implementarla aquí.
 *
 * Se pide con `p_min_similarity: 2` y `p_max_edges: 0`: el coseno nunca supera
 * 1, así que ninguna arista califica y Postgres no paga el cálculo cuadrático
 * de pares — solo los nodos con su conteo, que es lo único que esta vista usa.
 *
 * El RPC solo devuelve documentos `ready`: la constelación dibuja lo que ya es
 * memoria, no lo que está en cola. Un documento sin indexar no tiene fragmentos
 * y una esfera de tamaño cero sería un punto que miente sobre su existencia.
 */

/**
 * Techo de documentos, los más recientes primero. Acota el trabajo del RPC
 * (centroides por documento) y el de la escena (una malla por esfera). Cuando
 * el corpus lo supera, `considered`/`total` dejan que la vista lo diga.
 */
const MAX_DOCUMENTS = 220;

interface RpcNode {
  id: string;
  title: string;
  chunks: number;
}

export async function readConstellation(
  db: SupabaseClient,
  userId: string,
  spaces: Array<{ id: string; name: string }>,
): Promise<ConstellationData | null> {
  if (spaces.length === 0) return { spaces: [], considered: 0, total: 0 };

  const { data, error } = await db.rpc('kb_brain_graph', {
    p_user_id: userId,
    p_space_ids: spaces.map((s) => s.id),
    p_sources: null,
    p_min_similarity: 2,
    p_max_documents: MAX_DOCUMENTS,
    p_max_edges: 0,
  });

  // Null y no un array vacío: «no se pudo leer» y «no hay nada» son respuestas
  // distintas, y la página esconde la vista en el primer caso en lugar de
  // mostrar un cielo vacío que parecería un cerebro sin memoria.
  if (error || !data) return null;

  const graph = data as { nodes?: RpcNode[]; considered?: number; total?: number };
  const nodes = graph.nodes ?? [];
  const considered = graph.considered ?? nodes.length;
  const total = graph.total ?? nodes.length;

  if (nodes.length === 0) return { spaces: [], considered, total };

  // El RPC responde «qué tan grande es cada documento» pero no «dónde vive»:
  // la misma segunda lectura que ya hace /api/kb/graph, por clave primaria y
  // sobre documentos que la función ya decidió que esta persona puede ver. Si
  // esta lectura falla, la respuesta entera es null — un cielo dibujado sin
  // saber dónde vive cada documento no sería un cielo a medias, sería mentira.
  const { data: filed, error: filedError } = await db
    .from('kb_documents')
    .select('id, collection_id, created_at')
    .in(
      'id',
      nodes.map((n) => n.id),
    );
  if (filedError) return null;

  const home = new Map(
    (filed ?? []).map(
      (r) =>
        [
          r.id as string,
          { spaceId: r.collection_id as string, createdAt: r.created_at as string },
        ] as const,
    ),
  );

  const bySpace = new Map<string, ConstellationDoc[]>();
  for (const node of nodes) {
    const where = home.get(node.id);
    if (!where) continue;
    const doc: ConstellationDoc = {
      id: node.id,
      title: node.title,
      chunkCount: node.chunks ?? 0,
      createdAt: where.createdAt,
    };
    bySpace.set(where.spaceId, [...(bySpace.get(where.spaceId) ?? []), doc]);
  }

  // Solo los espacios con documentos en memoria: un cúmulo vacío no es una
  // constelación, es un rótulo flotando en el negro. Orden por id para que el
  // payload sea idéntico entre visitas — el layout 3D se siembra de estos ids
  // y la estabilidad empieza por la estabilidad de la entrada.
  const withDocs = spaces
    .filter((s) => (bySpace.get(s.id)?.length ?? 0) > 0)
    .map((s) => ({
      id: s.id,
      name: s.name,
      documents: [...(bySpace.get(s.id) ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { spaces: withDocs, considered, total };
}
