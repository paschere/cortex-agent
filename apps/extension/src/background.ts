import {
  type SiteRule,
  decideConsent,
} from '../../../packages/agent-tools/src/browser/chrome/consent';
import {
  hostOf,
  siteOf,
  siteOfUrl,
  validSite,
} from '../../../packages/agent-tools/src/browser/chrome/domain';
import {
  type Command,
  type CommandResult,
  LIMITS,
  type PageView,
  capDecision,
  parseCommand,
} from '../../../packages/agent-tools/src/browser/chrome/protocol';
import {
  LOCAL_CAP,
  type LocalRule,
  type SessionState,
  type Stored,
  type ToBackground,
  type ToContent,
  VERSION,
  getSessions,
  getStored,
  logStep,
  originPattern,
  protectedHostsOf,
  putSession,
  setStored,
} from './lib';

/**
 * EL SERVICE WORKER: el cerebro de «Cortex en tu Chrome».
 *
 * Mantiene la espera larga con Cortex, valida cada orden (el contrato es el
 * mismo código que usa el servidor), decide si puede actuar en el sitio (la
 * extensión es la que manda: un servidor comprometido no se salta esto), la
 * ejecuta en la pestaña con chrome.scripting y devuelve el resultado.
 *
 * Reglas que no se rompen:
 *   - Sitio nuevo = ventana de consentimiento (solo esta vez / siempre / nunca).
 *   - Ni chrome://, ni la red privada, ni la página de Cortex.
 *   - «Detener» corta al instante: cada paso revisa si la sesión se detuvo.
 *   - Tope local de acciones por sesión, además del del servidor.
 *   - Mientras la persona conduce (ayuda o secreto) no se acepta ninguna orden.
 */

class StopError extends Error {}

type Verdict = 'allow' | 'deny';

const INSTALLED_BADGE = '#3b34c4';

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let queue: Promise<unknown> = Promise.resolve();
/** Lecturas-modificaciones de storage.session una a una (el worker es asíncrono). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

async function updateSession(
  id: string,
  mutate: (s: SessionState) => void,
): Promise<SessionState | null> {
  return serial(async () => {
    const all = await getSessions();
    const s = all[id];
    if (!s) return null;
    mutate(s);
    await putSession(s);
    return s;
  });
}

async function sessionOf(id: string): Promise<SessionState | null> {
  return (await getSessions())[id] ?? null;
}

async function api(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  const st = await getStored();
  if (!st) throw new Error('No emparejado');
  const { timeoutMs = 15_000, ...rest } = init;
  return fetch(`${st.origin.replace(/\/+$/, '')}${path}`, {
    ...rest,
    headers: {
      authorization: `Bearer ${st.token}`,
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
}

async function postEvent(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await api('/api/extension/event', { method: 'POST', body: JSON.stringify(body) });
    return res.ok;
  } catch {
    return false;
  }
}

async function refreshBadge(): Promise<void> {
  const active = Object.values(await getSessions()).filter((s) => !s.stopped && !s.closed);
  await chrome.action.setBadgeBackgroundColor({ color: INSTALLED_BADGE });
  await chrome.action.setBadgeText({ text: active.length ? 'ON' : '' });
  await chrome.action.setTitle({
    title: active.length ? 'Cortex está trabajando en tu Chrome' : 'Cortex en tu Chrome',
  });
}

// ---------------------------------------------------------------------------
// Consentimiento
// ---------------------------------------------------------------------------

const pendingConsents = new Map<string, (d: 'once' | 'always' | 'never' | 'deny') => void>();

/** Abre la ventanita de la extensión y espera la decisión (90 s máximo: el servidor espera 100). */
async function askPerson(
  site: string,
  purpose: string,
): Promise<'once' | 'always' | 'never' | 'deny'> {
  const id = crypto.randomUUID();
  const url = chrome.runtime.getURL(
    `consent.html?id=${id}&site=${encodeURIComponent(site)}&purpose=${encodeURIComponent(purpose.slice(0, 200))}`,
  );
  return new Promise((resolve) => {
    let winId: number | undefined;
    let settled = false;
    const finish = (d: 'once' | 'always' | 'never' | 'deny') => {
      if (settled) return;
      settled = true;
      pendingConsents.delete(id);
      chrome.windows.onRemoved.removeListener(onRemoved);
      if (winId !== undefined) chrome.windows.remove(winId).catch(() => undefined);
      resolve(d);
    };
    const onRemoved = (removed: number) => {
      if (removed === winId) finish('deny');
    };
    pendingConsents.set(id, finish);
    chrome.windows.onRemoved.addListener(onRemoved);
    setTimeout(() => finish('deny'), 90_000);
    chrome.windows
      .create({ url, type: 'popup', width: 460, height: 440, focused: true })
      .then((w) => {
        winId = w.id;
        if (settled && winId !== undefined) chrome.windows.remove(winId).catch(() => undefined);
      })
      .catch(() => finish('deny'));
  });
}

