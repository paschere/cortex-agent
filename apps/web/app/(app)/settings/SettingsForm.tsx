'use client';

import {
  type ChatDmStatus,
  type PreferencesView,
  TIMEZONES,
} from '@/app/api/settings/preferences/schema';
import { Button } from '@/components/ui/button';
import { Eyebrow, Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  Check,
  ChevronDown,
  Loader2,
  Mail,
  MessageCircle,
  Send,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';

type Status =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'error'; message: string };

/**
 * This form's shared field styling — nested inside a Panel, so it takes the
 * smaller radius, and the same ring-based focus <Input> uses elsewhere in the
 * product rather than the browser's default outline.
 */
const FIELD =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint transition-colors focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60';

/**
 * A labelled switch — the same control the master opt-in and the channels use.
 * Pill-shaped track and knob, indigo when on, with the knob sliding smoothly
 * between the two.
 */
function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-ink">{label}</div>
        {description && (
          <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={clsx(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-pill border transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
          checked ? 'border-primary bg-primary' : 'border-border bg-surface-2',
          disabled && 'cursor-not-allowed opacity-50',
        )}
      >
        <span
          className={clsx(
            'absolute left-[2px] top-[3px] h-[18px] w-[18px] rounded-pill bg-white shadow-card',
            'transition-transform duration-200 ease-out motion-reduce:transition-none motion-reduce:transform-none',
            checked && 'translate-x-[20px]',
          )}
        />
      </button>
    </div>
  );
}

