import type { Frame, Page } from 'playwright';
import { framePath, stableFrameUrl } from './frame-path';
import { isResolved, resolveTarget } from './locators';
import { LOCATOR_INSTALL_SCRIPT } from './snapshot';
import type { Step, Target } from './types';

// No typed values cross this binding. Page scripts are untrusted: validate the
// shape again on the server, cap the trace, and never execute incoming code.
export const TEACH_SCRIPT = `${LOCATOR_INSTALL_SCRIPT}; (() => {
  if (window.__cortexTeachingInstalled) return;
  window.__cortexTeachingInstalled = true;
  const send = (event) => {
    if (!event.isTrusted) return;
    const el = event.target?.closest?.('input,textarea,select,button,a,[role="button"],[contenteditable="true"]');
    if (!el) return;
    const editable = el.matches('input,textarea,select,[contenteditable="true"]') && !['submit','button','reset'].includes(el.type);
    if (event.type === 'click' && editable) return;
    if (event.type === 'change' && el.tagName !== 'SELECT' && !['checkbox','radio','file'].includes(el.type)) return;
    if (event.type === 'keydown' && event.key !== 'Enter') return;
    if (event.type === 'keydown' && !editable) return;
    const secret = el.type === 'password' || /password|passwd|otp|one-time|secret|token|contrase|clave|verification|codigo|código/i.test([el.name,el.id,el.autocomplete,el.getAttribute('aria-label')].join(' '));
    let action = secret ? 'pause' : event.type === 'keydown' ? 'press' : editable ? el.tagName === 'SELECT' ? 'select' : el.type === 'checkbox' || el.type === 'radio' ? el.checked ? 'check' : 'uncheck' : el.type === 'file' ? 'pause' : 'fill' : 'click';
    // Never derive an editable label from its current value or content.
    const label = secret ? 'Completar verificación privada' : editable ? (el.labels?.[0]?.textContent || el.getAttribute('aria-label') || el.name || 'Campo').trim().slice(0,120) : (el.getAttribute('aria-label') || el.textContent || 'Continuar').trim().slice(0,120);
    const targets = secret ? [] : window.__cortexTargets(el).filter(t => !editable || !['text','role'].includes(t.kind)).slice(0,8);
    void window.__cortexTeachEvent({ action, label, targets }).catch(() => {});
  };
  // MODO «SEÑALAR RESULTADO». Mientras la bandera está encendida el clic no
  // actúa sobre el portal: se frena y se informa qué texto se señaló y cómo
  // volver a encontrarlo. Nunca viaja el valor de un campo ni una contraseña.
  const MARK_STYLE_ID = '__cortex_mark_style';
  const ensureMarkStyle = () => {
    if (document.getElementById(MARK_STYLE_ID) || !document.head) return;
    const style = document.createElement('style');
    style.id = MARK_STYLE_ID;
    style.textContent = '[data-cortex-mark-hover]{outline:3px solid #2563eb !important;outline-offset:1px !important;cursor:crosshair !important}';
    document.head.appendChild(style);
  };
  const clearHover = () => {
    for (const n of document.querySelectorAll('[data-cortex-mark-hover]')) n.removeAttribute('data-cortex-mark-hover');
  };
  const markTarget = (event) => {
    const el = event.target;
    return el && el.nodeType === 1 ? el : el?.parentElement || null;
  };
  const NEAR_MAX = 60;
  const nearLabel = (el) => {
    // La etiqueta es el hermano anterior con texto corto: «Estado» antes del valor.
    // Si el elemento es sólo la envoltura de otro con el mismo texto (un <span>
    // dentro de la celda), se sube a la envoltura para encontrar al vecino.
    const own = (el.textContent || '').trim();
    let node = el;
    for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
      let prev = node.previousElementSibling;
      while (prev && !(prev.textContent || '').trim()) prev = prev.previousElementSibling;
      if (prev) {
        const text = (prev.textContent || '').replace(/\\s+/g, ' ').trim().replace(/[:：]\\s*$/, '');
        return text && text.length <= NEAR_MAX ? text : '';
      }
      const parent = node.parentElement;
      if (!parent || (parent.textContent || '').trim() !== own) return '';
      node = parent;
    }
    return '';
  };
  const markEvent = (event) => {
    if (!window.__cortexMarkMode) return;
    if (!event.isTrusted) return;
    if (event.type === 'mouseover') {
      ensureMarkStyle();
      clearHover();
      const hovered = markTarget(event);
      if (hovered) hovered.setAttribute('data-cortex-mark-hover', '');
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const el = markTarget(event);
    if (!el) return;
    clearHover();
    const isField = el.matches('input,textarea,select,[contenteditable="true"]');
    const raw = isField ? '' : (el.innerText || el.textContent || '');
    const sample = raw.replace(/\\s+/g, ' ').trim().slice(0, 400);
    const stable = window.__cortexTargets(el).filter(t => ['testid','name','css'].includes(t.kind));
    const label = isField ? '' : nearLabel(el);
    void window.__cortexMarkEvent({ sample, field: isField, label, targets: stable.slice(0, 8) }).catch(() => {});
  };
  for (const kind of ['click','mousedown','mouseup','pointerdown','pointerup','auxclick','dblclick','mouseover']) document.addEventListener(kind, markEvent, true);
  for (const kind of ['click','input','change','keydown']) document.addEventListener(kind, (e) => { if (!window.__cortexMarkMode) send(e); }, true);
})()`;

