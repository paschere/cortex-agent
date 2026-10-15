import { blockedUrlReason } from '../../../packages/agent-tools/src/browser/chrome/domain';
import {
  LIMITS,
  type PageElement,
  type PageView,
  looksSensitive,
  resolveElement,
} from '../../../packages/agent-tools/src/browser/chrome/protocol';
import type { ToContent } from './lib';

/**
 * EL SCRIPT DE LA PÁGINA.
 *
 * Se inyecta (chrome.scripting) solo en pestañas de sitios que la persona
 * aprobó, y solo habla con el service worker de la extensión. Hace tres cosas:
 *   1. MIRAR: arma el esquema de la página (elementos con ref e1, e2…) como
 *      lo haría un lector de pantalla. Un campo de clave, tarjeta o código
 *      sale marcado `sensitive` y SIN valor, siempre.
 *   2. ACTUAR sobre un elemento por ref + nombre. Resuelve la ref contra una
 *      mirada fresca y verifica el nombre: si la página cambió, no hace nada.
 *      Jamás escribe en un campo sensible.
 *   3. PINTAR la franja «Cortex está trabajando aquí · Detener» y las
 *      peticiones de ayuda o de secreto. Vive en un shadow root cerrado y solo
 *      obedece clics de verdad (`isTrusted`): la página no puede apretar
 *      «Detener» ni «Ya terminé» por la persona.
 */

declare global {
  interface Window {
    __cortexChromeLoaded?: boolean;
  }
}

const SELECTOR = [
  'a[href]',
  'button',
  'input:not([type=hidden])',
  'select',
  'textarea',
  'summary',
  '[role=button]',
  '[role=link]',
  '[role=checkbox]',
  '[role=radio]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=option]',
  '[role=combobox]',
  '[role=switch]',
  '[contenteditable=""]',
  '[contenteditable=true]',
].join(',');

const refMap = new Map<string, Element>();
/** Campos que la persona escribió por petición de Cortex: nunca se leen ni se llenan. */
const protectedFields = new WeakSet<Element>();
let hostEl: HTMLElement | null = null;
let shadow: ShadowRoot | null = null;
let banner: {
  sessionId: string;
  message: string | null;
  awaitKind: 'help' | 'secret' | null;
} | null = null;
let highlighted: { el: HTMLElement; outline: string; offset: string } | null = null;

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function visible(el: Element): boolean {
  if (hostEl && (el === hostEl || hostEl.contains(el))) return false;
  const h = el as HTMLElement;
  if (!h.getClientRects || h.getClientRects().length === 0) return false;
  const st = getComputedStyle(h);
  if (st.visibility === 'hidden' || st.display === 'none') return false;
  if (h.closest('[aria-hidden=true]')) return false;
  return true;
}

function labelText(el: Element): string {
  const input = el as HTMLInputElement;
  const parts: string[] = [];
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    for (const id of labelledby.split(/\s+/)) {
      const t = document.getElementById(id)?.textContent;
      if (t) parts.push(t);
    }
  }
  if (input.labels) for (const l of Array.from(input.labels)) parts.push(l.textContent ?? '');
  return parts.join(' ');
}

function nameOf(el: Element): string {
  const input = el as HTMLInputElement;
  const aria = el.getAttribute('aria-label');
  if (aria) return clip(aria, LIMITS.nameMax);
  const label = clip(labelText(el), LIMITS.nameMax);
  if (label) return label;
  if (input.placeholder) return clip(input.placeholder, LIMITS.nameMax);
  const title = el.getAttribute('title') ?? el.getAttribute('alt');
  if (title) return clip(title, LIMITS.nameMax);
  const type = (input.type ?? '').toLowerCase();
  if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(type) && input.value) {
    return clip(input.value, LIMITS.nameMax);
  }
  const text = (el as HTMLElement).innerText ?? el.textContent ?? '';
  if (text.trim()) return clip(text, LIMITS.nameMax);
  return clip(input.name ?? input.id ?? '', LIMITS.nameMax);
}

function roleOf(el: Element): string {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName.toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type ?? 'text').toLowerCase();
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'search') return 'searchbox';
    return 'textbox';
  }
  return 'generic';
}

