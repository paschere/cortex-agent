'use client';

import { canonicalOf, displayOf, maskTyping } from '@/lib/forms/number-mask';
import { clsx } from 'clsx';
import { useEffect, useState } from 'react';

/**
 * Un número o una cantidad de dinero, escrito como se escribe en Colombia:
 * «1.250.000» con el punto de los miles y la coma de los decimales, con el
 * teclado numérico del teléfono. El valor que sube al formulario es el de
 * máquina («1250000.5»); lo que se ve lo pone la máscara (lib/forms/number-mask).
 *
 * Dinero: pesos completos, con «$» dentro del campo. No hay botones de subir y
 * bajar (en un teléfono estorban); sí «inputMode» para abrir el teclado correcto.
 */
export function NumberInput({
  id,
  value,
  onChange,
  onBlur,
  money,
  decimals,
  negative,
  invalid,
  describedBy,
  className,
  placeholder,
}: {
  id: string;
  /** Valor de máquina («1250000.5»). */
  value: string;
  onChange: (next: string) => void;
  onBlur?: () => void;
  money?: boolean;
  decimals: number;
  negative?: boolean;
  invalid?: boolean;
  describedBy?: string;
  className: string;
  placeholder?: string;
}) {
  const opts = { decimals, negative };
  const [text, setText] = useState(() => displayOf(value, opts));

  // Si el valor cambia desde afuera (autollenado, dictado, escaneo), se muestra igual.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opts se deriva de decimals y negative.
  useEffect(() => {
    setText((cur) => (canonicalOf(cur) === value ? cur : displayOf(value, { decimals, negative })));
  }, [value, decimals, negative]);

  return (
    <span className="relative block">
      {money && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-4 flex items-center font-semibold text-ink-muted"
        >
          $
        </span>
      )}
      <input
        id={id}
        type="text"
        inputMode={decimals > 0 || negative ? 'decimal' : 'numeric'}
        autoComplete="off"
        enterKeyHint="next"
        value={text}
        onChange={(e) => {
          const masked = maskTyping(e.target.value, opts);
          setText(masked);
          const canon = canonicalOf(masked);
          if (canon !== value) onChange(canon);
        }}
        onBlur={() => {
          // Al salir se pule: «12,» → «12».
          setText(displayOf(canonicalOf(text), opts));
          onBlur?.();
        }}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        placeholder={placeholder}
        className={clsx(className, 'tabular font-mono', money && 'pl-9 text-right')}
      />
    </span>
  );
}