interface Variable {
  name: string;
  label: string;
  type: 'text';
  required: boolean;
  example: string;
}
/** Lo que la persona señaló y espera ponerle nombre. La muestra NO se guarda en el paso. */
interface PendingMark {
  /** El texto señalado, recortado: sólo para que la persona confirme que es ese. */
  sample: string;
  /** Formas de volver a encontrarlo, ya comprobadas contra la página viva. */
  targets: Target[];
  /** La etiqueta vecina («Estado»), si hubo, para proponer un nombre. */
  label: string;
  /** Si lo señalado fue un campo o algo que no se puede leer. */
  problem: string | null;
}

/** Nombre de un resultado: minúsculas, números y guion bajo. */
export function resultName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * El elemento que sigue a un rótulo visible: «Estado» y, a su lado, el valor.
 * Selector de Playwright (rótulo con o sin «:», sin importar mayúsculas), que
 * es lo que sobrevive a que el portal reordene su HTML.
 */
export function nearLabelSelector(label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return `text=/^\\s*${escaped}\\s*:?\\s*$/i >> xpath=following-sibling::*[1]`;
}

/** Nombres que el motor ya usa en el resultado de un trámite. */
const RESERVED_RESULT_NAMES = new Set(['download', 'ok', 'result']);

export class TeachingRecorder {
  private marking = false;
  private pendingMark: PendingMark | null = null;
  private active = false;
  private installed = false;
  private steps: Step[] = [];
  private variables: Variable[] = [];
  private startUrl = '';
  private limited = false;
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly page: Page) {}
  async start() {
    if (this.active) return this.state();
    if (!this.installed) {
      await this.page.exposeBinding('__cortexTeachEvent', ({ frame }, event: unknown) => {
        this.pending = this.pending.then(() => this.record(frame, event)).catch(() => undefined);
        return this.pending;
      });
      this.page.on('download', () => {
        const last = this.steps.at(-1);
        if (this.active && last?.action === 'click') last.action = 'download';
      });
      await this.page.exposeBinding('__cortexMarkEvent', ({ frame }, event: unknown) => {
        this.pending = this.pending
          .then(() => this.receiveMark(frame, event))
          .catch(() => undefined);
        return this.pending;
      });
      // Un marco que aparece o navega con el modo encendido también debe frenar los clics.
      this.page.on('framenavigated', (frame) => {
        if (this.marking)
          void frame.evaluate('window.__cortexMarkMode = true').catch(() => undefined);
      });
      await this.page.addInitScript(TEACH_SCRIPT);
      this.installed = true;
    }
    await Promise.all(
      this.page.frames().map((f) => f.evaluate(TEACH_SCRIPT).catch(() => undefined)),
    );
    this.startUrl = stableFrameUrl(this.page.url());
    this.marking = false;
    this.pendingMark = null;
    this.steps = [
      { action: 'goto', label: 'Abrir el portal', url: this.startUrl, targets: [], landmarks: [] },
    ];
    this.variables = [];
    this.limited = false;
    this.active = true;
    return this.state();
  }
  async stop() {
    await this.pending;
    await this.setMarking(false);
    this.active = false;
    return this.state();
  }

  /**
   * SEÑALAR RESULTADO: enciende o apaga el modo en que un clic no actúa sobre
   * el portal sino que elige el texto que es la respuesta del trámite.
   */
  private async setMarking(on: boolean) {
    this.marking = on;
    if (!on) this.pendingMark = null;
    await Promise.all(
      this.page
        .frames()
        .map((f) =>
          f
            .evaluate(
              `window.__cortexMarkMode = ${on};` +
                `if (!${on}) { for (const n of document.querySelectorAll('[data-cortex-mark-hover]')) n.removeAttribute('data-cortex-mark-hover'); }`,
            )
            .catch(() => undefined),
        ),
    );
  }
  async markStart() {
    if (!this.active) throw new Error('La enseñanza no está activa.');
    await this.pending;
    this.pendingMark = null;
    await this.setMarking(true);
    return this.state();
  }
  async markCancel() {
    await this.setMarking(false);
    return this.state();
  }
  /**
   * Convierte lo señalado en un paso `extract` con el nombre que dio la
   * persona. `fallback` es lo que vale el resultado si, en una corrida futura,
   * el elemento no aparece («no encontrado»).
   */
  async markCommit(name: string, fallback?: string) {
    if (!this.active) throw new Error('La enseñanza no está activa.');
    await this.pending;
    const mark = this.pendingMark;
    if (!mark) throw new Error('Primero señala el texto en la página.');
    if (mark.problem || !mark.targets.length)
      throw new Error(mark.problem ?? 'No encontré una forma estable de volver a ese texto.');
    const key = resultName(name);
    if (!key) throw new Error('Ponle un nombre al resultado (letras y números).');
    if (RESERVED_RESULT_NAMES.has(key)) throw new Error(`«${key}» es un nombre reservado.`);
    if (this.steps.some((s) => s.action === 'extract' && s.extractAs === key))
      throw new Error(`Ya hay un resultado llamado «${key}».`);
    if (this.steps.length >= 60) {
      this.limited = true;
      throw new Error('Termina esta enseñanza antes de agregar más pasos.');
    }
    const def = typeof fallback === 'string' ? fallback.trim().slice(0, 200) : '';
    const step: Step = {
      action: 'extract',
      label: `Leer «${key}»`,
      targets: mark.targets,
      landmarks: [],
      extractAs: key,
      ...(def ? { extractDefault: def } : {}),
    };
    this.steps.push(step);
    await this.setMarking(false);
    return this.state();
  }
  private async receiveMark(frame: Frame, raw: unknown) {
    if (!this.active || !this.marking || !raw || typeof raw !== 'object') return;
    const event = raw as { sample?: unknown; field?: unknown; label?: unknown; targets?: unknown };
    const path = framePath(frame);
    const candidates: Target[] = Array.isArray(event.targets)
      ? event.targets
          .slice(0, 8)
          .flatMap((t) =>
            t &&
            ['testid', 'name', 'css'].includes(t.kind) &&
            typeof t.value === 'string' &&
            t.value &&
            t.value.length <= 400
              ? [{ kind: t.kind, value: t.value, framePath: path } as Target]
              : [],
          )
      : [];
    const sample = typeof event.sample === 'string' ? event.sample.trim().slice(0, 400) : '';
    const label = typeof event.label === 'string' ? event.label.slice(0, 80) : '';
    // testid primero, luego el rótulo vecino («Estado» junto a su valor), luego
    // el resto (ids, rutas CSS), que es lo primero que se rompe.
    if (label)
      candidates.splice(candidates.filter((t) => t.kind === 'testid').length, 0, {
        kind: 'css',
        value: nearLabelSelector(label),
        framePath: path,
      });
    if (event.field === true || !sample) {
      this.pendingMark = {
        sample: '',
        targets: [],
        label,
        problem:
          event.field === true
            ? 'Eso es un campo para escribir. Señala el texto que muestra la página como respuesta.'
            : 'Ahí no hay texto. Señala el texto que muestra la página como respuesta.',
      };
      return;
    }
    // Sólo se conservan las formas de volver al texto que, contra la página
    // viva, dan UN elemento con ESE mismo texto. Una ruta CSS que ya no
    // reproduce lo señalado es peor que ninguna: leería otra cosa sin avisar.
    const same = (a: string) =>
      a.replace(/\s+/g, ' ').trim() === sample.replace(/\s+/g, ' ').trim();
    const verified: Target[] = [];
    for (const target of candidates) {
      const found = await resolveTarget(this.page, [target], Date.now()).catch(() => null);
      if (!found || !isResolved(found)) continue;
      const text = await found.locator.innerText({ timeout: 500 }).catch(() => null);
      if (text !== null && same(text.slice(0, 400))) verified.push(target);
    }
    this.pendingMark = {
      sample,
      targets: verified,
      label,
      problem: verified.length
        ? null
        : 'No encontré una forma estable de volver a ese texto. Prueba señalando un elemento más pequeño.',
    };
  }
  explain(index: number, text: string) {
    if (!this.active) throw new Error('La enseñanza no está activa.');
    const step = this.steps[index];
    if (!Number.isInteger(index) || !step || typeof text !== 'string' || text.length > 2000)
      throw new Error('Explicación inválida.');
    step.explanation = text.trim() || undefined;
    return this.state();
  }
  async navigate(url: string) {
    await this.pending;
    if (this.active && this.steps.length >= 60)
      throw new Error('Termina esta enseñanza antes de abrir otro sitio.');
    // Record the explicit address-bar action only. Navigation caused by a click
    // is already represented by that click and must not execute twice.
    await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (this.active)
      this.steps.push({
        action: 'goto',
        label: 'Ir a otro sitio',
        url: stableFrameUrl(url),
        targets: [],
        landmarks: [],
      });
    return this.state();
  }
  state() {
    return {
      marking: this.marking,
      pendingMark: this.pendingMark
        ? {
            sample: this.pendingMark.sample,
            suggestedName: resultName(this.pendingMark.label),
            ok: !this.pendingMark.problem,
            problem: this.pendingMark.problem,
          }
        : null,
      active: this.active,
      limited: this.limited,
      startUrl: this.startUrl,
      steps: this.steps,
      variables: this.variables,
    };
  }
  private record(frame: Frame, raw: unknown) {
    if (!this.active || !raw || typeof raw !== 'object') return;
    const event = raw as { action?: unknown; label?: unknown; targets?: unknown };
    if (
      !['click', 'fill', 'select', 'check', 'uncheck', 'press', 'pause'].includes(
        String(event.action),
      )
    )
      return;
    if (typeof event.label !== 'string' || !Array.isArray(event.targets)) return;
    const path = framePath(frame);
    if (path.length > 12) {
      this.limited = true;
      this.active = false;
      return;
    }
    const targets: Target[] = event.targets.slice(0, 8).flatMap((t) => {
      if (
        !t ||
        !['testid', 'role', 'label', 'placeholder', 'text', 'name', 'css'].includes(t.kind) ||
        typeof t.value !== 'string' ||
        !t.value ||
        t.value.length > 400
      )
        return [];
      return [
        {
          kind: t.kind,
          value: t.value,
          ...(typeof t.name === 'string' ? { name: t.name.slice(0, 200) } : {}),
          framePath: path,
        },
      ];
    });
    const action = event.action as Step['action'];
    if (action !== 'pause' && !targets.length) return;
    const label = event.label.trim().slice(0, 120) || 'Continuar';
    const previous = this.steps.at(-1);
    // input+change and repeated keystrokes describe one field, not many steps.
    if (
      previous?.action === action &&
      ['fill', 'select', 'pause', 'check', 'uncheck'].includes(action) &&
      JSON.stringify(previous.targets) === JSON.stringify(targets)
    )
      return;
    if (
      this.steps.length >= 60 ||
      (['fill', 'select'].includes(action) && this.variables.length >= 12)
    ) {
      this.limited = true;
      this.active = false;
      return;
    }
    const step: Step = { action, label, targets, landmarks: [] };
    if (action === 'fill' || action === 'select') {
      const name = `campo_${this.variables.length + 1}`;
      this.variables.push({ name, label, type: 'text', required: true, example: '' });
      step.value = { kind: 'template', text: `{{${name}}}` };
    }
    if (action === 'press') step.value = { kind: 'literal', text: 'Enter' };
    this.steps.push(step);
  }
}
