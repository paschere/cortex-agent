import {
  MENTION_MIN_CHARS,
  type PaletteGroup,
  type PaletteItem,
  type PaletteResponse,
} from '@/lib/chat-palette-shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { listVisibleSpaces } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * QUÉ PUEDE ALCANZAR EL `@`, Y POR QUÉ ES ESTO Y NO LAS HERRAMIENTAS.
 *
 * El `@` nombra COSAS: aquello que una persona señala justo antes de preguntar
 * algo, y que Cortex después puede buscar por su nombre.
 *
 *   CLIENTES    — el eje del que cuelga todo lo demás. «@Coltrans» es cómo se
 *                 dice «ese, el que yo digo» cuando hay tres contrapartes con
 *                 nombres parecidos, y es la desambiguación más frecuente de
 *                 todo el producto.
 *   PERSONAS    — quién trabaja en ese cliente. Antes había que acordarse del
 *                 apellido; ahora se teclean tres letras.
 *   DOCUMENTOS  — un archivo concreto que ya está en Brain Knowledge, cuando la
 *                 pregunta es sobre ESE contrato y no sobre los contratos.
 *   ESPACIOS    — una tajada entera del cerebro, cuando la pregunta es «qué
 *                 sabemos aquí adentro».
 *   PLACAS      — un vehículo de la flota. Una placa es un nombre propio que
 *                 nadie se sabe de memoria y que se teclea mal la mitad de las
 *                 veces; ofrecerla es evitar una consulta al RUNT con la placa
 *                 equivocada.
 *
 * Lo que sigue SIN estar aquí, y por la misma razón de siempre: herramientas,
 * agentes y modelos. Nombrar una herramienta desde el `@` sería fijarla para el
 * turno y rodear la medición que hace funcionar al rankeador. El `/` ofrece las
 * herramientas de otra forma, y la diferencia importa: allí lo que se elige es
 * la FRASE con la que uno la pediría, que es texto plano y que el rankeador
 * sigue siendo libre de atender como quiera.
 *
 * Una mención se expande a texto plano dentro de la pregunta: `@Coltrans` se
 * vuelve el nombre del cliente. Es una ayuda para teclear, no un parámetro
 * escondido, así que nada de lo que hay aquí puede ensanchar lo que el modelo
 * ve.
 *
 * ===========================================================================
 * POR QUÉ ESTE SÍ BUSCA EN EL SERVIDOR (Y EL `/` NO)
 * ===========================================================================
 * Porque estas listas no están acotadas. Un espacio de trabajo tiene decenas de
 * rutinas y miles de clientes, contactos y documentos, y esa diferencia es toda
 * la decisión: lo acotado se trae una vez y se filtra en el navegador
 * (/api/chat/commands), y lo ilimitado se busca en la base con `ilike`, dos
 * letras mínimo y debounce en el compositor.
 *
 * Sólo pueden volver las filas de este espacio de trabajo: `getOrgScopedClient`
 * filtra cada lectura, y los espacios además pasan por `listVisibleSpaces`, que
 * muestra los de la empresa más los propios y los de nadie más.
 */

const PER_KIND = 5;

/** Postgres trata esto como comodines; quien los teclea los quiere literales. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Cada sección se lee por separado y ninguna puede tumbar a las demás. Pero un
 * fallo tampoco se disfraza de lista vacía: la sección viaja con su `error` y
 * el menú lo dibuja. «No hay clientes que se llamen así» y «no pude leer los
 * clientes» son dos respuestas distintas, y la segunda escrita como la primera
 * es cómo alguien acaba creando por segunda vez un cliente que ya existe.
 */
type Section = Omit<PaletteGroup, 'items'> & { items: PaletteItem[] };

function failed(group: Omit<PaletteGroup, 'items'>, error: string): Section {
  return { ...group, items: [], error };
}

async function readClients(db: SupabaseClient, pattern: string): Promise<Section> {
  const head = { id: 'clientes', heading: 'Clientes', icon: 'Building2' };
  const { data, error } = await db
    .from('clients')
    .select('id, name, city')
    .ilike('name', pattern)
    .neq('status', 'blocked')
    .order('name')
    .limit(PER_KIND);
  if (error) {
    console.error('[chat/mentions] clients read failed:', error);
    return failed(head, 'No pude leer los clientes.');
  }
  return {
    ...head,
    items: (data ?? []).map((row) => ({
      id: row.id as string,
      label: row.name as string,
      hint: (row.city as string | null) ?? null,
      expands: `${row.name as string} `,
    })),
  };
}

/**
 * El directorio de personas es `client_contacts`, no la API de Google.
 *
 * `people.search` existe y llega más lejos —todo el directorio de Workspace—
 * pero es una llamada HTTP autenticada por OAuth, con refresco de token, contra
 * un servicio de Google. Colgarla de un menú que se dispara al teclear serían
 * varias llamadas por segundo por persona escribiendo, sujetas a la cuota de la
 * organización y con un tiempo de respuesta que no cabe entre dos teclas. Lo
 * que sí cabe es la tabla propia: son las personas de los clientes de esta
 * empresa, que es justo a quien se nombra en una conversación de trabajo.
 */