async function setRule(st: Stored, site: string, decision: 'always' | 'never'): Promise<void> {
  const rules: LocalRule[] = st.rules.filter((r) => r.site !== site);
  const synced = await postEvent({ kind: 'site_rule', site, decision });
  rules.push({ site, decision, synced });
  await setStored({ ...st, rules });
}

/**
 * ¿Puede Cortex actuar en esta dirección? Pregunta a la persona si es la
 * primera vez. Devuelve el veredicto y una frase si se niega.
 */
async function gate(
  sessionId: string,
  url: string,
  purpose: string,
): Promise<{ verdict: Verdict; message?: string; site?: string; code?: 'blocked' | 'denied' }> {
  const st = await getStored();
  const session = await sessionOf(sessionId);
  if (!st || !session) return { verdict: 'deny', message: 'La sesión ya no existe.' };
  const rules: SiteRule[] = st.rules.map(({ site, decision }) => ({ site, decision }));
  const protectedSites = protectedHostsOf(st.origin);
  const decide = (s: SessionState) =>
    decideConsent({ url, rules, onceSites: s.onceSites, protectedSites });
  let verdict = decide(session);
  if (verdict.kind === 'allow') return { verdict: 'allow', site: verdict.site };
  if (verdict.kind === 'deny') {
    return {
      verdict: 'deny',
      message: verdict.message,
      code: verdict.reason === 'blocked' ? 'blocked' : 'denied',
      ...(verdict.site ? { site: verdict.site } : {}),
    };
  }

  const site = verdict.site;
  const answer = await askPerson(site, purpose);
  assertRunning(await sessionOf(sessionId));
  if (answer === 'never') {
    await setRule(st, site, 'never');
    return {
      verdict: 'deny',
      message: `Dijiste que Cortex nunca actúe en ${site}.`,
      site,
      code: 'denied',
    };
  }
  if (answer === 'deny') {
    return {
      verdict: 'deny',
      message: `No permitiste que Cortex actúe en ${site} esta vez.`,
      site,
      code: 'denied',
    };
  }
  // once | always: el permiso de Chrome ya lo concedió la ventana (gesto del clic).
  if (answer === 'always') {
    await setRule(st, site, 'always');
  } else {
    const pattern = originPattern(site);
    await updateSession(sessionId, (s) => {
      if (!s.onceSites.includes(site)) s.onceSites.push(site);
      if (!s.onceOrigins.includes(pattern)) s.onceOrigins.push(pattern);
    });
  }
  verdict = decide((await sessionOf(sessionId)) as SessionState);
  return verdict.kind === 'allow'
    ? { verdict: 'allow', site }
    : { verdict: 'deny', message: 'No pude registrar tu permiso.', site };
}

function assertRunning(s: SessionState | null): asserts s is SessionState {
  if (!s || s.stopped || s.closed) throw new StopError();
}

// ---------------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------------

async function waitComplete(tabId: number, timeoutMs = 15_000): Promise<chrome.tabs.Tab> {
  const deadline = Date.now() + timeoutMs;
  let tab = await chrome.tabs.get(tabId);
  while (tab.status !== 'complete' && Date.now() < deadline) {
    await sleep(250);
    tab = await chrome.tabs.get(tabId);
  }
  return tab;
}

/** Tras un clic: si la página empieza a cargar, esperarla; si no, un respiro. */
async function settle(tabId: number): Promise<chrome.tabs.Tab> {
  await sleep(600);
  return waitComplete(tabId, 10_000);
}

async function tabOf(session: SessionState): Promise<chrome.tabs.Tab | null> {
  if (session.tabId === null) return null;
  try {
    return await chrome.tabs.get(session.tabId);
  } catch {
    return null;
  }
}

async function inject(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
}

