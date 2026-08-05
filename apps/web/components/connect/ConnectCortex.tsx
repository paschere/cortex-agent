'use client';

import { clsx } from 'clsx';
import { Bot, Check, Copy, MessagesSquare, Plug, Terminal } from 'lucide-react';
import { useState } from 'react';

type TargetId = 'claude' | 'chatgpt' | 'claude-code' | 'other';

const TARGET_ORDER = [
  'claude',
  'chatgpt',
  'claude-code',
  'other',
] as const satisfies readonly TargetId[];

interface Target {
  id: TargetId;
  label: string;
  icon: React.ReactNode;
  /** Small line under the tabs describing where this applies. */
  caption: string;
  /** Numbered steps. `**text**` renders emphasized (menu paths, buttons). */
  steps: string[];
  /** Optional copyable snippet rendered under the steps. */
  snippet?: string;
  /** Optional honest caveat / tip. */
  note?: string;
}

/** Splits `**bold**` markers into renderable, uniquely keyed segments. */
function segments(text: string): { key: string; text: string; bold: boolean }[] {
  const out: { key: string; text: string; bold: boolean }[] = [];
  const parts = text.split('**');
  let offset = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const chunk = parts[i] ?? '';
    if (chunk) out.push({ key: `${offset}:${chunk}`, text: chunk, bold: i % 2 === 1 });
    offset += chunk.length + 2;
  }
  return out;
}

function Step({ text }: { text: string }) {
  return (
    <>
      {segments(text).map((s) =>
        s.bold ? (
          <strong key={s.key} className="font-semibold text-ink">
            {s.text}
          </strong>
        ) : (
          <span key={s.key}>{s.text}</span>
        ),
      )}
    </>
  );
}

/**
 * Copies `text` and flips to a Check + "Copied" label for ~2s.
 *
 * Exported because the dashboard and the connect page both need it; it is the
 * only client-side bit of an otherwise server-rendered surface.
 */
export function CopyButton({
  text,
  label = 'Copiar',
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard may be unavailable (e.g. insecure context); fail silently.
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? 'Copiado' : label}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-3 py-1.5 text-[11.5px] font-semibold transition-colors duration-150 motion-reduce:transition-none',
        copied
          ? 'border-emerald/20 bg-emerald-soft text-emerald'
          : 'border-border bg-surface text-ink-muted hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink',
        className,
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copiado' : label}
    </button>
  );
}

/** Mono line + its own copy button. */
function CodeLine({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-sm border border-border bg-surface-2 px-3 py-2">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[11.5px] leading-relaxed text-ink">
        {text}
      </code>
      <CopyButton text={text} />
    </div>
  );
}

/** The connector URL, plus per-client setup steps. Single source of truth. */
export function ConnectCortex({ url }: { url: string }) {
  const [active, setActive] = useState<TargetId>('claude');

  const targets: Record<TargetId, Target> = {
    claude: {
      id: 'claude',
      label: 'Claude',
      icon: <Bot className="h-3.5 w-3.5" />,
      caption: 'Claude en la web, en el escritorio y en el celular',
      steps: [
        'Abre **Configuración → Conectores**.',
        'Elige **Agregar conector personalizado**.',
        'Pega la URL del conector que está arriba.',
        'Inicia sesión con tu cuenta de Google **del trabajo** y dale **Aprobar**.',
      ],
      note: 'Ya dentro de un chat, activa el conector en el menú de herramientas para que Cortex pueda usarlo.',
    },
    chatgpt: {
      id: 'chatgpt',
      label: 'ChatGPT',
      icon: <MessagesSquare className="h-3.5 w-3.5" />,
      caption: 'ChatGPT con los conectores habilitados',
      steps: [
        'Abre **Configuración → Conectores**; según tu plan puede aparecer como conector personalizado o como modo desarrollador.',
        'Agrega un servidor MCP apuntando a la misma URL de arriba.',
        'Autoriza con tu cuenta de Google cuando te lo pida.',
      ],
      note: 'Depende del plan de ChatGPT que tengas, y puede que todavía aparezca marcado como beta.',
    },
    'claude-code': {
      id: 'claude-code',
      label: 'Claude Code',
      icon: <Terminal className="h-3.5 w-3.5" />,
      caption: 'La CLI, en cualquier terminal',
      steps: [
        'Corre el comando de abajo una sola vez: deja Cortex registrado en tu usuario.',
        'Autoriza en la ventana del navegador que se abre.',
      ],
      snippet: `claude mcp add --transport http cortex ${url}`,
      note: '¿Estás trabajando dentro del repo cortex-agent? Ahí se toma solo del .mcp.json: no hay nada que configurar.',
    },
    other: {
      id: 'other',
      label: 'Otros clientes',
      icon: <Plug className="h-3.5 w-3.5" />,
      caption: 'Cursor, Windsurf o tu propio cliente',
      steps: [
        'Sirve cualquier cliente que soporte **servidores MCP remotos con OAuth 2.1**.',
        'Registra la misma URL como servidor MCP remoto.',
        'Completa el inicio de sesión con Google que te abre el cliente.',
      ],
      snippet: url,
      note: 'El descubrimiento es automático: el cliente lee los datos de autorización y la lista de herramientas desde la misma URL.',
    },
  };

  const current = targets[active];

  return (
    <div className="mt-4">
      {/* Connector URL */}
      <div className="field-label">URL del conector</div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-[13px] font-semibold text-ink">
          {url}
        </code>
        <CopyButton text={url} label="Copiar la URL" />
      </div>

      {/* Target picker */}
      <div className="mt-4 flex flex-wrap gap-1 rounded-pill border border-border bg-surface-2 p-1">
        {TARGET_ORDER.map((id) => targets[id]).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setActive(t.id)}
            aria-pressed={t.id === active}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[12.5px] font-semibold transition-all duration-150 motion-reduce:transition-none',
              t.id === active
                ? 'bg-surface text-primary-ink shadow-card'
                : 'text-ink-muted hover:bg-surface/60 hover:text-ink',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Steps for the active target */}
      <div className="mt-3 rounded-card border border-border bg-surface p-4">
        <div className="text-[11.5px] text-ink-faint">{current.caption}</div>
        <ol className="mt-2.5 space-y-2">
          {current.steps.map((step, i) => (
            <li key={step} className="flex items-start gap-2.5">
              <span className="stat-num mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary-soft text-[11px] text-primary">
                {i + 1}
              </span>
              <span className="text-[12.5px] leading-relaxed text-ink-muted">
                <Step text={step} />
              </span>
            </li>
          ))}
        </ol>

        {current.snippet && (
          <div className="mt-3">
            <CodeLine text={current.snippet} />
          </div>
        )}

        {current.note && (
          <>
            <div className="rule-double mt-3" />
            <p className="mt-2.5 text-[11.5px] leading-relaxed text-ink-faint">{current.note}</p>
          </>
        )}
      </div>
    </div>
  );
}
