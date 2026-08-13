'use client';

import { Panel } from '@/components/ui/panel';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CircleUser, Handshake, ShieldQuestion, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import {
  nudge,
  ratePercent,
  recordPhrase,
  recordTone,
  tallyPhrase,
  urgencyPhrase,
} from '../_lib/wording';
import type { PeopleLoad, PersonItem, PersonLoad } from './types';

/**
 * La misma lista, con el nombre como fila.
 *
 * ===========================================================================
 * QUÉ SE VE PRIMERO, Y POR QUÉ ES ESO
 * ===========================================================================
 * Una fila = una persona, y dentro de la fila el orden es: el nombre, cuánto
 * tiene encima, LO PRIMERO QUE APRIETA con su fecha, y sólo al final cómo le ha
 * ido. Ese orden no es estético. Poner el historial arriba convierte la
 * pantalla en un ranking de personas, y un ranking de personas se lee una vez y
 * no se vuelve a abrir. Poniéndolo al final, la primera lectura es siempre «qué
 * hay que destrabar hoy» y el historial es el contexto de esa conversación, que
 * es exactamente lo que es.
 *
 * NADA AQUÍ CALCULA NADA. Todo baja resuelto desde el servidor, contra el mismo
 * `today` en Bogotá que usa la vista por fecha, así que una persona no puede
 * decir «vencido» de algo que la lista de al lado pinta en verde. Este archivo
 * sólo elige palabras y colores, y hasta eso está en `_lib/wording.ts` para que
 * se pueda probar.
 *
 * NINGÚN NOMBRE SE PINTA DE ROJO. El rojo está reservado para una fecha que
 * pasó, que es un hecho; sobre una persona sería un juicio. Ver `wording.ts`.
 */