async function toContent<T>(tabId: number, msg: ToContent): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as T;
  } catch {
    await inject(tabId);
    return (await chrome.tabs.sendMessage(tabId, msg, { frameId: 0 })) as T;
  }
}

async function bannerOn(session: SessionState): Promise<void> {
  if (session.tabId === null) return;
  await toContent(session.tabId, { type: 'cortex:banner', sessionId: session.id, on: true }).catch(
    () => undefined,
  );
}

async function thumbnail(tab: chrome.tabs.Tab): Promise<string | undefined> {
  if (!tab.active || tab.windowId === undefined) return undefined;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 50,
    });
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const w = 480;
    const h = Math.max(1, Math.round((bmp.height * w) / bmp.width));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) return undefined;
    ctx.drawImage(bmp, 0, 0, w, h);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.55 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    const b64 = btoa(bin);
    return b64.length <= LIMITS.shotMaxChars ? b64 : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Ejecución de órdenes
// ---------------------------------------------------------------------------

interface ReadReply {
  page: PageView;
  content: { text: string; offset: number; nextOffset: number | null; total: number };
}

/** Mira la página (con consentimiento del sitio al que haya llegado) y arma el resultado. */
async function look(
  session: SessionState,
  offset: number,
  purpose: string,
  extra: Partial<CommandResult> = {},
): Promise<CommandResult> {
  const st = await getStored();
  let tab = await tabOf(session);
  if (!tab || tab.id === undefined)
    return { ok: false, code: 'no_tab', error: 'La pestaña ya no existe.' };
  const tabId = tab.id;
  tab = await waitComplete(tabId);
  const g = await gate(session.id, tab.url ?? '', purpose);
  assertRunning(await sessionOf(session.id));
  if (g.verdict === 'deny') {
    return {
      ok: false,
      code: g.code ?? 'denied',
      error: `${g.message ?? 'No permitido.'} No leo esa página.`,
      ...(g.site ? { site: g.site } : {}),
    };
  }
  const reply = await toContent<ReadReply>(tabId, {
    type: 'cortex:read',
    offset,
    protectedHosts: protectedHostsOf(st?.origin ?? ''),
  }).catch(() => null);
  assertRunning(await sessionOf(session.id));
  if (!reply)
    return { ok: false, code: 'failed', error: 'No pude leer la página (¿sigue cargando?).' };
  const fresh = await sessionOf(session.id);
  const shot = fresh?.awaiting ? undefined : await thumbnail(tab);
  return {
    ok: true,
    page: reply.page,
    content: reply.content,
    ...(shot ? { shot } : {}),
    ...(g.site ? { site: g.site } : {}),
    ...extra,
  };
}

function describe(cmd: Command): string {
  switch (cmd.op) {
    case 'open':
      return `Abrió ${hostOf(cmd.url) ?? 'un sitio'}`;
    case 'goto':
      return `Fue a ${hostOf(cmd.url) ?? 'otra página'}`;
    case 'read':
      return 'Leyó la página';
    case 'click':
      return `Hizo clic en «${cmd.name.slice(0, 40)}»`;
    case 'fill':
      return `Escribió en «${cmd.name.slice(0, 40)}»`;
    case 'select':
      return `Eligió una opción en «${cmd.name.slice(0, 40)}»`;
    case 'check':
      return `Marcó «${cmd.name.slice(0, 40)}»`;
    case 'press':
      return `Presionó ${cmd.key}`;
    case 'scroll':
      return 'Desplazó la página';
    case 'wait':
      return 'Esperó la página';
    case 'help':
      return 'Te pidió ayuda en la página';
    case 'secret':
      return `Te pidió «${cmd.label.slice(0, 40)}» directo en la página`;
    case 'close':
      return 'Cerró la sesión';
  }
}

