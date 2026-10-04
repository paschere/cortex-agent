import {
  CAPABILITIES,
  type Level,
  ROLES_INFO,
  ROLE_KEYS,
  type RoleKey,
} from '@/lib/team/role-matrix';
import { clsx } from 'clsx';
import { Check, Minus } from 'lucide-react';

/**
 * «¿Qué puede hacer cada rol?»: la matriz de lib/team/role-matrix.ts pintada.
 * No contiene ningún permiso propio; si algo aquí está mal, está mal en esa
 * constante y se corrige allá.
 */

function Cell({ level, note }: { level: Level; note?: string }) {
  if (level === 'yes') {
    return (
      <span className="inline-flex items-center justify-center text-emerald" title="Sí">
        <Check className="h-4 w-4" aria-hidden />
        <span className="sr-only">Sí</span>
      </span>
    );
  }
  if (level === 'partial') {
    return (
      <span className="inline-flex flex-col items-center text-micro font-semibold text-amber">
        <span>Parcial</span>
        {note && <span className="font-normal text-ink-muted">{note}</span>}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center text-ink-faint" title="No">
      <Minus className="h-4 w-4" aria-hidden />
      <span className="sr-only">No</span>
    </span>
  );
}

export function RoleMatrix({ highlight }: { highlight?: RoleKey }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-xs">
        <thead className="border-b border-border-strong bg-surface-2">
          <tr className="text-left">
            <th className="field-label px-4 py-2.5">Puede…</th>
            {ROLE_KEYS.map((role) => (
              <th
                key={role}
                className={clsx(
                  'px-3 py-2.5 text-center align-bottom',
                  highlight === role && 'bg-primary-soft/60',
                )}
              >
                <span
                  className={clsx(
                    'inline-block rounded-pill border px-2 py-0.5 text-micro font-semibold',
                    ROLES_INFO[role].chip,
                  )}
                >
                  {ROLES_INFO[role].label}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {CAPABILITIES.map((capability) => (
            <tr key={capability.id} className="border-t border-border">
              <th scope="row" className="px-4 py-2.5 text-left font-normal">
                <span className="block font-semibold text-ink">{capability.label}</span>
                {capability.hint && (
                  <span className="block text-micro text-ink-faint">{capability.hint}</span>
                )}
              </th>
              {ROLE_KEYS.map((role) => (
                <td
                  key={role}
                  className={clsx(
                    'px-3 py-2.5 text-center',
                    highlight === role && 'bg-primary-soft/40',
                  )}
                >
                  <Cell level={capability.levels[role]} note={capability.notes?.[role]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
