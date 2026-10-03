/**
 * UN LECTOR DE XML MÍNIMO, PURO Y SIN DEPENDENCIAS.
 *
 * Lo justo para leer una factura electrónica UBL 2.1 de la DIAN: elementos,
 * atributos, texto, CDATA, comentarios, instrucciones de proceso y las
 * entidades de siempre. Los prefijos de espacio de nombres se descartan
 * (`cbc:ID` → `ID`): en UBL el nombre local ya es inequívoco y cada emisor
 * escoge sus propios prefijos (`cbc:`, `ns2:`, ninguno).
 *
 * No valida esquemas ni firmas. No resuelve DTD ni entidades externas (así no
 * hay XXE ni «billion laughs»): una entidad desconocida se deja tal cual.
 * Un documento mal formado lanza `XmlError` con la posición.
 */

export interface XmlElement {
  /** Nombre local, sin prefijo. */
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** Texto directo del elemento (CDATA incluido), sin recortar. */
  text: string;
}

export class XmlError extends Error {}

/** Tope defensivo: una factura con 50 000 líneas no es una factura. */
const MAX_ELEMENTS = 200_000;

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

function localName(qname: string): string {
  const i = qname.indexOf(':');
  return i >= 0 ? qname.slice(i + 1) : qname;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    const name = m[1] as string;
    if (name === 'xmlns' || name.startsWith('xmlns:')) continue;
    out[localName(name)] = decodeEntities(m[3] ?? m[4] ?? '');
  }
  return out;
}

/** El documento como árbol; devuelve el elemento raíz. */
export function parseXml(input: string): XmlElement {
  const src = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  let count = 0;
  let i = 0;
  const n = src.length;

  const appendText = (t: string) => {
    const top = stack[stack.length - 1];
    if (top) top.text += t;
  };

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      appendText(decodeEntities(src.slice(i)));
      break;
    }
    if (lt > i) appendText(decodeEntities(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError(`Comentario sin cerrar en ${lt}.`);
      i = end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError(`CDATA sin cerrar en ${lt}.`);
      appendText(src.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (src.startsWith('<?', lt)) {
      const end = src.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError(`Instrucción sin cerrar en ${lt}.`);
      i = end + 2;
      continue;
    }
    if (src.startsWith('<!', lt)) {
      // DOCTYPE u otra declaración: se salta sin resolver nada.
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    // Una etiqueta: buscar su cierre respetando comillas.
    let j = lt + 1;
    let quote: string | null = null;
    for (; j < n; j++) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (j >= n) throw new XmlError(`Etiqueta sin cerrar en ${lt}.`);
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body.startsWith('/')) {
      const name = localName(body.slice(1).trim());
      const top = stack.pop();
      if (!top || top.name !== name) throw new XmlError(`Cierre </${name}> sin apertura en ${lt}.`);
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const m = inner.match(/^\s*([^\s/>]+)/);
    if (!m) throw new XmlError(`Etiqueta vacía en ${lt}.`);
    count++;
    if (count > MAX_ELEMENTS) throw new XmlError('El documento es demasiado grande.');
    const el: XmlElement = {
      name: localName(m[1] as string),
      attrs: parseAttrs(inner.slice((m[0] as string).length)),
      children: [],
      text: '',
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (!root) root = el;
    else throw new XmlError('Hay más de un elemento raíz.');
    if (!selfClosing) stack.push(el);
  }
  if (stack.length) throw new XmlError(`<${stack[stack.length - 1]?.name}> quedó sin cerrar.`);
  if (!root) throw new XmlError('No hay ningún elemento.');
  return root;
}

// ---------------------------------------------------------------------------
// Navegación
// ---------------------------------------------------------------------------

export function child(el: XmlElement | null | undefined, name: string): XmlElement | null {
  if (!el) return null;
  for (const c of el.children) if (c.name === name) return c;
  return null;
}

export function children(el: XmlElement | null | undefined, name: string): XmlElement[] {
  return el ? el.children.filter((c) => c.name === name) : [];
}

/** Bajar por una ruta `A/B/C` tomando el primer hijo de cada nombre. */
export function at(el: XmlElement | null | undefined, path: string): XmlElement | null {
  let cur: XmlElement | null = el ?? null;
  for (const part of path.split('/')) {
    if (!cur) return null;
    cur = child(cur, part);
  }
  return cur;
}

/** El texto recortado en esa ruta, o null si no está o está vacío. */
export function textAt(el: XmlElement | null | undefined, path: string): string | null {
  const t = at(el, path)?.text.trim();
  return t ? t : null;
}

/** Todos los descendientes con ese nombre, en orden de documento. */
export function descendants(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (e: XmlElement) => {
    for (const c of e.children) {
      if (c.name === name) out.push(c);
      walk(c);
    }
  };
  walk(el);
  return out;
}