async function execute(cmd: Command, session: SessionState): Promise<CommandResult> {
  const st = await getStored();
  const protectedHosts = protectedHostsOf(st?.origin ?? '');

  if (cmd.op === 'open') {
    const g = await gate(session.id, cmd.url, cmd.purpose);
    assertRunning(await sessionOf(session.id));
    if (g.verdict === 'deny') {
      return {
        ok: false,
        code: g.code ?? 'denied',
        error: g.message ?? 'No permitido.',
        ...(g.site ? { site: g.site } : {}),
      };
    }
    const tab = await chrome.tabs.create({ url: cmd.url, active: true });
    if (tab.id === undefined)
      return { ok: false, code: 'failed', error: 'No pude abrir la pestaña.' };
    await updateSession(session.id, (s) => {
      s.tabId = tab.id ?? null;
      s.windowId = tab.windowId ?? null;
      s.purpose = cmd.purpose;
    });
    const fresh = (await sessionOf(session.id)) as SessionState;
    await waitComplete(tab.id);
    await bannerOn(fresh).catch(() => undefined);
    return look(fresh, 0, cmd.purpose);
  }

  const tab = await tabOf(session);
  if (!tab || tab.id === undefined)
    return { ok: false, code: 'no_tab', error: 'La pestaña ya no existe.' };
  const purpose = session.purpose;

  if (cmd.op === 'close') return { ok: true };

  if (cmd.op === 'goto') {
    const g = await gate(session.id, cmd.url, purpose);
    assertRunning(await sessionOf(session.id));
    if (g.verdict === 'deny') {
      return {
        ok: false,
        code: 'denied',
        error: g.message ?? 'No permitido.',
        ...(g.site ? { site: g.site } : {}),
      };
    }
    await chrome.tabs.update(tab.id, { url: cmd.url });
    await waitComplete(tab.id);
    return look((await sessionOf(session.id)) as SessionState, 0, purpose);
  }

  // Todo lo demás actúa sobre la página de ahora: el sitio actual debe estar permitido.
  const here = await gate(session.id, tab.url ?? '', purpose);
  assertRunning(await sessionOf(session.id));
  if (here.verdict === 'deny') {
    return {
      ok: false,
      code: 'denied',
      error: here.message ?? 'No permitido.',
      ...(here.site ? { site: here.site } : {}),
    };
  }
  await bannerOn(session).catch(() => undefined);

  switch (cmd.op) {
    case 'read':
      return look(session, cmd.offset, purpose);
    case 'wait':
      await sleep(Math.min(cmd.ms, 10_000));
      assertRunning(await sessionOf(session.id));
      return look(session, 0, purpose);
    case 'help': {
      await updateSession(session.id, (s) => {
        s.awaiting = { kind: 'help', text: cmd.reason };
      });
      await toContent(tab.id, { type: 'cortex:help', reason: cmd.reason, sessionId: session.id });
      await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
      return { ok: true, ...(here.site ? { site: here.site } : {}) };
    }
    case 'secret': {
      const r = await toContent<{ ok: boolean; error?: string; code?: CommandResult['code'] }>(
        tab.id,
        {
          type: 'cortex:secret',
          ref: cmd.ref,
          name: cmd.name,
          label: cmd.label,
          sessionId: session.id,
        },
      );
      if (!r.ok)
        return {
          ok: false,
          code: r.code ?? 'failed',
          error: r.error ?? 'No pude señalar el campo.',
        };
      await updateSession(session.id, (s) => {
        s.awaiting = { kind: 'secret', text: cmd.label };
      });
      await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
      return { ok: true, ...(here.site ? { site: here.site } : {}) };
    }
    default: {
      const msg: ToContent =
        cmd.op === 'press'
          ? { type: 'cortex:act', op: 'press', key: cmd.key, protectedHosts }
          : cmd.op === 'scroll'
            ? { type: 'cortex:act', op: 'scroll', dy: cmd.dy, protectedHosts }
            : cmd.op === 'fill' || cmd.op === 'select'
              ? {
                  type: 'cortex:act',
                  op: cmd.op,
                  ref: cmd.ref,
                  name: cmd.name,
                  text: cmd.text,
                  protectedHosts,
                }
              : { type: 'cortex:act', op: cmd.op, ref: cmd.ref, name: cmd.name, protectedHosts };
      const r = await toContent<{ ok: boolean; code?: CommandResult['code']; error?: string }>(
        tab.id,
        msg,
      );
      assertRunning(await sessionOf(session.id));
      if (!r.ok) {
        const after = await look(session, 0, purpose).catch(() => null);
        return {
          ok: false,
          code: r.code ?? 'failed',
          error: r.error ?? 'No se pudo.',
          ...(after?.page ? { page: after.page } : {}),
        };
      }
      const t = await settle(tab.id);
      assertRunning(await sessionOf(session.id));
      // Si el gesto cambió de pestaña activa o de página, `look` vuelve a pedir permiso del sitio nuevo.
      void t;
      return look((await sessionOf(session.id)) as SessionState, 0, purpose);
    }
  }
}