function isSensitive(el: Element): boolean {
  if (protectedFields.has(el)) return true;
  const input = el as HTMLInputElement;
  return looksSensitive({
    type: input.type ?? null,
    autocomplete: el.getAttribute('autocomplete'),
    name: input.name ?? null,
    id: el.id || null,
    label: `${el.getAttribute('aria-label') ?? ''} ${labelText(el)} ${input.placeholder ?? ''}`,
  });
}

function fieldValue(el: Element): string | undefined {
  const tag = el.tagName;
  if (tag === 'SELECT') {
    const sel = el as HTMLSelectElement;
    return clip(sel.selectedOptions[0]?.textContent ?? '', 80) || undefined;
  }
  if (tag === 'INPUT') {
    const input = el as HTMLInputElement;
    if (input.type === 'checkbox' || input.type === 'radio')
      return input.checked ? 'marcado' : 'sin marcar';
    if (['submit', 'button', 'reset', 'file', 'image'].includes(input.type)) return undefined;
    return clip(input.value, 80) || undefined;
  }
  if (tag === 'TEXTAREA') return clip((el as HTMLTextAreaElement).value, 80) || undefined;
  return undefined;
}

function scan(): PageElement[] {
  refMap.clear();
  const out: PageElement[] = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(SELECTOR))) {
    if (out.length >= LIMITS.elements) break;
    if (!visible(el)) continue;
    n += 1;
    const ref = `e${n}`;
    refMap.set(ref, el);
    const sensitive = isSensitive(el);
    const value = sensitive ? undefined : fieldValue(el);
    const disabled =
      (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
    out.push({
      ref,
      role: roleOf(el),
      name: nameOf(el),
      ...(value ? { value } : {}),
      ...(disabled ? { disabled: true } : {}),
      ...(sensitive ? { sensitive: true } : {}),
    });
  }
  return out;
}