async function readContacts(db: SupabaseClient, pattern: string): Promise<Section> {
  const head = { id: 'personas', heading: 'Personas', icon: 'User' };
  const { data, error } = await db
    .from('client_contacts')
    .select('id, full_name, role_title, clients(name)')
    .ilike('full_name', pattern)
    .eq('status', 'active')
    .order('is_primary', { ascending: false })
    .limit(PER_KIND);
  if (error) {
    console.error('[chat/mentions] client_contacts read failed:', error);
    return failed(head, 'No pude leer las personas.');
  }
  return {
    ...head,
    items: (data ?? []).map((row) => {
      const raw = row as unknown as {
        id: string;
        full_name: string;
        role_title: string | null;
        clients: { name: string } | { name: string }[] | null;
      };
      const client = Array.isArray(raw.clients) ? raw.clients[0] : raw.clients;
      return {
        id: raw.id,
        label: raw.full_name,
        hint: [raw.role_title, client?.name].filter(Boolean).join(' · ') || null,
        expands: `${raw.full_name} `,
      };
    }),
  };
}

async function readDocuments(db: SupabaseClient, pattern: string): Promise<Section> {
  const head = { id: 'documentos', heading: 'Documentos', icon: 'FileText' };
  const { data, error } = await db
    .from('kb_documents')
    .select('id, title')
    .ilike('title', pattern)
    // Un documento que todavía se está leyendo no se puede citar, así que
    // ofrecerlo prometería algo que el siguiente turno no puede cumplir.
    .eq('status', 'ready')
    .order('created_at', { ascending: false })
    .limit(PER_KIND);
  if (error) {
    console.error('[chat/mentions] kb_documents read failed:', error);
    return failed(head, 'No pude leer los documentos.');
  }
  return {
    ...head,
    items: (data ?? []).map((row) => ({
      id: row.id as string,
      label: row.title as string,
      hint: 'en Brain Knowledge',
      expands: `${row.title as string} `,
    })),
  };
}

async function readSpaces(db: SupabaseClient, userId: string, raw: string): Promise<Section> {
  const head = { id: 'espacios', heading: 'Espacios de memoria', icon: 'Layers' };
  try {
    const all = await listVisibleSpaces(db, userId);
    const needle = raw.toLowerCase();
    return {
      ...head,
      items: all
        .filter((space) => space.name.toLowerCase().includes(needle))
        .slice(0, PER_KIND)
        .map((space) => ({
          id: space.id,
          label: space.name,
          hint: space.kind === 'personal' ? 'tus propias notas' : 'espacio de la empresa',
          expands: `${space.name} `,
        })),
    };
  } catch (err) {
    console.error('[chat/mentions] spaces read failed:', err);
    return failed(head, 'No pude leer los espacios.');
  }
}

/**
 * Las placas son de la persona, no del espacio de trabajo: `vehicles.list` y
 * `vehicles.get` filtran por `user_id`, así que ofrecer la placa de un colega
 * sería ofrecer un nombre que la herramienta del siguiente turno no encuentra.
 */
async function readVehicles(db: SupabaseClient, userId: string, raw: string): Promise<Section> {
  const head = { id: 'placas', heading: 'Placas', icon: 'Car' };
  // `or()` es una mini-sintaxis con comas y paréntesis, así que un término con
  // uno de esos caracteres no se escapa: se descarta. Una placa o el apodo de
  // un carro no llevan puntuación, y romper el filtro entero por un paréntesis
  // tecleado de más sería cambiar una sección vacía por un 400.
  const term = raw.replace(/[^\p{L}\p{N}\s-]/gu, '').trim();
  if (term.length < MENTION_MIN_CHARS) return { ...head, items: [] };
  const pattern = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const { data, error } = await db
    .from('vehicles')
    .select('id, plate, label, brand, line')
    .eq('user_id', userId)
    .eq('archived', false)
    .or(`plate.ilike.${pattern},label.ilike.${pattern}`)
    .order('plate')
    .limit(PER_KIND);
  if (error) {
    console.error('[chat/mentions] vehicles read failed:', error);
    return failed(head, 'No pude leer los vehículos.');
  }
  return {
    ...head,
    items: (data ?? []).map((row) => {
      const plate = row.plate as string;
      return {
        id: row.id as string,
        label: plate,
        hint:
          [row.label as string | null, [row.brand, row.line].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join(' · ') || null,
        expands: `${plate} `,
      };
    }),
  };
}

export async function GET(req: NextRequest): Promise<NextResponse<PaletteResponse>> {
  const raw = (req.nextUrl.searchParams.get('q') ?? '').trim();
  const user = await requireSession();

  // Una sola letra empareja con casi todo y la lista es ruido. Dos es donde un
  // nombre empieza a estrechar.
  if (raw.length < MENTION_MIN_CHARS) return NextResponse.json({ groups: [] });

  const db = getOrgScopedClient(user.organization.id);
  const pattern = `%${escapeLike(raw)}%`;

  const sections = await Promise.all([
    readClients(db, pattern),
    readContacts(db, pattern),
    readDocuments(db, pattern),
    readSpaces(db, user.id, raw),
    readVehicles(db, user.id, raw),
  ]);

  return NextResponse.json({
    groups: sections.filter((section) => section.items.length > 0 || section.error),
  });
}