async function reply(commandId: string, result: CommandResult): Promise<void> {
  try {
    await api('/api/extension/result', {
      method: 'POST',
      body: JSON.stringify({ commandId, result }),
      timeoutMs: 20_000,
    });
  } catch {
    // Sin conexión: el servidor vence la orden y le dice al modelo que no hubo respuesta.
  }
}

const chains = new Map<string, Promise<void>>();

/** Cuánto se adelanta el reloj de Cortex al de este equipo (de la última espera). */
let skewMs = 0;

async function handleCommand(raw: unknown): Promise<void> {
  const parsed = parseCommand(raw, Date.now() + skewMs);
  const rawId = (raw as { id?: unknown } | null)?.id;
  if (!parsed.ok) {
    if (typeof rawId === 'string' && /^[0-9a-f-]{36}$/.test(rawId)) {
      await reply(rawId, { ok: false, code: 'bad_command', error: parsed.error });
    }
    return;
  }
  const cmd = parsed.value;
  const previous = chains.get(cmd.sessionId) ?? Promise.resolve();
  const run = previous.then(() => runCommand(cmd)).catch(() => undefined);
  chains.set(cmd.sessionId, run);
  await run;
  if (chains.get(cmd.sessionId) === run) chains.delete(cmd.sessionId);
}

async function runCommand(cmd: Command): Promise<void> {
  let session = await sessionOf(cmd.sessionId);
  if (!session) {
    if (cmd.op !== 'open') {
      await reply(cmd.id, {
        ok: false,
        code: 'stopped',
        error: 'Esa sesión ya no está activa en tu Chrome.',
      });
      return;
    }
    session = {
      id: cmd.sessionId,
      tabId: null,
      windowId: null,
      purpose: cmd.purpose,
      onceSites: [],
      onceOrigins: [],
      actions: 0,
      cap: Math.min(cmd.cap, LOCAL_CAP),
      stopped: false,
      closed: false,
      awaiting: null,
      startedAt: Date.now(),
    };
    await serial(() => putSession(session as SessionState));
    await refreshBadge();
  }
  if (session.stopped || session.closed) {
    await reply(cmd.id, {
      ok: false,
      code: 'stopped',
      error: 'La persona detuvo a Cortex en su Chrome.',
    });
    return;
  }
  if (session.awaiting && cmd.op !== 'close') {
    await reply(cmd.id, {
      ok: false,
      code: 'person_driving',
      error: 'La persona está conduciendo la pestaña ahora. Espera a que te avise.',
    });
    return;
  }
  const cap = capDecision(session.actions, Math.min(session.cap, cmd.cap, LOCAL_CAP), cmd.op);
  if (!cap.ok) {
    await reply(cmd.id, { ok: false, code: 'cap', error: cap.message });
    return;
  }
  if (cap.counts) {
    await updateSession(session.id, (s) => {
      s.actions += 1;
    });
  }
  let result: CommandResult;
  try {
    result = await execute(cmd, (await sessionOf(session.id)) as SessionState);
  } catch (err) {
    result =
      err instanceof StopError
        ? { ok: false, code: 'stopped', error: 'La persona detuvo a Cortex en su Chrome.' }
        : {
            ok: false,
            code: 'failed',
            error: `Error en la extensión: ${(err as Error).message.slice(0, 200)}`,
          };
  }
  await logStep({ sessionId: cmd.sessionId, text: describe(cmd), ok: result.ok });
  if (cmd.op === 'close') await closeSessionLocal(cmd.sessionId, false);
  await reply(cmd.id, result);
}

// ---------------------------------------------------------------------------
// Fin de sesión, «Detener», pestaña cerrada
// ---------------------------------------------------------------------------

async function releaseOnce(session: SessionState): Promise<void> {
  if (session.onceOrigins.length === 0) return;
  const st = await getStored();
  const keep = new Set(
    (st?.rules ?? []).filter((r) => r.decision === 'always').map((r) => originPattern(r.site)),
  );
  // También lo que otras sesiones abiertas todavía estén usando.
  for (const other of Object.values(await getSessions())) {
    if (other.id !== session.id && !other.stopped && !other.closed) {
      for (const o of other.onceOrigins) keep.add(o);
    }
  }
  const drop = session.onceOrigins.filter((o) => !keep.has(o));
  if (drop.length) await chrome.permissions.remove({ origins: drop }).catch(() => undefined);
}

