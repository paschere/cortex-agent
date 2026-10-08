/**
 * BUSCAR UNA CARPETA POR NOMBRE, SIN QUE IMPORTE CÓMO LA ESCRIBIÓ QUIEN LA CREÓ.
 *
 * La empresa crea las carpetas a mano («AV 204 – 12 oct», «045-12345678 Nexa»,
 * «guia 04512345678»): nadie respeta mayúsculas, guiones ni espacios. Lo que se
 * busca («AV204», «045-12345678») tiene que encontrarlas igual. Este módulo es
 * PURO (sin red) para probarlo entero.
 *
 * Tres escalones, en orden; el primero que da algo decide:
 *   1. igual, ya sin mayúsculas, tildes ni separadores;
 *   2. contiene lo buscado como palabra(s) completa(s), pegadas o no («AV204» o «AV 204» en «AV 204 - oct», pero no en «AV2045»);
 *   3. contiene lo buscado pegado («04512345678» dentro de «045-123456-78»).
 * Si el escalón que decide da UNA carpeta, es esa. Si da varias NO se adivina:
 * se devuelven como candidatas, porque subir un documento a la carpeta
 * equivocada es peor que no subirlo.
 */

export interface FolderRef {
  id: string;
  name: string;
}

/** Minúsculas, sin tildes, todo lo que no es letra o dígito pasa a espacio simple. */
export function spaced(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, ' ')
    .trim();
}

/** Lo mismo, sin ningún separador. */
export function compact(text: string): string {
  return spaced(text).replace(/ /g, '');
}

/** ¿Alguna tanda de palabras seguidas del nombre, pegadas, es justo lo buscado? («AV 204 - oct» ⊇ «av204») */
function hasTokenRun(spacedName: string, wantedCompact: string): boolean {
  const tokens = spacedName.split(' ').filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    let acc = '';
    for (let j = i; j < tokens.length && acc.length < wantedCompact.length; j++) {
      acc += tokens[j];
      if (acc === wantedCompact) return true;
    }
  }
  return false;
}

export type FolderPick =
  | { kind: 'found'; folder: FolderRef }
  | { kind: 'ambiguous'; candidates: FolderRef[] }
  | { kind: 'none' };

export function pickFolder(children: FolderRef[], wanted: string): FolderPick {
  const wc = compact(wanted);
  if (!wc) return { kind: 'none' };
  const tiers: Array<(f: FolderRef) => boolean> = [
    (f) => compact(f.name) === wc,
    (f) => hasTokenRun(spaced(f.name), wc),
    (f) => compact(f.name).includes(wc),
  ];
  for (const test of tiers) {
    const hits = children.filter(test);
    if (hits.length === 1) return { kind: 'found', folder: hits[0] as FolderRef };
    if (hits.length > 1) return { kind: 'ambiguous', candidates: hits.slice(0, 8) };
  }
  return { kind: 'none' };
}

/** Quita el sufijo de plantilla vacía: una ruta con un nivel en blanco no se busca. */
export function cleanLevels(levels: string[]): string[] {
  return levels.map((l) => l.trim()).filter((l) => compact(l) !== '');
}

export type PathResolution =
  | { found: true; folder: FolderRef; trail: FolderRef[] }
  | {
      found: false;
      reason: string;
      /** Hasta dónde se llegó. */
      trail: FolderRef[];
      candidates?: FolderRef[];
    };

/**
 * Baja por la ruta nivel a nivel. `listChildren(parentId)` devuelve las
 * subcarpetas directas (no los archivos). Nunca crea nada.
 */
export async function resolveFolderPath(
  listChildren: (parentId: string) => Promise<FolderRef[]>,
  root: FolderRef,
  levels: string[],
): Promise<PathResolution> {
  const wanted = cleanLevels(levels);
  if (wanted.length === 0) return { found: true, folder: root, trail: [root] };
  const trail: FolderRef[] = [root];
  let current = root;
  for (const level of wanted) {
    const children = await listChildren(current.id);
    const pick = pickFolder(children, level);
    if (pick.kind === 'none')
      return {
        found: false,
        reason: `No hay una carpeta que contenga «${level}» dentro de «${current.name}».`,
        trail,
      };
    if (pick.kind === 'ambiguous')
      return {
        found: false,
        reason: `Hay ${pick.candidates.length} carpetas que contienen «${level}» dentro de «${current.name}» (${pick.candidates
          .map((c) => `«${c.name}»`)
          .join(', ')}): no sé cuál es.`,
        trail,
        candidates: pick.candidates,
      };
    current = pick.folder;
    trail.push(current);
  }
  return { found: true, folder: current, trail };
}
