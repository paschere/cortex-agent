'use client';

import { Input } from '@/components/ui/input';
import {
  DELIVER_TO,
  DELIVER_TO_HINT,
  DELIVER_TO_LABEL,
  DELIVER_WHEN,
  DELIVER_WHEN_LABEL,
  type DeliverTo,
  type DeliverWhen,
  type FlowDelivery,
  MODULE,
  OUTPUT_KINDS,
  OUTPUT_KIND_HINT,
  OUTPUT_KIND_LABEL,
  type OutputKind,
} from '@/lib/browser-shape';
import { clsx } from 'clsx';
import { Inbox, MessageSquare, Save } from 'lucide-react';

/**
 * Qué produce el trámite y dónde llega — el mismo control en los dos sitios
 * donde se decide: al revisar una grabación recién hecha, y después, en la fila
 * del trámite, cuando alguien cambia de opinión.
 *
 * ---------------------------------------------------------------------------
 * NO HAY CAMPO «PARA:», Y ESO ES EL DISEÑO
 * ---------------------------------------------------------------------------
 * Everything here delivers to whoever asked for the run. A free-text recipient
 * would have been one input box and a brand-new way for a downloaded
 * certificate to leave the company on a schedule, with no approval anywhere in
 * the path — the only such path in the product. So the screen says out loud
 * what the schema enforces: this is Cortex telling you, not Cortex sending.
 *
 * The one sentence at the bottom is not boilerplate. It is where somebody who
 * came looking for "mándaselo al cliente" finds out where that lives instead.
 */
export function DeliveryFields({
  value,
  onChange,
  saving,
}: {
  value: FlowDelivery;
  onChange: (next: FlowDelivery) => void;
  /** Shown in the row editor, where every change is written immediately. */
  saving?: 'idle' | 'saving' | 'saved';
}) {
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="field-label mb-1.5">Qué produce</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup">
          {OUTPUT_KINDS.map((kind) => (
            <Choice
              key={kind}
              active={value.outputKind === kind}
              label={OUTPUT_KIND_LABEL[kind]}
              onSelect={() => onChange({ ...value, outputKind: kind as OutputKind })}
            />
          ))}
        </div>
        <p className="mt-1.5 text-micro leading-snug text-ink-faint">
          {OUTPUT_KIND_HINT[value.outputKind]}
        </p>

        {value.outputKind !== 'confirmation' && (
          <div className="mt-2.5 max-w-sm">
            <label className="field-label" htmlFor="delivery-label">
              Cómo se llama
            </label>
            <Input
              id="delivery-label"
              className="mt-1"
              value={value.outputLabel}
              maxLength={120}
              placeholder={
                value.outputKind === 'document'
                  ? 'Certificado de tradición'
                  : 'Estado del vehículo'
              }
              onChange={(e) => onChange({ ...value, outputLabel: e.target.value })}
            />
            <p className="mt-1 text-micro leading-snug text-ink-faint">
              Es lo que va en el asunto del correo. «Certificado de tradición · listo» se lee de un
              vistazo en el celular; el nombre del {MODULE.one} y una duración, no.
            </p>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend className="field-label mb-1.5">Dónde te llega</legend>
        <div className="flex flex-wrap gap-1.5" role="radiogroup">
          {DELIVER_TO.map((to) => (
            <Choice
              key={to}
              active={value.deliverTo === to}
              label={DELIVER_TO_LABEL[to]}
              icon={to === 'chat' ? MessageSquare : to === 'email' ? Inbox : Save}
              onSelect={() => onChange({ ...value, deliverTo: to as DeliverTo })}
            />
          ))}
        </div>
        <p className="mt-1.5 text-micro leading-snug text-ink-faint">
          {DELIVER_TO_HINT[value.deliverTo]}
        </p>
      </fieldset>

      {value.deliverTo !== 'none' && (
        <fieldset>
          <legend className="field-label mb-1.5">Cuándo avisar</legend>
          <div className="flex flex-wrap gap-1.5" role="radiogroup">
            {DELIVER_WHEN.map((when) => (
              <Choice
                key={when}
                active={value.deliverWhen === when}
                label={DELIVER_WHEN_LABEL[when]}
                onSelect={() => onChange({ ...value, deliverWhen: when as DeliverWhen })}
              />
            ))}
          </div>
          <p className="mt-1.5 text-micro leading-snug text-ink-faint">
            {value.deliverWhen === 'always'
              ? 'Si falla, te aviso igual y por el mismo lado: enterarte de que el documento no salió es más urgente que recibirlo cuando sale.'
              : 'Te escribo sólo si no salió. Para algo que corre todos los días y casi siempre funciona.'}
          </p>
        </fieldset>
      )}

      <p className="border-t border-border pt-3 text-micro leading-snug text-ink-faint">
        Esto siempre le llega a quien pidió el {MODULE.one}, nunca a un tercero — por eso no hay
        casilla de destinatario. Para mandarle algo a un cliente están las herramientas de correo,
        que piden aprobación de una persona antes de salir.
        {saving === 'saving' && <span className="ml-1 text-ink-muted">Guardando…</span>}
        {saving === 'saved' && <span className="ml-1 text-emerald">Guardado.</span>}
      </p>
    </div>
  );
}

function Choice({
  active,
  label,
  icon: Icon,
  onSelect,
}: {
  active: boolean;
  label: string;
  icon?: typeof Inbox;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-medium transition-colors duration-150',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none',
        active
          ? 'bg-ink text-white'
          : 'border border-border bg-surface text-ink-muted hover:bg-surface-2 hover:text-ink',
      )}
    >
      {Icon && <Icon className="h-3 w-3" aria-hidden="true" />}
      {label}
    </button>
  );
}