export function PeopleBoard({ load }: { load: PeopleLoad }) {
  if (load.pending.length === 0 && load.clear.length === 0) {
    return (
      <Panel className="p-8 text-center">
        <h2 className="text-[15px] font-semibold text-ink">Nadie tiene nada a su nombre</h2>
        <p className="mx-auto mt-2 max-w-lg text-[13px] leading-relaxed text-ink-muted">
          Ni promesas entre personas ni papeles con responsable anotado. Cuando alguien quede de
          mandar algo y Cortex lo escuche, aparece aquí con su nombre.
        </p>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="mb-1 flex items-center gap-2">
          <CircleUser className="h-4 w-4 text-primary" aria-hidden />
          <h2 className="text-sm font-semibold text-ink">Quién tiene qué encima</h2>
          <span className="tabular text-[12px] text-ink-faint">({load.pending.length})</span>
        </div>
        <p className="max-w-2xl text-[12.5px] leading-snug text-ink-muted">
          De quien más carga tiene a quien menos. Sirve para saber a quién preguntarle hoy y a quién
          hay que quitarle cosas de encima — no para llevar cuentas.
        </p>

        <div className="mt-4 space-y-3">
          {load.pending.map((person) => (
            <PersonRow key={person.key} person={person} />
          ))}
        </div>
      </Panel>

      {load.clear.length > 0 && <ClearPanel people={load.clear} />}

      <p className="px-1 text-[11.5px] leading-relaxed text-ink-faint">
        El cumplimiento se mide sobre lo que se cerró en los últimos {load.windowDays} días
        {load.closedInWindow > 0 ? ` (${load.closedInWindow} en total)` : ''}. Lo que alguien
        descartó no cuenta como incumplido: descartar es mantener la lista limpia, y eso no se
        castiga.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Una persona
// ---------------------------------------------------------------------------

function PersonRow({ person }: { person: PersonLoad }) {
  const [open, setOpen] = useState(false);
  const first = person.items[0];
  const rest = person.items.length - 1;

  const promises = tallyPhrase(person.promises, 'promise');
  const papers = tallyPhrase(person.papers, 'paper');

  return (
    <article
      className={clsx(
        'rounded-card border bg-surface p-4 shadow-card',
        // El borde cálido se lo gana la persona que tiene algo atrasado, y es
        // un borde, no un fondo: marca dónde mirar sin pintar a nadie de rojo.
        person.promises.overdue + person.papers.overdue > 0 ? 'border-amber/30' : 'border-border',
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            {person.unassigned ? (
              <ShieldQuestion className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            ) : (
              <CircleUser className="h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            )}
            <h3 className="truncate text-[15px] font-semibold text-ink">{person.name}</h3>
          </div>

          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {promises && (
              <span className={chipClass(person.promises.overdue > 0 ? 'amber' : 'neutral')}>
                <Handshake className="h-3 w-3" aria-hidden />
                {promises}
              </span>
            )}
            {papers && (
              <span className={chipClass(person.papers.overdue > 0 ? 'amber' : 'neutral')}>
                {papers}
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <RecordChip person={person} of="promise" />
          <RecordChip person={person} of="paper" />
        </div>
      </div>

      {person.unassigned ? (
        <p className="mt-3 text-[12.5px] leading-snug text-ink-muted">
          Nadie está anotado como responsable, así que ningún recordatorio sale con nombre. No es de
          nadie hasta que alguien lo tome.
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] leading-snug text-ink-muted">
          {nudge(person.promises, person.papers)}
        </p>
      )}

      {first && (
        <div className="mt-3 border-t border-border pt-3">
          <div className="field-label">Lo primero</div>
          <ItemLine item={first} />
        </div>
      )}

      {rest > 0 && (
        <>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="mt-2 rounded-pill px-2 py-1 text-[12px] font-medium text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
          >
            {open ? 'Ocultar lo demás' : `Ver las otras ${rest}`}
          </button>
          {open && (
            <div className="mt-1 space-y-1.5 border-t border-border pt-2">
              {person.items.slice(1).map((item) => (
                <ItemLine key={item.id} item={item} />
              ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}

/**
 * Un compromiso, en una línea.
 *
 * La promesa lleva su icono y el papel no: es la única diferencia que hace
 * falta para que no se confundan de un vistazo, y basta porque la etiqueta de
 * tipo va al lado.
 */
function ItemLine({ item }: { item: PersonItem }) {
  const overdue = item.state === 'overdue';
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {item.internal && <Handshake className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />}
      <Link
        href={`/commitments/${item.id}`}
        className="truncate text-[13.5px] font-medium text-ink transition-colors duration-150 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        {item.title}
      </Link>
      <span className="text-[11.5px] text-ink-faint">{item.kindLabel}</span>
      <span
        className={clsx(
          'tabular text-[12px]',
          overdue
            ? 'font-semibold text-rose'
            : item.state === 'due_soon'
              ? 'text-amber'
              : 'text-ink-muted',
        )}
      >
        {item.dueLabel} · {urgencyPhrase(item.daysLeft)}
      </span>
    </div>
  );
}

/**
 * «8 de 9 a tiempo».
 *
 * La frase de gerente que este producto no sabía decir. Va aparte para promesas
 * y para papeles porque son dos conductas distintas: fallarle a un colega no es
 * lo mismo que dejar vencer un SOAT, y una sola cifra las promediaría hasta que
 * ninguna de las dos significara nada.
 */
function RecordChip({ person, of }: { person: PersonLoad; of: 'promise' | 'paper' }) {
  const record = of === 'promise' ? person.promiseRecord : person.paperRecord;
  const phrase = recordPhrase(record);
  if (!phrase) return null;

  const tone: StatusTone = recordTone(record);
  const pct = ratePercent(record);
  const what = of === 'promise' ? 'promesas' : 'vencimientos';

  return (
    <span
      className={chipClass(tone)}
      title={
        pct === null
          ? `Historial de ${what}: todavía muy corto para una cifra.`
          : `${what.charAt(0).toUpperCase()}${what.slice(1)} cerradas a tiempo: ${pct}%.`
      }
    >
      {of === 'promise' ? <Handshake className="h-3 w-3" aria-hidden /> : null}
      {of === 'promise' ? 'Promesas: ' : 'Papeles: '}
      {phrase}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Quien no tiene nada
// ---------------------------------------------------------------------------

/**
 * Sólo aparece quien no tiene nada abierto Y sí tiene historial.
 *
 * Un panel donde sale la empresa entera en verde entrena a no mirar la
 * pantalla, y un nombre con dos ceros al lado no distingue a quien cumple de
 * quien nunca ha tenido nada asignado. Con historial, en cambio, la lista dice
 * algo que en ningún otro sitio se puede leer: quién viene entregando.
 */
function ClearPanel({ people }: { people: PersonLoad[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Panel className="p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-emerald" aria-hidden />
        <h2 className="text-sm font-semibold text-ink">Al día</h2>
        <span className="tabular text-[12px] text-ink-faint">({people.length})</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="ml-auto rounded-pill px-2.5 py-1 text-[12px] font-medium text-ink-faint transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
        >
          {open ? 'Ocultar' : 'Mostrar'}
        </button>
      </div>
      <p className="mt-1 text-[12.5px] leading-snug text-ink-muted">
        Sin nada abierto encima, y con cosas cerradas detrás. Están aquí porque entregaron, no
        porque no se les haya pedido nada.
      </p>

      {open && (
        <div className="mt-3 space-y-2">
          {people.map((person) => (
            <div key={person.key} className="flex flex-wrap items-center gap-2">
              <span className="text-[13.5px] font-medium text-ink">{person.name}</span>
              <RecordChip person={person} of="promise" />
              <RecordChip person={person} of="paper" />
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
