import { Panel, PanelHead } from '@/components/ui/panel';
import type { LineNode, OrgLine } from '@cortex/agent-tools';
import { personLabel } from '@cortex/agent-tools';
import { AlertTriangle, Network } from 'lucide-react';
import Link from 'next/link';

/**
 * QUIÉN LE RESPONDE A QUIÉN, EN LA PANTALLA QUE VE TODO EL MUNDO.
 *
 * ===========================================================================
 * POR QUÉ ESTO SE VE AQUÍ Y SE CAMBIA EN «PERSONAS»
 * ===========================================================================
 * Ésta es la guarda que decide si la línea de mando sobrevive como producto, y
 * no es de seguridad sino de confianza: NADIE PUEDE TENER EN CORTEX UN JEFE QUE
 * NO PUEDA VER. La columna decide a quién le escribe Cortex cuando alguien deja
 * caer algo — es decir, decide quién se entera de tus incumplimientos. Un
 * producto que hace eso sin enseñarte la línea es un producto que escala a tus
 * espaldas, y eso es la forma más rápida de que la gente lo odie y lo desactive.
 *
 * La otra mitad de la guarda ya estaba puesta y no se toca: `noticesOwed`
 * (packages/agent-tools/src/commitments/shape.ts) sólo produce un escalado
 * cuando A TI te avisaron y no respondiste. Nunca hay un correo a tu jefe sin un
 * correo previo a ti.
 *
 * Vive en `/company` y no en `/admin/users` por el mismo argumento con el que
 * `/company` existe fuera de `/admin`: aquel layout hace `notFound()` a quien no
 * es admin, y heredarlo aquí habría escondido precisamente lo que hay que
 * enseñar. Cambiarla sí es de admin, y eso se hace cumplir en el servidor.
 *
 * ===========================================================================
 * LO QUE ESTE BLOQUE DICE QUE NO ES, Y POR QUÉ LO REPITE
 * ===========================================================================
 * NO ES EL ORGANIGRAMA. Sólo cubre a quien tiene cuenta en Cortex. Es la misma
 * trampa que este módulo ya esquivó al negarse a contar empleados desde `users`
 * —«8 cuentas en una empresa de 40» es una cifra exacta y una respuesta falsa— y
 * aquí es peor, porque un árbol se lee como completo: nadie mira un organigrama
 * preguntándose a quién le falta. Por eso la cifra de cuentas va en el
 * subtítulo, siempre, y no sólo cuando el árbol está vacío.
 *
 * Y por eso este bloque va DEBAJO de la ficha y no dentro de la sección «Quién
 * es quién», que la escribe una persona a mano. Las dos contestan cosas
 * distintas y las dos hacen falta: aquélla dice quién DECIDE qué —incluida gente
 * sin cuenta— y ésta dice quién RESPONDE ante quién entre los que sí la tienen.
 * Derivar la una de la otra convertiría una de las dos en una mentira con forma
 * de dato.
 */

function Branch({ node, level }: { node: LineNode; level: number }) {
  return (
    <li>
      <div className="flex items-baseline gap-2 py-1" style={{ paddingLeft: `${level * 1.25}rem` }}>
        {level > 0 && (
          <span aria-hidden className="select-none text-micro text-ink-faint">
            └
          </span>
        )}
        <span className="text-xs font-semibold text-ink">{personLabel(node.person)}</span>
        {node.reports.length > 0 && (
          <span className="tabular text-micro text-ink-faint">
            {node.reports.length} {node.reports.length === 1 ? 'persona' : 'personas'}
          </span>
        )}
        {node.broken && (
          <span className="inline-flex items-center gap-1 rounded-pill border border-rose/40 bg-rose-soft px-2 py-0.5 text-micro font-semibold text-rose">
            <AlertTriangle className="h-3 w-3" aria-hidden />
            su jefe cierra un círculo
          </span>
        )}
      </div>
      {node.reports.length > 0 && (
        <ul>
          {node.reports.map((child) => (
            <Branch key={child.person.id} node={child} level={level + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function ReportingLine({
  line,
  total,
  canEdit,
}: {
  line: OrgLine;
  /** Cuentas en el espacio de trabajo. NO es cuánta gente trabaja aquí. */
  total: number;
  canEdit: boolean;
}) {
  return (
    <Panel>
      <PanelHead
        icon={<Network className="h-4 w-4" aria-hidden />}
        title="Quién le responde a quién"
        right={
          canEdit ? (
            <Link
              href="/admin/users"
              className="text-micro font-semibold text-primary transition-opacity hover:opacity-80"
            >
              Cambiarlo en Personas
            </Link>
          ) : null
        }
      />
      <div className="px-5 pb-5 pt-2">
        <p className="mb-3 max-w-2xl text-xs leading-relaxed text-ink-muted">
          Cuando alguien deja vencer un compromiso y no contesta al aviso, Cortex se lo dice a su
          jefe. Esto es esa línea: se ve entera, a propósito, porque nadie debería tener aquí un
          jefe que no pueda ver. Cubre a las{' '}
          <span className="tabular font-semibold text-ink">{total}</span>{' '}
          {total === 1 ? 'persona' : 'personas'} con cuenta en Cortex, que pueden ser menos de las
          que trabajan en la empresa — no es el organigrama. Quién decide qué se escribe arriba, en
          «Quién es quién».
        </p>

        {total === 0 ? (
          <p className="text-xs text-ink-faint">
            Todavía no hay nadie con cuenta en este espacio de trabajo.
          </p>
        ) : line.unmanaged === total ? (
          <p className="text-xs leading-relaxed text-ink-muted">
            Nadie tiene jefe puesto todavía, así que todos los escalados caen en el primer
            administrador del espacio — un solo buzón para toda la empresa.{' '}
            {canEdit ? (
              <Link href="/admin/users" className="font-semibold text-primary hover:opacity-80">
                Empieza por quien tenga gente a cargo
              </Link>
            ) : (
              'Un admin puede arreglarlo en «Personas».'
            )}
            .
          </p>
        ) : (
          <ul className="border-t border-border pt-2">
            {line.roots.map((root) => (
              <Branch key={root.person.id} node={root} level={0} />
            ))}
          </ul>
        )}

        {total > 0 && line.unmanaged > 0 && line.unmanaged < total && (
          <p className="mt-3 border-t border-border pt-3 text-micro leading-relaxed text-ink-faint">
            <span className="tabular">{line.unmanaged}</span>{' '}
            {line.unmanaged === 1 ? 'persona no tiene' : 'personas no tienen'} jefe puesto: sus
            escalados van al primer administrador.
          </p>
        )}
      </div>
    </Panel>
  );
}