async function closeSessionLocal(id: string, tabGone: boolean): Promise<void> {
  const s = await updateSession(id, (x) => {
    x.closed = true;
    x.awaiting = null;
  });
  if (!s) return;
  if (!tabGone && s.tabId !== null) {
    await toContent(s.tabId, { type: 'cortex:banner', sessionId: id, on: false }).catch(
      () => undefined,
    );
  }
  await releaseOnce(s);
  await refreshBadge();
}

async function stopSessionLocal(id: string, notify: boolean): Promise<void> {
  const before = await sessionOf(id);
  if (!before || before.stopped || before.closed) return;
  const s = await updateSession(id, (x) => {
    x.stopped = true;
    x.awaiting = null;
  });
  if (!s) return;
  if (s.tabId !== null) {
    await toContent(s.tabId, { type: 'cortex:banner', sessionId: id, on: false }).catch(
      () => undefined,
    );
  }
  await releaseOnce(s);
  await logStep({ sessionId: id, text: 'La detuviste', ok: false });
  await refreshBadge();
  if (notify) await postEvent({ kind: 'stopped', sessionId: id });
}

async function stopAll(): Promise<void> {
  for (const s of Object.values(await getSessions())) {
    if (!s.stopped && !s.closed) await stopSessionLocal(s.id, true);
  }
}

async function personDone(sessionId: string, senderTabId: number | undefined): Promise<void> {
  const s = await sessionOf(sessionId);
  // Solo vale si viene de la pestaña de ESA sesión y de verdad estaba esperando.
  if (!s || s.tabId !== senderTabId || !s.awaiting || s.stopped || s.closed) return;
  await updateSession(sessionId, (x) => {
    x.awaiting = null;
  });
  if (s.tabId !== null)
    await toContent(s.tabId, { type: 'cortex:clear-await' }).catch(() => undefined);
  if (s.tabId !== null) await bannerOn({ ...s, awaiting: null });
  await logStep({ sessionId, text: 'Terminaste lo que te pidió', ok: true });
  await postEvent({ kind: 'person_done', sessionId });
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  for (const s of Object.values(await getSessions())) {
    if (s.tabId === tabId && !s.stopped && !s.closed) {
      await closeSessionLocal(s.id, true);
      await postEvent({ kind: 'tab_closed', sessionId: s.id });
    }
  }
});

// La franja vuelve a pintarse cuando la pestaña de trabajo navega.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  for (const s of Object.values(await getSessions())) {
    if (s.tabId === tabId && !s.stopped && !s.closed) {
      const st = await getStored();
      const url = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? '';
      const v = decideConsent({
        url,
        rules: (st?.rules ?? []).map(({ site, decision }) => ({ site, decision })),
        onceSites: s.onceSites,
        protectedSites: protectedHostsOf(st?.origin ?? ''),
      });
      if (v.kind === 'allow') await bannerOn(s).catch(() => undefined);
    }
  }
});

