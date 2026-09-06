import type { Frame, Page } from 'playwright';
import { framePath } from './frame-path';

export class ClipboardError extends Error {}
export const MAX_CLIPBOARD = 100_000;
// Focus belongs to the deepest active document; ancestors can also report focus.
async function focusedFrame(page: Page): Promise<Frame> {
  for (const frame of [...page.frames()].reverse()) {
    if (await frame.evaluate(() => document.hasFocus()).catch(() => false)) return frame;
  }
  return page.mainFrame();
}
export class SessionClipboard {
  private text: string | null = null;
  constructor(private readonly page: Page) {}
  async copy() {
    const frame = await focusedFrame(this.page);
    const selection = await frame.evaluate(() => {
      let el = document.activeElement as HTMLElement | null;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
      let fieldSelection = '';
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if (
          (el instanceof HTMLInputElement && el.type === 'password') ||
          /password|passwd|otp|one-time|secret|token|contrase|clave|verification/i.test(
            [
              el.name,
              el.id,
              el.autocomplete,
              el.getAttribute('aria-label'),
              Array.from(el.labels ?? [])
                .map((label) => label.textContent)
                .join(' '),
            ].join(' '),
          )
        )
          return { blocked: true, text: '' };
        if (el.selectionStart !== null && el.selectionEnd !== null)
          fieldSelection = el.value.slice(el.selectionStart, el.selectionEnd);
      }
      const data = new DataTransfer();
      (el ?? document.body).dispatchEvent(
        new ClipboardEvent('copy', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      return {
        blocked: false,
        text:
          data.getData('text/plain') || fieldSelection || window.getSelection()?.toString() || '',
      };
    });
    if (selection.blocked) {
      this.text = null;
      throw new ClipboardError('Ese campo es privado y no se copia.');
    }
    if (!selection.text) {
      this.text = null;
      throw new ClipboardError('Selecciona texto en la página antes de copiar.');
    }
    if (selection.text.length > MAX_CLIPBOARD) {
      this.text = null;
      throw new ClipboardError(
        'La selección supera 100.000 caracteres. Copia una parte más pequeña.',
      );
    }
    this.text = selection.text;
    return { text: this.text, characters: this.text.length };
  }
  async paste(text?: string) {
    const value = text ?? this.text;
    if (value === null) throw new ClipboardError('El portapapeles de esta sesión está vacío.');
    if (value.length > MAX_CLIPBOARD)
      throw new ClipboardError('El texto supera 100.000 caracteres.');
    // insertText replaces the current selection; it never sends data to the OS
    // clipboard shared by Chromium processes belonging to other people.
    const frame = await focusedFrame(this.page);
    const handled = await frame.evaluate((value) => {
      let el = document.activeElement as HTMLElement | null;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
      const data = new DataTransfer();
      data.setData('text/plain', value);
      const event = new ClipboardEvent('paste', {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      (el ?? document.body).dispatchEvent(event);
      return event.defaultPrevented;
    }, value);
    if (!handled) await this.page.keyboard.insertText(value);
    return { characters: value.length };
  }
  async selectAll() {
    const frame = await focusedFrame(this.page);
    await frame.evaluate(() => {
      let el = document.activeElement as HTMLElement | null;
      while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement as HTMLElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.select();
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(el?.isContentEditable ? el : document.body);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  }
  clear() {
    this.text = null;
  }
}

export async function readPageContent(page: Page, offset = 0, limit = 20_000) {
  const frames = page.frames();
  const sources: {
    url: string;
    path: ReturnType<typeof framePath>;
    characters: number;
    readable: boolean;
  }[] = [];
  let total = 0;
  let text = '';
  // Offsets count characters across documents. Do not truncate the source to
  // the diagnostic snapshot's 1800-character preview.
  for (const frame of frames.slice(0, 100)) {
    try {
      const part = await frame.evaluate(
        ({ start, count }) => {
          const body = document.body;
          let value = body?.innerText ?? '';
          // Visible form values are useful data too. Never surface credentials or
          // hidden fields. Textareas/contenteditable already contribute text.
          const roots: (Document | ShadowRoot)[] = [document];
          for (let i = 0; i < roots.length; i++) {
            for (const host of Array.from(roots[i]?.querySelectorAll('*') ?? [])) {
              if (!host.shadowRoot) continue;
              roots.push(host.shadowRoot);
              if (host.getClientRects().length && getComputedStyle(host).visibility !== 'hidden')
                value += `\n${Array.from(host.shadowRoot.children)
                  .map((el) => (el instanceof HTMLElement ? el.innerText : ''))
                  .join('\n')}`;
            }
          }
          for (const el of roots.flatMap((root) =>
            Array.from(root.querySelectorAll('input,select,textarea')),
          )) {
            if (
              !(
                el instanceof HTMLInputElement ||
                el instanceof HTMLSelectElement ||
                el instanceof HTMLTextAreaElement
              )
            )
              continue;
            if (!el.getClientRects().length || getComputedStyle(el).visibility === 'hidden')
              continue;
            if (el instanceof HTMLInputElement && ['password', 'hidden', 'file'].includes(el.type))
              continue;
            if (
              /password|passwd|otp|one-time|secret|token|contrase|clave|verification/i.test(
                [
                  el.name,
                  el.id,
                  el.autocomplete,
                  el.getAttribute('aria-label'),
                  Array.from(el.labels ?? [])
                    .map((label) => label.textContent)
                    .join(' '),
                ].join(' '),
              )
            )
              continue;
            if (el.value)
              value += `\n${el.getAttribute('aria-label') || el.name || 'Campo'}: ${el.value}`;
          }
          value += '\n';
          return { total: value.length, text: value.slice(start, start + count) };
        },
        { start: Math.max(0, offset - total), count: Math.max(0, limit - text.length) },
      );
      sources.push({
        url: frame.url(),
        path: framePath(frame),
        characters: part.total,
        readable: true,
      });
      text += part.text;
      total += part.total;
    } catch {
      sources.push({ url: frame.url(), path: framePath(frame), characters: 0, readable: false });
    }
  }
  return {
    text,
    offset,
    nextOffset: offset + text.length < total ? offset + text.length : null,
    totalCharacters: total,
    sources,
    omittedFrames: Math.max(0, frames.length - 100),
    limitation:
      'Contenido cargado y accesible en el DOM. Canvas, imágenes, componentes cerrados y filas no cargadas pueden requerir otra lectura. La página puede cambiar entre lecturas.',
  };
}
