import { describe, expect, it } from 'vitest';
import { browserSteps, liveSessionOf, summarizeBrowserStep } from './browser-live-steps';

const inv = (toolName: string, args: unknown, result?: unknown, state = 'result') => ({
  toolCallId: `${toolName}-${Math.random()}`,
  toolName,
  state,
  args,
  ...(result === undefined ? {} : { result }),
});

describe('summarizeBrowserStep', () => {
  it('ignora lo que no es del navegador', () => {
    expect(summarizeBrowserStep(inv('gmail_send_email', {}, {}))).toBeNull();
  });

  it('cuenta abrir una página con el dominio', () => {
    const s = summarizeBrowserStep(
      inv('browser_open_page', { url: 'https://www.dian.gov.co/x' }, { sessionId: 's1' }),
    );
    expect(s?.sentence).toBe('Abrí dian.gov.co');
    expect(s?.sessionId).toBe('s1');
  });

  it('acepta el nombre con punto', () => {
    expect(
      summarizeBrowserStep(inv('browser.close_page', { sessionId: 's' }, { ok: true }))?.sentence,
    ).toBe('Cerré la pestaña');
  });

  it('redacta clic y relleno sin mostrar lo escrito', () => {
    const c = summarizeBrowserStep(
      inv('browser_act', { sessionId: 's', action: 'click', name: 'Consultar' }, { ok: true }),
    );
    expect(c?.sentence).toBe('Hice clic en “Consultar”');
    const f = summarizeBrowserStep(
      inv(
        'browser_act',
        { sessionId: 's', action: 'fill', name: 'NIT', text: '900123' },
        { ok: true },
      ),
    );
    expect(f?.sentence).toBe('Escribí en el campo “NIT”');
    expect(f?.sentence).not.toContain('900123');
  });

  it('en curso dice lo que Cortex hace ahora', () => {
    const s = summarizeBrowserStep(
      inv('browser_act', { action: 'fill', name: 'NIT' }, undefined, 'call'),
    );
    expect(s?.status).toBe('running');
    expect(s?.doing).toBe('Cortex está escribiendo en el campo “NIT”…');
    expect(s?.sentence).toBe('Escribiendo en el campo “NIT”…');
  });

  it('un acto que no se pudo queda en error con el motivo', () => {
    const s = summarizeBrowserStep(
      inv(
        'browser_act',
        { action: 'click', name: 'Enviar' },
        { ok: false, message: 'La página cambió.' },
      ),
    );
    expect(s?.status).toBe('error');
    expect(s?.sentence).toBe('No pude hacer clic en “Enviar”: La página cambió.');
  });

  it('leer la página usa el título o los caracteres', () => {
    expect(
      summarizeBrowserStep(inv('browser_read_page', {}, { page: { title: 'Resultados' } }))
        ?.sentence,
    ).toBe('Leí la página «Resultados»');
    expect(
      summarizeBrowserStep(inv('browser_read_page', {}, { content: { totalCharacters: 1200 } }))
        ?.sentence,
    ).toContain('caracteres');
  });

  it('pedir ayuda y clave marcan que espera a la persona', () => {
    const a = summarizeBrowserStep(
      inv('browser_ask_person', { reason: 'Escribe el código que te llegó' }, { ok: true }),
    );
    expect(a?.needsPerson).toBe(true);
    expect(a?.sentence).toBe('Esperando tu ayuda: Escribe el código que te llegó');
    const k = summarizeBrowserStep(
      inv('browser_request_secret', { label: 'Contraseña de la DIAN' }, { ok: true }),
    );
    expect(k?.sentence).toBe('Esperando: Contraseña de la DIAN');
  });

  it('trae la foto sólo si es una imagen segura', () => {
    const ok = summarizeBrowserStep(
      inv(
        'browser_act',
        { action: 'click' },
        { ok: true, screenshot: 'data:image/png;base64,AAA' },
      ),
    );
    expect(ok?.thumb).toBe('data:image/png;base64,AAA');
    const bad = summarizeBrowserStep(
      inv('browser_act', { action: 'click' }, { ok: true, screenshot: 'javascript:alert(1)' }),
    );
    expect(bad?.thumb).toBeNull();
  });

  it('la foto chica llega como ruta propia (open, act y read) y no se acepta otro origen raro', () => {
    const path = '/api/browser/live/s_ab12/shot/Zk3_-aBcD0eF';
    for (const tool of ['browser_open_page', 'browser_act', 'browser_read_page']) {
      const step = summarizeBrowserStep(
        inv(tool, { action: 'click' }, { ok: true, thumbnail: path }),
      );
      expect(step?.thumb).toBe(path);
    }
    const bad = summarizeBrowserStep(
      inv('browser_act', { action: 'click' }, { ok: true, thumbnail: 'ftp://x/y.jpg' }),
    );
    expect(bad?.thumb).toBeNull();
  });

  it('esperar el OK de abrir no cuenta como hecho', () => {
    const s = summarizeBrowserStep(
      inv('browser_open_page', { url: 'https://dian.gov.co' }, { __requires_confirmation: true }),
    );
    expect(s?.status).toBe('waiting');
  });
});

describe('liveSessionOf', () => {
  it('encuentra la pestaña abierta y la olvida al cerrarla', () => {
    const open = inv('browser_open_page', { url: 'https://a.co' }, { sessionId: 's1' });
    expect(liveSessionOf([open])?.sessionId).toBe('s1');
    expect(
      liveSessionOf([open, inv('browser_close_page', { sessionId: 's1' }, { ok: true })]),
    ).toBeNull();
  });

  it('un trámite parado trae su checkpoint', () => {
    const live = liveSessionOf([
      inv(
        'browser_run_flow',
        { flow: 'rut' },
        { handoff: { sessionId: 's9', ask: 'Resuelve el captcha' }, checkpoint: { id: 'c1' } },
      ),
    ]);
    expect(live).toMatchObject({ sessionId: 's9', checkpointId: 'c1', ask: 'Resuelve el captcha' });
  });

  it('browserSteps conserva el orden', () => {
    const steps = browserSteps([
      inv('browser_open_page', { url: 'https://a.co' }, { sessionId: 's1' }),
      inv('gmail_send_email', {}, {}),
      inv('browser_act', { action: 'goto', url: 'https://b.co/x' }, { ok: true }),
    ]);
    expect(steps.map((s) => s.sentence)).toEqual(['Abrí a.co', 'Fui a b.co']);
  });
});
