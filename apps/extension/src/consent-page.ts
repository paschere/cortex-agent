import { validSite } from '../../../packages/agent-tools/src/browser/chrome/domain';
import { originPattern, sendBackground } from './lib';

/**
 * La ventanita donde la persona decide por sitio. Los botones de «una vez» y
 * «siempre» piden además el permiso de Chrome para ese sitio (con el clic como
 * gesto): así Chrome mismo impide que la extensión toque un sitio que la
 * persona no aprobó, aunque el código se equivocara.
 */
const params = new URLSearchParams(location.search);
const id = params.get('id') ?? '';
const site = (params.get('site') ?? '').toLowerCase();
const purpose = params.get('purpose') ?? '';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const note = $('#note');

function done(decision: 'once' | 'always' | 'never' | 'deny') {
  void sendBackground({ type: 'consent-result', id, decision }).finally(() => window.close());
}

if (!id || !validSite(site)) {
  $('#site').textContent = 'Sitio no válido';
  for (const b of Array.from(document.querySelectorAll('button')))
    (b as HTMLButtonElement).disabled = true;
  setTimeout(() => done('deny'), 1_500);
} else {
  $('#site').textContent = site;
  $('#purpose').textContent = purpose ? `Para: ${purpose}` : '';
  const grant = async (decision: 'once' | 'always') => {
    note.textContent = 'Chrome te pedirá confirmar el permiso…';
    try {
      const ok = await chrome.permissions.request({ origins: [originPattern(site)] });
      done(ok ? decision : 'deny');
    } catch {
      done('deny');
    }
  };
  $('#once').addEventListener('click', () => void grant('once'));
  $('#always').addEventListener('click', () => void grant('always'));
  $('#never').addEventListener('click', () => done('never'));
  $('#deny').addEventListener('click', () => done('deny'));
}
// Cerrar la ventana sin decidir es "ahora no" (el service worker lo detecta).