function pageText(): string {
  return (document.body?.innerText ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function pageView(): PageView {
  const elements = scan();
  const text = pageText();
  const headings = Array.from(document.querySelectorAll('h1,h2,h3'))
    .filter(visible)
    .slice(0, 10)
    .map((h) => clip(h.textContent ?? '', 120))
    .filter(Boolean);
  const alerts = Array.from(document.querySelectorAll('[role=alert],[aria-live=assertive]'))
    .filter(visible)
    .slice(0, 6)
    .map((a) => clip(a.textContent ?? '', 200))
    .filter(Boolean);
  return {
    url: location.href.slice(0, 2000),
    title: clip(document.title, 300),
    headings,
    alerts,
    text: clip(text, 20_000).slice(0, LIMITS.pageText),
    elements,
  };
}

type ActOutcome =
  | { ok: true }
  | {
      ok: false;
      code: 'stale' | 'secret_field' | 'blocked' | 'failed' | 'unsupported';
      error: string;
    };

function fail(code: Extract<ActOutcome, { ok: false }>['code'], error: string): ActOutcome {
  return { ok: false, code, error };
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function act(msg: Extract<ToContent, { type: 'cortex:act' }>): ActOutcome {
  if (msg.op === 'scroll') {
    window.scrollBy({ top: msg.dy ?? 0, behavior: 'instant' as ScrollBehavior });
    return { ok: true };
  }
  if (msg.op === 'press') {
    const key = msg.key ?? '';
    const target = (document.activeElement as HTMLElement | null) ?? document.body;
    if (isSensitive(target))
      return fail('secret_field', 'El foco está en un campo secreto; no se presiona nada ahí.');
    const init = { key, bubbles: true, cancelable: true } as KeyboardEventInit;
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    if (key === 'Enter') {
      const form = (target as HTMLInputElement).form;
      if (form && target.tagName === 'INPUT') form.requestSubmit();
      else if (target.tagName === 'BUTTON' || target.tagName === 'A') target.click();
    } else if (
      key === 'Space' &&
      (target.tagName === 'BUTTON' || (target as HTMLInputElement).type === 'checkbox')
    ) {
      target.click();
    }
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return { ok: true };
  }

  // Todo lo demás señala un elemento: mirada fresca + nombre, como en la nube.
  const elements = scan();
  const resolved = resolveElement(elements, msg.ref ?? '', msg.name ?? '');
  if ('stale' in resolved) return fail('stale', resolved.stale);
  const el = refMap.get(resolved.el.ref) as HTMLElement | undefined;
  if (!el || !el.isConnected)
    return fail('stale', 'El elemento desapareció. Mira la página de nuevo.');
  if (resolved.el.disabled) return fail('failed', 'Ese elemento está deshabilitado.');
  el.scrollIntoView({ block: 'center', inline: 'nearest' });

  if (msg.op === 'click') {
    if (el.tagName === 'A') {
      const href = (el as HTMLAnchorElement).href;
      const why = href ? blockedUrlReason(href, msg.protectedHosts) : null;
      if (why) return fail('blocked', `No hago clic en ese enlace: ${why}`);
    }
    if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') {
      return fail('unsupported', 'Subir archivos lo hace la persona, no Cortex.');
    }
    el.focus?.();
    el.click();
    return { ok: true };
  }

  if (msg.op === 'check') {
    const input = el as HTMLInputElement;
    const checkable =
      input.type === 'checkbox' ||
      input.type === 'radio' ||
      ['checkbox', 'radio', 'switch'].includes(el.getAttribute('role') ?? '');
    if (!checkable) return fail('failed', 'Ese elemento no es una casilla.');
    const on = input.type ? input.checked : el.getAttribute('aria-checked') === 'true';
    if (!on) el.click();
    return { ok: true };
  }

  if (msg.op === 'select') {
    if (isSensitive(el)) return fail('secret_field', 'Ese campo es secreto.');
    if (el.tagName !== 'SELECT')
      return fail(
        'unsupported',
        'No es una lista desplegable: haz clic para abrirla y elige la opción.',
      );
    const sel = el as HTMLSelectElement;
    const want = (msg.text ?? '').trim().toLowerCase();
    const opt =
      Array.from(sel.options).find(
        (o) =>
          o.value.toLowerCase() === want || (o.textContent ?? '').trim().toLowerCase() === want,
      ) ?? Array.from(sel.options).find((o) => (o.textContent ?? '').toLowerCase().includes(want));
    if (!opt || !want) return fail('failed', 'No encontré esa opción en la lista.');
    sel.value = opt.value;
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  // fill
  if (isSensitive(el)) {
    return fail(
      'secret_field',
      'Ese campo es de una clave o dato secreto: usa browser.request_secret para que la persona lo escriba.',
    );
  }
  const input = el as HTMLInputElement;
  if (input.type === 'file') return fail('unsupported', 'Subir archivos lo hace la persona.');
  if (input.readOnly) return fail('failed', 'Ese campo es de solo lectura.');
  el.focus?.();
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
    setNativeValue(input, msg.text ?? '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }
  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, msg.text ?? '');
    return { ok: true };
  }
  return fail('failed', 'Ese elemento no admite texto.');
}

// ---------------------------------------------------------------------------
// La franja
// ---------------------------------------------------------------------------

const BANNER_CSS = `
:host{all:initial}
.bar{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;
 max-width:min(560px,calc(100vw - 24px));padding:7px 8px 7px 14px;border-radius:999px;background:#232119;color:#f7f5ef;
 font:600 13px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;box-shadow:0 8px 28px rgba(35,33,28,.35)}
.dot{width:8px;height:8px;border-radius:50%;background:#5ddba0;flex:none;animation:p 1.6s ease-in-out infinite}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
@keyframes p{50%{opacity:.35}}
.msg{min-width:0;overflow-wrap:anywhere}
button{all:unset;cursor:pointer;flex:none;border-radius:999px;padding:6px 12px;font:700 12px/1 system-ui,sans-serif}
.stop{background:#c23a52;color:#fff}.done{background:#f6e7a4;color:#232119}
button:focus-visible{outline:2px solid #fff;outline-offset:2px}`;

function ensureHost(): ShadowRoot {
  if (shadow && hostEl?.isConnected) return shadow;
  hostEl = document.createElement('div');
  hostEl.setAttribute('data-cortex-banner', '1');
  hostEl.style.cssText = 'all:initial;position:fixed;top:0;left:0;z-index:2147483647;';
  shadow = hostEl.attachShadow({ mode: 'closed' });
  (document.documentElement ?? document.body).appendChild(hostEl);
  return shadow;
}

function sendBg(msg: unknown) {
  chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function renderBanner() {
  if (!banner) {
    hostEl?.remove();
    hostEl = null;
    shadow = null;
    return;
  }
  const root = ensureHost();
  root.replaceChildren();
  const style = document.createElement('style');
  style.textContent = BANNER_CSS;
  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'status');
  const dot = document.createElement('span');
  dot.className = 'dot';
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = banner.message ?? 'Cortex está trabajando aquí';
  bar.append(dot, msg);
  const sessionId = banner.sessionId;
  if (banner.awaitKind) {
    const done = document.createElement('button');
    done.className = 'done';
    done.type = 'button';
    done.textContent = banner.awaitKind === 'secret' ? 'Ya lo escribí' : 'Ya terminé';
    done.addEventListener('click', (ev) => {
      if (!ev.isTrusted) return;
      sendBg({ type: 'person-done', sessionId });
    });
    bar.append(done);
  }
  const stop = document.createElement('button');
  stop.className = 'stop';
  stop.type = 'button';
  stop.textContent = 'Detener';
  stop.addEventListener('click', (ev) => {
    if (!ev.isTrusted) return;
    sendBg({ type: 'stop', sessionId });
  });
  bar.append(stop);
  root.append(style, bar);
}

function unhighlight() {
  if (highlighted) {
    highlighted.el.style.outline = highlighted.outline;
    highlighted.el.style.outlineOffset = highlighted.offset;
    highlighted = null;
  }
}

function highlight(el: HTMLElement) {
  unhighlight();
  highlighted = { el, outline: el.style.outline, offset: el.style.outlineOffset };
  el.style.outline = '3px solid #f2b705';
  el.style.outlineOffset = '2px';
  el.scrollIntoView({ block: 'center' });
  el.focus?.();
}

function protect(el: Element) {
  protectedFields.add(el);
  // Que ni una foto de la pantalla muestre lo que la persona escriba.
  (el as HTMLElement).style.setProperty('-webkit-text-security', 'disc', 'important');
}

// ---------------------------------------------------------------------------
// Mensajes
// ---------------------------------------------------------------------------

if (!window.__cortexChromeLoaded) {
  window.__cortexChromeLoaded = true;
  chrome.runtime.onMessage.addListener((raw: ToContent, sender, sendResponse) => {
    // Solo el service worker de ESTA extensión.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    switch (raw.type) {
      case 'cortex:read': {
        const page = pageView();
        const text = pageText();
        const offset = Math.max(0, raw.offset);
        const chunk = text.slice(offset, offset + LIMITS.readChunk);
        const next = offset + chunk.length < text.length ? offset + chunk.length : null;
        sendResponse({
          page,
          content: { text: chunk, offset, nextOffset: next, total: text.length },
        });
        return false;
      }
      case 'cortex:act':
        try {
          sendResponse(act(raw));
        } catch (err) {
          sendResponse(fail('failed', `No se pudo: ${(err as Error).message.slice(0, 200)}`));
        }
        return false;
      case 'cortex:secret': {
        const elements = scan();
        const resolved = resolveElement(elements, raw.ref, raw.name);
        if ('stale' in resolved) {
          sendResponse(fail('stale', resolved.stale));
          return false;
        }
        const el = refMap.get(resolved.el.ref) as HTMLElement | undefined;
        if (!el) {
          sendResponse(fail('stale', 'El campo desapareció.'));
          return false;
        }
        protect(el);
        highlight(el);
        banner = {
          sessionId: raw.sessionId,
          awaitKind: 'secret',
          message: `Escribe «${clip(raw.label, 80)}» en el campo resaltado. Cortex no lo verá.`,
        };
        renderBanner();
        sendResponse({ ok: true });
        return false;
      }
      case 'cortex:help':
        banner = {
          sessionId: raw.sessionId,
          awaitKind: 'help',
          message: `Cortex te pide ayuda: ${clip(raw.reason, 160)}`,
        };
        renderBanner();
        sendResponse({ ok: true });
        return false;
      case 'cortex:banner':
        banner = raw.on
          ? { sessionId: raw.sessionId, awaitKind: null, message: raw.message ?? null }
          : null;
        if (!raw.on) unhighlight();
        renderBanner();
        sendResponse({ ok: true });
        return false;
      case 'cortex:clear-await':
        unhighlight();
        if (banner) {
          banner = { sessionId: banner.sessionId, awaitKind: null, message: null };
          renderBanner();
        }
        sendResponse({ ok: true });
        return false;
      default:
        return false;
    }
  });
}
