'use client';

import { useMemo, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Copy, Hash, MessageSquare } from 'lucide-react';
import { Panel } from '@/components/ui/panel';
import { type ParamDef, runSentence } from '../_lib/playbook';

/**
 * "Run it": fill the declared parameters, get the exact sentence to say to
 * Cortex, copy it. Chat has no prompt-prefill entry point today, so this stays
 * copy-to-clipboard rather than deep-linking into /chat.
 */
export function RunItPanel({ slug, params }: { slug: string; params: ParamDef[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);

  const sentence = useMemo(() => runSentence(slug, params, values), [slug, params, values]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sentence);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Panel className="p-4">
      <div className="field-label mb-2">Ejecutarlo</div>
      <p className="mb-3 text-xs text-ink-muted">
        Llena los datos y dile esta frase a Cortex: en el chat de la web, desde Claude o desde una
        rutina programada.
      </p>

      {params.length > 0 && (
        <div className="mb-3 space-y-2">
          {params.map((p) => (
            <label key={p.name} className="block">
              <span className="mb-1 flex items-center gap-1 font-mono text-micro font-semibold text-ink">
                <Hash className="h-3 w-3 text-primary" />
                {p.name}
                {p.required !== false && <span className="text-rose">*</span>}
              </span>
              <input
                value={values[p.name] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                placeholder={p.description || `Valor de ${p.name}`}
                className="w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-xs text-ink transition-colors placeholder:text-ink-faint focus:border-primary/40 focus:outline-none focus:ring-4 focus:ring-primary/10"
              />
            </label>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2 rounded-card border border-border bg-surface-2 px-3 py-2.5">
        <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
        <code className="min-w-0 flex-1 break-words text-xs leading-relaxed text-ink">
          {sentence}
        </code>
      </div>

      <button
        type="button"
        onClick={copy}
        className={clsx(
          'mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-pill px-3 py-2 text-xs font-semibold transition-all duration-150 motion-reduce:transform-none motion-reduce:transition-none',
          copied
            ? 'bg-emerald-soft text-emerald'
            : 'bg-primary text-white shadow-pop hover:-translate-y-px hover:bg-primary-strong',
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        {copied ? 'Copiada' : 'Copiar la frase'}
      </button>
    </Panel>
  );
}