// ---------------------------------------------------------------------------
// Mensajes de la propia extensión
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((raw: ToBackground, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const fromExtensionPage = Boolean(sender.url?.startsWith(chrome.runtime.getURL('')));
  void (async () => {
    switch (raw.type) {
      case 'wake':
        if (fromExtensionPage) void startLoop();
        break;
      case 'consent-result': {
        // Solo la ventana de consentimiento puede decidir.
        if (sender.url?.startsWith(chrome.runtime.getURL('consent.html'))) {
          pendingConsents.get(raw.id)?.(raw.decision);
        }
        break;
      }
      case 'person-done':
        // Viene del script de la página (franja): debe traer la pestaña.
        if (sender.tab?.id !== undefined) await personDone(raw.sessionId, sender.tab.id);
        break;
      case 'stop': {
        const s = await sessionOf(raw.sessionId);
        // De la franja de SU pestaña, o del panel lateral.
        if (s && (fromExtensionPage || sender.tab?.id === s.tabId))
          await stopSessionLocal(raw.sessionId, true);
        break;
      }
      case 'stop-all':
        if (fromExtensionPage) await stopAll();
        break;
      case 'remove-rule':
        if (fromExtensionPage) await removeRule(raw.site);
        break;
      case 'unpair':
        if (fromExtensionPage) await unpair(true);
        break;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

async function removeRule(site: string): Promise<void> {
  const st = await getStored();
  if (!st || !validSite(site)) return;
  const had = st.rules.find((r) => r.site === site);
  await setStored({ ...st, rules: st.rules.filter((r) => r.site !== site) });
  if (had?.decision === 'always') {
    await chrome.permissions.remove({ origins: [originPattern(site)] }).catch(() => undefined);
  }
  await postEvent({ kind: 'site_removed', site });
}

async function unpair(remote: boolean): Promise<void> {
  await stopAll();
  if (remote) {
    await api('/api/extension/unpair', { method: 'POST', body: '{}' }).catch(() => undefined);
  }
  const st = await getStored();
  // Se retiran los permisos que la extensión pidió para trabajar en sitios.
  const origins = (st?.rules ?? [])
    .filter((r) => r.decision === 'always')
    .map((r) => originPattern(r.site));
  if (origins.length) await chrome.permissions.remove({ origins }).catch(() => undefined);
  await setStored(null);
  await chrome.storage.session.clear();
  await refreshBadge();
}

// ---------------------------------------------------------------------------
// La espera larga con Cortex
// ---------------------------------------------------------------------------

let looping = false;

interface PollReply {
  commands: unknown[];
  serverTime?: number;
  stops: string[];
  sites: Array<{ site: string; decision: 'always' | 'never' }>;
}

async function reconcileRules(remote: PollReply['sites']): Promise<void> {
  const st = await getStored();
  if (!st) return;
  const known = new Map(remote.map((r) => [r.site, r.decision]));
  const keep: LocalRule[] = [];
  const dropAlways: string[] = [];
  let changed = false;
  for (const r of st.rules) {
    if (r.synced && known.get(r.site) !== r.decision) {
      // La persona la quitó desde Ajustes: aquí también se olvida.
      changed = true;
      if (r.decision === 'always') dropAlways.push(originPattern(r.site));
      continue;
    }
    if (!r.synced && known.get(r.site) === r.decision) {
      changed = true;
      keep.push({ ...r, synced: true });
      continue;
    }
    keep.push(r);
  }
  // Reglas que quedaron sin avisar (sin conexión en su momento): se reintenta.
  for (const r of keep) {
    if (
      !r.synced &&
      known.get(r.site) !== r.decision &&
      (await postEvent({ kind: 'site_rule', site: r.site, decision: r.decision }))
    ) {
      r.synced = true;
      changed = true;
    }
  }
  if (changed) await setStored({ ...st, rules: keep });
  if (dropAlways.length)
    await chrome.permissions.remove({ origins: dropAlways }).catch(() => undefined);
}

async function startLoop(): Promise<void> {
  if (looping) return;
  looping = true;
  try {
    for (;;) {
      const st = await getStored();
      if (!st) break;
      try {
        const sessions = await getSessions();
        const ack = Object.values(sessions)
          .filter((s) => s.stopped || s.closed)
          .map((s) => s.id)
          .slice(-20)
          .join(',');
        const res = await api(
          `/api/extension/poll?wait=20&v=${VERSION}&ack=${encodeURIComponent(ack)}`,
          {
            timeoutMs: 29_000,
          },
        );
        if (res.status === 401) {
          // Revocado o vencido desde Cortex.
          await unpair(false);
          await chrome.storage.local.set({ notice: 'Este Chrome fue desvinculado desde Cortex.' });
          break;
        }
        if (!res.ok) {
          await sleep(5_000);
          continue;
        }
        await chrome.storage.local.set({ connectedAt: Date.now() });
        const data = (await res.json()) as PollReply;
        if (typeof data.serverTime === 'number' && Number.isFinite(data.serverTime)) {
          skewMs = data.serverTime - Date.now();
        }
        await reconcileRules(Array.isArray(data.sites) ? data.sites : []);
        for (const id of Array.isArray(data.stops) ? data.stops : []) {
          if (typeof id === 'string') await stopSessionLocal(id, false);
        }
        for (const c of Array.isArray(data.commands) ? data.commands : []) void handleCommand(c);
      } catch {
        await sleep(4_000);
      }
    }
  } finally {
    looping = false;
  }
}

// Al arrancar el navegador / instalar / cada medio minuto: asegurar la espera.
chrome.runtime.onStartup.addListener(() => void startLoop());
chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
  void startLoop();
});
chrome.alarms.create('cortex-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'cortex-keepalive') void startLoop();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.cortex?.newValue) void startLoop();
});
void startLoop();
void refreshBadge();

// Referencias usadas solo para tipos y utilidades compartidas.
void siteOf;
void siteOfUrl;
