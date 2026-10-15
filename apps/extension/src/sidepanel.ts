import { validSite } from '../../../packages/agent-tools/src/browser/chrome/domain';
import {
  DEFAULT_ORIGIN,
  type LocalRule,
  type SessionState,
  type StepLog,
  type Stored,
  VERSION,
  getSessions,
  getSteps,
  getStored,
  originPattern,
  sendBackground,
  setStored,
} from './lib';

/**
 * El panel lateral: emparejar, ver en vivo lo que hace Cortex, detenerlo y
 * revisar/quitar los sitios que decidiste. Todo el contenido que viene de
 * fuera (sitios, textos de pasos) se pinta con textContent: nunca innerHTML.
 */

const app = document.getElementById('app') as HTMLElement;
const clock = new Intl.DateTimeFormat('es-CO', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const kid of kids) node.append(kid);
  return node;
}

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol === 'https:' || (url.protocol === 'http:' && local)) return url.origin;
    return null;
  } catch {
    return null;
  }
}

function defaultDeviceName(): string {
  const p =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
    '';
  return p ? `Chrome en ${p}` : 'Mi Chrome';
}

// ---------------------------------------------------------------------------
// No emparejado
// ---------------------------------------------------------------------------

function renderPairing(notice: string | null) {
  const code = el('input', {
    type: 'text',
    id: 'code',
    maxlength: '9',
    autocomplete: 'off',
    spellcheck: 'false',
    placeholder: 'XXXX-XXXX',
    'aria-describedby': 'code-help',
  });
  const nameInput = el('input', { type: 'text', id: 'name', class: 'plain', maxlength: '80' });
  nameInput.value = defaultDeviceName();
  const originInput = el('input', {
    type: 'text',
    id: 'origin',
    class: 'plain',
    placeholder: DEFAULT_ORIGIN,
  });
  originInput.value = DEFAULT_ORIGIN;
  const msg = el('p', { class: 'err', role: 'alert' });
  const go = el('button', { class: 'primary', type: 'button' }, 'Emparejar');

  go.addEventListener('click', async () => {
    msg.textContent = '';
    const origin = normalizeOrigin(originInput.value);
    if (!origin) {
      msg.textContent =
        'La dirección de Cortex debe ser https:// (o http://localhost para pruebas).';
      return;
    }
    if (code.value.replace(/[\s-]/g, '').length !== 8) {
      msg.textContent = 'El código tiene 8 letras y números.';
      return;
    }
    go.disabled = true;
    try {
      const has = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      if (!has && !(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
        msg.textContent = 'Sin el permiso para hablar con Cortex no puedo emparejar.';
        return;
      }
      const res = await fetch(`${origin}/api/extension/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: code.value,
          deviceName: nameInput.value,
          extVersion: VERSION,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        deviceName?: string;
        error?: string;
      };
      if (!res.ok || !body.token) {
        msg.textContent = body.error ?? 'No se pudo emparejar.';
        return;
      }
      await chrome.storage.local.remove('notice');
      await setStored({
        origin,
        token: body.token,
        deviceName: body.deviceName ?? nameInput.value,
        rules: [],
      });
      void sendBackground({ type: 'wake' });
    } catch {
      msg.textContent = 'No pude hablar con Cortex. Revisa la dirección y tu conexión.';
    } finally {
      go.disabled = false;
    }
  });

  app.replaceChildren(
    el('h1', {}, 'Cortex en tu Chrome'),
    el(
      'p',
      { class: 'sub' },
      'Deja que Cortex trabaje en tu navegador con tus sesiones abiertas. Tú decides en qué sitios y puedes detenerlo cuando quieras.',
    ),
    ...(notice ? [el('p', { class: 'notice' }, notice)] : []),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Emparejar'),
      el(
        'p',
        { class: 'faint', id: 'code-help' },
        'En Cortex: Ajustes → «Cortex en tu Chrome» → Crear código.',
      ),
      el('div', { style: 'height:10px' }),
      el('label', { for: 'code' }, 'Código'),
      code,
      el('div', { style: 'height:10px' }),
      el('label', { for: 'name' }, 'Nombre de este Chrome'),
      nameInput,
      el(
        'details',
        {},
        el('summary', {}, 'Avanzado'),
        el('div', { style: 'height:8px' }),
        el('label', { for: 'origin' }, 'Dirección de Cortex'),
        originInput,
      ),
      el('div', { style: 'height:12px' }),
      go,
      msg,
    ),
  );
}

// ---------------------------------------------------------------------------
// Emparejado
// ---------------------------------------------------------------------------

function renderPaired(
  st: Stored,
  sessions: SessionState[],
  steps: StepLog[],
  connectedAt: number | undefined,
) {
  const online = connectedAt !== undefined && Date.now() - connectedAt < 60_000;
  const active = sessions.filter((s) => !s.stopped && !s.closed);

  const head = el(
    'div',
    { class: 'row' },
    el('span', { class: online ? 'dot on' : 'dot', 'aria-hidden': 'true' }),
    el(
      'div',
      { class: 'grow' },
      el('p', { style: 'font-weight:700' }, st.deviceName),
      el(
        'p',
        { class: 'faint' },
        online ? 'Conectado a Cortex' : 'Sin conexión con Cortex… reintentando',
      ),
    ),
  );

  const sessionCards = active.map((s) => {
    const stop = el('button', { class: 'danger', type: 'button' }, 'Detener');
    stop.addEventListener('click', () => void sendBackground({ type: 'stop', sessionId: s.id }));
    return el(
      'section',
      { class: 'card' },
      el(
        'div',
        { class: 'row' },
        el(
          'div',
          { class: 'grow' },
          el('p', { style: 'font-weight:700' }, s.purpose || 'Trabajando en tu Chrome'),
          el(
            'p',
            { class: 'faint' },
            `${s.actions} de ${s.cap} acciones${s.awaiting ? ' · te espera' : ''}`,
          ),
        ),
        stop,
      ),
      ...(s.awaiting
        ? [
            el(
              'p',
              { class: 'chip wait', style: 'margin-top:8px' },
              s.awaiting.kind === 'secret'
                ? 'Esperando tu clave en la página'
                : 'Esperando tu ayuda en la página',
            ),
          ]
        : []),
    );
  });

  const stepsList = el('ul', { class: 'steps', 'aria-label': 'Pasos de Cortex' });
  for (const s of steps.slice(-25).reverse()) {
    stepsList.append(
      el(
        'li',
        {},
        el('time', {}, clock.format(s.at)),
        el('span', { class: s.ok ? '' : 'err' }, s.text),
      ),
    );
  }

  const rulesList = el('ul', {});
  const rules: LocalRule[] = [...st.rules].sort((a, b) => a.site.localeCompare(b.site));
  for (const r of rules) {
    if (!validSite(r.site)) continue;
    const rm = el('button', { class: 'quiet', type: 'button' }, 'Quitar');
    rm.addEventListener('click', () => void sendBackground({ type: 'remove-rule', site: r.site }));
    rulesList.append(
      el(
        'li',
        { class: 'item row' },
        el('span', { class: 'grow', style: 'font-weight:600;overflow-wrap:anywhere' }, r.site),
        el(
          'span',
          { class: r.decision === 'always' ? 'chip ok' : 'chip bad' },
          r.decision === 'always' ? 'Siempre' : 'Nunca',
        ),
        rm,
      ),
    );
  }

  const stopAll = el('button', { type: 'button' }, 'Detener todo');
  stopAll.disabled = active.length === 0;
  stopAll.addEventListener('click', () => void sendBackground({ type: 'stop-all' }));
  const unpair = el('button', { class: 'quiet', type: 'button' }, 'Desvincular este Chrome');
  unpair.addEventListener('click', () => {
    if (confirm('¿Desvincular este Chrome? Cortex deja de poder usarlo y se olvidan los sitios.'))
      void sendBackground({ type: 'unpair' });
  });

  app.replaceChildren(
    el('h1', {}, 'Cortex en tu Chrome'),
    el('section', { class: 'card' }, head),
    ...(sessionCards.length
      ? sessionCards
      : [
          el(
            'p',
            { class: 'empty' },
            'Cortex no está trabajando en tu Chrome ahora mismo. Cuando se lo pidas en el chat y lo apruebes, lo verás aquí.',
          ),
        ]),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Lo que hace'),
      steps.length
        ? stepsList
        : el('p', { class: 'empty' }, 'Aún nada en esta sesión del navegador.'),
    ),
    el(
      'section',
      { class: 'card' },
      el('h2', {}, 'Sitios que decidiste'),
      rules.length
        ? rulesList
        : el(
            'p',
            { class: 'empty' },
            'La primera vez que Cortex quiera trabajar en un sitio, te pregunto aquí.',
          ),
    ),
    el('div', { class: 'row' }, stopAll, unpair),
    el(
      'p',
      { class: 'faint' },
      `Versión ${VERSION}. Cortex nunca lee tus contraseñas ni actúa en páginas del navegador, tu red privada o la propia Cortex.`,
    ),
  );
}

async function render() {
  const st = await getStored();
  const local = await chrome.storage.local.get(['notice', 'connectedAt']);
  if (!st) {
    renderPairing((local.notice as string | undefined) ?? null);
    return;
  }
  const sessions = Object.values(await getSessions()).sort((a, b) => b.startedAt - a.startedAt);
  renderPaired(st, sessions, await getSteps(), local.connectedAt as number | undefined);
}

let timer: number | undefined;
function schedule() {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void render(), 80);
}
chrome.storage.onChanged.addListener(schedule);
window.setInterval(() => {
  // Refresca el indicador de conexión sin tocar el formulario de emparejar a medias.
  if (!document.getElementById('code')) void render();
}, 5_000);
void render();
// Se usa para anunciar al service worker que hay panel abierto.
void originPattern;
