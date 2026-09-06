import type { Frame, Page } from 'playwright';
import { framePath, stableFrameUrl } from './frame-path';
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
  for (const kind of ['click','input','change','keydown']) document.addEventListener(kind, send, true);
})()`;

interface Variable {
  name: string;
  label: string;
  type: 'text';
  required: boolean;
  example: string;
}
export class TeachingRecorder {
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
      await this.page.addInitScript(TEACH_SCRIPT);
      this.installed = true;
    }
    await Promise.all(
      this.page.frames().map((f) => f.evaluate(TEACH_SCRIPT).catch(() => undefined)),
    );
    this.startUrl = stableFrameUrl(this.page.url());
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
    this.active = false;
    return this.state();
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