export function SettingsForm({
  initial,
  chatDm,
}: {
  initial: PreferencesView;
  /** Resolved on the server from `google_chat_links` — see the page component. */
  chatDm: ChatDmStatus;
}) {
  const [prefs, setPrefs] = useState<PreferencesView>(initial);
  const [saved, setSaved] = useState<PreferencesView>(initial);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [testStatus, setTestStatus] = useState<Status>({ kind: 'idle' });
  const [testDmStatus, setTestDmStatus] = useState<Status>({ kind: 'idle' });

  const set = <K extends keyof PreferencesView>(key: K, value: PreferencesView[K]) => {
    setPrefs((p) => ({ ...p, [key]: value }));
    setStatus({ kind: 'idle' });
  };

  async function save() {
    setStatus({ kind: 'saving' });
    try {
      const res = await fetch('/api/settings/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inboxDigestEnabled: prefs.inboxDigestEnabled,
          inboxDigestTime: prefs.inboxDigestTime,
          timezone: prefs.timezone,
          deliverEmail: prefs.deliverEmail,
          deliverChat: prefs.deliverChat,
          chatWebhookUrl: prefs.chatWebhookUrl,
          deliverChatDm: prefs.deliverChatDm,
          digestFocus: prefs.digestFocus,
          weeklyReportEnabled: prefs.weeklyReportEnabled,
          mailAlertsEnabled: prefs.mailAlertsEnabled,
          mailAlertsMaxPerDay: prefs.mailAlertsMaxPerDay,
          mailAlertsFrom: prefs.mailAlertsFrom,
          mailAlertsTo: prefs.mailAlertsTo,
        }),
      });
      const json = (await res.json()) as {
        preferences?: PreferencesView;
        error?: string;
      };
      if (!res.ok) {
        setStatus({
          kind: 'error',
          message: json.error ?? 'No se pudo guardar tu configuración. Vuelve a intentarlo.',
        });
        return;
      }
      // Lo que contestó el servidor ES lo guardado: si normalizó algo —una hora
      // a HH:MM, una URL con espacios de más— la comparación de «sin guardar»
      // tiene que hacerse contra eso y no contra lo que se tecleó, o el aviso se
      // quedaría encendido para siempre después de guardar bien.
      const stored = json.preferences ?? prefs;
      setPrefs(stored);
      setSaved(stored);
      setStatus({ kind: 'saved' });
    } catch {
      setStatus({ kind: 'error', message: 'No se pudo conectar con Cortex. Revisa tu conexión.' });
    }
  }

  async function sendTest() {
    setTestStatus({ kind: 'saving' });
    try {
      const res = await fetch('/api/settings/test-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookUrl: prefs.chatWebhookUrl }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      setTestStatus(
        res.ok
          ? { kind: 'saved' }
          : {
              kind: 'error',
              message: json.error ?? 'El mensaje de prueba no llegó. Revisa la URL del webhook.',
            },
      );
    } catch {
      setTestStatus({
        kind: 'error',
        message: 'No se pudo conectar con Cortex. Revisa tu conexión.',
      });
    }
  }

  /** No body: the route resolves the caller's own DM thread server-side. */
  async function sendTestDm() {
    setTestDmStatus({ kind: 'saving' });
    try {
      const res = await fetch('/api/settings/test-chat-dm', { method: 'POST' });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      setTestDmStatus(
        res.ok
          ? { kind: 'saved' }
          : {
              kind: 'error',
              message:
                json.error ?? 'El mensaje de prueba no llegó. Saluda a Cortex en Google Chat.',
            },
      );
    } catch {
      setTestDmStatus({
        kind: 'error',
        message: 'No se pudo conectar con Cortex. Revisa tu conexión.',
      });
    }
  }

  const on = prefs.inboxDigestEnabled;
  const dmReady = chatDm.configured && chatDm.linked;

  /**
   * SI HAY ALGO SIN GUARDAR, comparado contra lo último que el servidor
   * confirmó y no contra lo que se cargó al abrir. Es lo que decide si aparece
   * la barra de abajo, y por tanto lo único que impide el fallo que esta
   * pantalla tenía: cambiar una hora, irse a otra página y descubrir tres días
   * después que el resumen sigue llegando a la hora vieja. El botón «Guardar»
   * estaba al final de siete paneles; nada avisaba de que faltaba pulsarlo.
   *
   * Comparación por JSON y no campo a campo: son nueve valores planos, el orden
   * de las claves lo fija el propio objeto, y una lista de nueve `!==` es una
   * lista a la que alguien olvidará añadir el décimo campo.
   */
  const dirty = JSON.stringify(prefs) !== JSON.stringify(saved);

  return (
    <div className="space-y-4">
      {/* ---- The opt-in, and exactly what it means ------------------------- */}
      <Panel className="p-5">
        <Toggle
          checked={on}
          onChange={(v) => set('inboxDigestEnabled', v)}
          label="Resumen diario del correo"
          description="Una vez al día Cortex lee tu correo reciente y te manda un resumen corto: qué está esperando tu respuesta, qué estás esperando tú de otros y qué vale la pena saber."
        />

        {/* PLEGADO, Y NO BORRADO. Estas cinco frases son la concesión que se
            está pidiendo —dejar que un programa lea un buzón— así que no pueden
            desaparecer de la pantalla. Pero abiertas ocupaban más que todos los
            controles juntos, y lo que hay que leer una vez no debería estorbar
            todos los días. `<details>` y no un estado de React: se abre sin
            JavaScript, Ctrl+F lo encuentra dentro, y se imprime abierto. */}
        <details className="group mt-4 rounded-sm border border-border bg-surface-2">
          <summary className="flex cursor-pointer items-center gap-2 p-4 text-ink-muted transition-colors hover:text-ink">
            <ShieldCheck className="h-4 w-4 text-primary" />
            <Eyebrow>Qué lee Cortex y qué no</Eyebrow>
            <ChevronDown className="ml-auto h-4 w-4 transition-transform group-open:rotate-180" />
          </summary>
          <ul className="space-y-1.5 px-4 pb-4 text-xs leading-relaxed text-ink-muted">
            <li>
              <strong className="text-ink">Solo tu buzón.</strong> Cortex lee las conversaciones
              recientes de tu propio correo —quién escribió, cuándo, el asunto y el contenido— con
              el acceso de Google que ya diste al entrar. Nunca toca el correo de nadie más.
            </li>
            <li>
              <strong className="text-ink">Se resume de nuestro lado.</strong> Los mensajes se
              condensan en nuestros servidores para armar el resumen que recibes. El correo en sí no
              se guarda, no entra a Brain Knowledge y no se le pasa al asistente con el que chateas.
            </li>
            <li>
              <strong className="text-ink">Te llega solo a ti.</strong> El resumen va a tu correo, a
              un espacio de Google Chat que tú configures o como mensaje directo de Cortex que solo
              tú ves. Nunca se comparte con tu equipo, tu jefe ni nadie más.
            </li>
            <li>
              <strong className="text-ink">Los boletines quedan por fuera</strong> antes de que se
              lea nada a fondo, y cada resumen te dice qué dejó por fuera y por qué.
            </li>
            <li>
              <strong className="text-ink">Apagado es apagado.</strong> Apaga este interruptor y
              Cortex deja de leer tu correo de una vez.
            </li>
          </ul>
        </details>
      </Panel>

      {/* ---- When ---------------------------------------------------------- */}
      <Panel className={clsx('p-5 transition-opacity', !on && 'opacity-55')}>
        <Eyebrow>Cuándo llega</Eyebrow>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="digest-time" className="field-label mb-1 block">
              Hora
            </label>
            <input
              id="digest-time"
              type="time"
              value={prefs.inboxDigestTime}
              disabled={!on}
              onChange={(e) => set('inboxDigestTime', e.target.value)}
              className={clsx(FIELD, 'tabular')}
            />
          </div>
          <div>
            <label htmlFor="digest-tz" className="field-label mb-1 block">
              Zona horaria
            </label>
            <select
              id="digest-tz"
              value={prefs.timezone}
              disabled={!on}
              onChange={(e) => set('timezone', e.target.value)}
              className={FIELD}
            >
              {TIMEZONES.map((tz) => (
                <option key={tz.value} value={tz.value}>
                  {tz.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          Cortex revisa cada media hora, así que el resumen te llega dentro de los 30 minutos
          siguientes a la hora que elijas.
        </p>
      </Panel>

      {/* ---- Where --------------------------------------------------------- */}
      <Panel className={clsx('p-5 transition-opacity', !on && 'opacity-55')}>
        <Eyebrow>A dónde llega</Eyebrow>

        <div className="mt-3 space-y-4">
          <div className="rounded-sm border border-border p-4">
            <Toggle
              checked={prefs.deliverEmail}
              disabled={!on}
              onChange={(v) => set('deliverEmail', v)}
              label="Correo"
              description={
                <>
                  Se envía a <span className="tabular text-ink">{prefs.email}</span>
                </>
              }
            />
            <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-ink-faint">
              <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Es la dirección de tu cuenta de Cortex y no se puede cambiar desde aquí.
            </div>
          </div>

          <div className="rounded-sm border border-border p-4">
            <Toggle
              checked={prefs.deliverChat}
              disabled={!on}
              onChange={(v) => set('deliverChat', v)}
              label="Google Chat — un espacio"
              description="Se publica en el espacio que elijas, a través de un webhook que tú mismo creas. Todo el que esté en ese espacio lo puede leer."
            />

            <div className="mt-3">
              <label htmlFor="chat-webhook" className="field-label mb-1 block">
                URL del webhook
              </label>
              <input
                id="chat-webhook"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder="https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…"
                value={prefs.chatWebhookUrl}
                disabled={!on}
                onChange={(e) => {
                  set('chatWebhookUrl', e.target.value);
                  setTestStatus({ kind: 'idle' });
                }}
                className={clsx(FIELD, 'font-mono text-xs')}
              />

              <ol className="mt-2.5 space-y-1 text-xs leading-relaxed text-ink-muted">
                <li>1. En Google Chat, abre el espacio donde quieres el resumen.</li>
                <li>
                  2. Haz clic en el nombre del espacio →{' '}
                  <strong className="text-ink">Apps e integraciones</strong>.
                </li>
                <li>
                  3. Elige <strong className="text-ink">Webhooks</strong> →{' '}
                  <strong className="text-ink">Agregar webhook</strong> y ponle
                  &ldquo;Cortex&rdquo;.
                </li>
                <li>4. Copia la URL completa que te da y pégala arriba.</li>
              </ol>
              <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                Todo el que esté en ese espacio va a ver tu resumen. Si lo prefieres privado, usa un
                espacio que sea solo tuyo.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!on || !prefs.chatWebhookUrl || testStatus.kind === 'saving'}
                  onClick={sendTest}
                >
                  {testStatus.kind === 'saving' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <MessageCircle className="h-3.5 w-3.5" />
                  )}
                  Enviar un mensaje de prueba al espacio
                </Button>
                {testStatus.kind === 'saved' && (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald">
                    <Check className="h-3.5 w-3.5" />
                    Enviado. Revisa el espacio.
                  </span>
                )}
                {testStatus.kind === 'error' && (
                  <span className="flex items-start gap-1.5 text-xs text-rose">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {testStatus.message}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ---- Google Chat, privately ------------------------------------ */}
          <div className="rounded-sm border border-border p-4">
            <Toggle
              checked={prefs.deliverChatDm}
              disabled={!on || !chatDm.configured}
              onChange={(v) => {
                set('deliverChatDm', v);
                setTestDmStatus({ kind: 'idle' });
              }}
              label="Google Chat — mensaje directo"
              description="Cortex te manda el resumen directo por Google Chat. Nadie más está en esa conversación, y tus rutinas también llegan ahí."
            />

            <div className="mt-3">
              {/* The link status is the whole point of this block: without it,
                  the toggle is a checkbox that can silently do nothing. */}
              {!chatDm.configured ? (
                <div className="flex items-start gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    La app de Cortex para Chat todavía no está configurada en este entorno, así que
                    no se pueden enviar mensajes directos. Pídele a un administrador que la active.
                  </span>
                </div>
              ) : dmReady ? (
                <div className="flex items-start gap-2 rounded-sm border border-emerald/30 bg-emerald-soft px-3 py-2.5 text-xs leading-relaxed text-emerald">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Conectado como{' '}
                    <span className="tabular font-semibold">
                      {chatDm.displayName ?? prefs.email}
                    </span>
                    . Los mensajes te van a llegar a tu chat con Cortex.
                  </span>
                </div>
              ) : (
                <div className="rounded-sm border border-amber/30 bg-amber-soft px-3 py-2.5 text-xs leading-relaxed text-ink-muted">
                  <div className="flex items-start gap-2 font-medium text-amber">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>Todavía no está conectado, así que aquí no llega nada.</span>
                  </div>
                  <p className="mt-1.5 pl-[22px]">
                    Cortex solo puede escribir en una conversación que empezaste tú. Abre Google
                    Chat, busca <strong className="text-ink">Cortex</strong>, salúdalo y luego
                    recarga esta página.
                  </p>
                </div>
              )}

              <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                Esta es la opción privada: a diferencia del espacio de arriba, el resumen te llega
                solo a ti.
              </p>

              <div className="mt-3 flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!on || !dmReady || testDmStatus.kind === 'saving'}
                  onClick={sendTestDm}
                >
                  {testDmStatus.kind === 'saving' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5" />
                  )}
                  Enviar un mensaje de prueba
                </Button>
                {testDmStatus.kind === 'saved' && (
                  <span className="flex items-center gap-1.5 text-xs font-medium text-emerald">
                    <Check className="h-3.5 w-3.5" />
                    Enviado. Revisa tu chat con Cortex.
                  </span>
                )}
                {testDmStatus.kind === 'error' && (
                  <span className="flex items-start gap-1.5 text-xs text-rose">
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    {testDmStatus.message}
                  </span>
                )}
              </div>

              {prefs.deliverChatDm && chatDm.configured && !chatDm.linked && (
                <p className="mt-2.5 flex items-start gap-1.5 text-xs leading-relaxed text-amber">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  Puedes guardarlo ya, pero el resumen no va a llegar a Google Chat hasta que
                  saludes a Cortex allá.
                </p>
              )}
            </div>
          </div>
        </div>
      </Panel>

      {/* ---- Focus --------------------------------------------------------- */}
      <Panel className={clsx('p-5 transition-opacity', !on && 'opacity-55')}>
        <Eyebrow>Qué es lo que más te importa</Eyebrow>
        <p className="mt-1.5 text-xs leading-relaxed text-ink-muted">
          Cuéntale a Cortex cómo ordenar tu mañana, con tus propias palabras. Sirve para ordenar el
          resumen, no para decidir qué se lee.
        </p>
        <textarea
          value={prefs.digestFocus}
          disabled={!on}
          maxLength={600}
          rows={3}
          onChange={(e) => set('digestFocus', e.target.value)}
          placeholder="Primero los clientes, después lo de las vacantes abiertas. Los boletines internos al final."
          className={clsx(FIELD, 'mt-2.5 resize-y')}
        />
        <div className="tabular mt-1 text-right text-micro text-ink-faint">
          {prefs.digestFocus.length}/600
        </div>
      </Panel>

      {/* ---- Avisos en el momento ------------------------------------------ */}
      {/* FUERA DEL BLOQUE ATENUADO POR `on`, y es una decisión, no un descuido:
          esto no es el resumen a otra hora, es lo contrario. El resumen se lee
          cuando la persona quiere; esto suena cuando Cortex quiere. Por eso se
          concede aparte, viene apagado, y trae sus dos frenos a la vista —
          cuántos y entre qué horas— en la misma tarjeta donde se enciende: un
          interruptor que puede interrumpirte no puede esconder su techo en otra
          pantalla. */}
      <Panel className="p-5">
        <Toggle
          checked={prefs.mailAlertsEnabled}
          onChange={(v) => set('mailAlertsEnabled', v)}
          label="Avisarme en el momento"
          description="Cuando llegue al correo algo que no puede esperar al resumen — un cliente registrado esperando respuesta, o alguien con quien tienes un compromiso con fecha — Cortex te avisa en cuanto lo ve, no a la mañana siguiente."
        />

        <div
          className={clsx(
            'mt-4 grid gap-4 transition-opacity sm:grid-cols-3',
            !prefs.mailAlertsEnabled && 'opacity-55',
          )}
        >
          <label className="block">
            <span className="text-micro font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Como mucho al día
            </span>
            <input
              type="number"
              min={0}
              max={20}
              value={prefs.mailAlertsMaxPerDay}
              disabled={!prefs.mailAlertsEnabled}
              onChange={(e) => set('mailAlertsMaxPerDay', Number(e.target.value))}
              className={clsx(FIELD, 'tabular mt-1.5')}
            />
          </label>
          <label className="block">
            <span className="text-micro font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Desde
            </span>
            <input
              type="time"
              value={prefs.mailAlertsFrom}
              disabled={!prefs.mailAlertsEnabled}
              onChange={(e) => set('mailAlertsFrom', e.target.value)}
              className={clsx(FIELD, 'tabular mt-1.5')}
            />
          </label>
          <label className="block">
            <span className="text-micro font-semibold uppercase tracking-[0.12em] text-ink-faint">
              Hasta
            </span>
            <input
              type="time"
              value={prefs.mailAlertsTo}
              disabled={!prefs.mailAlertsEnabled}
              onChange={(e) => set('mailAlertsTo', e.target.value)}
              className={clsx(FIELD, 'tabular mt-1.5')}
            />
          </label>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Un hilo te avisa una sola vez, y fuera de esas horas nada suena: el correo se guarda igual
          y lo ves en el resumen. Las horas son las de tu zona ({prefs.timezone}).
        </p>
      </Panel>

      {/* ---- El parte semanal ---------------------------------------------- */}
      {/* Fuera del bloque atenuado por `on`: no depende del resumen diario ni
          lo necesita. Y viene encendido, al contrario que todo lo de arriba —
          aquello concede que Cortex lea un buzón ajeno; esto sólo decide si la
          empresa te manda por correo lo que ya puedes abrir en la aplicación. */}
      <Panel className="p-5">
        <Toggle
          checked={prefs.weeklyReportEnabled}
          onChange={(v) => set('weeklyReportEnabled', v)}
          label="Parte semanal de la empresa"
          description="Cada lunes temprano, un informe de lo que pasó la semana pasada y lo que viene: qué se venció, qué se cumplió, quién debe qué, qué propuse y en qué quedó, y a qué nadie contestó. Sale solo, sin que nadie lo pida."
        />
        <p className="mt-3 text-xs leading-relaxed text-ink-faint">
          Sólo llega a quienes son administradores del espacio de trabajo. Aunque lo apagues, el
          parte se sigue guardando en Informes: lo que se apaga es el correo, no el informe.
        </p>
      </Panel>

      {/* ---- Guardar ------------------------------------------------------- */}
      {/* PEGADA ABAJO Y SÓLO CUANDO HAY ALGO QUE GUARDAR.
          Antes era un botón al final de siete paneles: quien cambiaba la hora
          arriba tenía que bajar hasta el fondo, y quien no bajaba se iba
          creyendo que había guardado. Ahora la barra aparece en cuanto algo
          cambia y sigue a la vista mientras se sigue tocando la pantalla — el
          botón está donde están los ojos.
          Cuando no hay cambios no hay barra: una franja permanente con un botón
          que no hace nada es ruido en todas las visitas para servir a una. */}
      {(dirty || status.kind !== 'idle') && (
        <div className="sticky bottom-4 z-10 pb-2">
          <div className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface/95 px-4 py-3 shadow-card backdrop-blur">
            {dirty ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-amber">
                <TriangleAlert className="h-3.5 w-3.5" />
                Tienes cambios sin guardar.
              </span>
            ) : status.kind === 'saved' ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-emerald">
                <Check className="h-3.5 w-3.5" />
                Guardado.
              </span>
            ) : null}

            {status.kind === 'error' && (
              <span className="flex items-start gap-1.5 text-xs text-rose">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {status.message}
              </span>
            )}

            <div className="ml-auto flex items-center gap-2">
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setPrefs(saved);
                    setStatus({ kind: 'idle' });
                  }}
                  disabled={status.kind === 'saving'}
                >
                  Descartar
                </Button>
              )}
              <Button type="button" onClick={save} disabled={!dirty || status.kind === 'saving'}>
                {status.kind === 'saving' && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Guardar
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
