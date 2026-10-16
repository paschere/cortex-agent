import 'server-only';
import type { CustomViewRow } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { AutofillError, runAutofill } from './autofill';

/**
 * «Llenar con Cortex» desde un formulario de una vista o de una pantalla de
 * aplicación: el bloque y el campo salen de la vista (no de la petición) y el
 * campo tiene que estar entre los que el formulario pide.
 */
export async function autofillForForm(input: {
  db: SupabaseClient;
  view: Pick<CustomViewRow, 'spec'>;
  organizationId: string;
  userId: string;
  body: unknown;
  signal?: AbortSignal;
}): Promise<NextResponse> {
  const b = (input.body ?? {}) as { block?: unknown; field?: unknown; values?: unknown };
  const block = input.view.spec.blocks.find((x) => x.id === String(b.block ?? '').slice(0, 40));
  if (!block || block.type !== 'form')
    return NextResponse.json({ error: 'Ese formulario no está en esta vista.' }, { status: 404 });
  const field = String(b.field ?? '').slice(0, 40);
  if (block.fields.length && !block.fields.includes(field))
    return NextResponse.json({ error: 'Ese campo no está en el formulario.' }, { status: 404 });
  const values: Record<string, string> = {};
  if (b.values && typeof b.values === 'object')
    for (const [k, v] of Object.entries(b.values as Record<string, unknown>))
      if (typeof v === 'string' && k.length <= 40) values[k] = v.slice(0, 400);
  try {
    const out = await runAutofill({
      db: input.db,
      organizationId: input.organizationId,
      userId: input.userId,
      trackerSlug: block.tracker,
      fieldKey: field,
      values,
      signal: input.signal,
    });
    return NextResponse.json(out, { headers: { 'cache-control': 'no-store' } });
  } catch (err) {
    if (err instanceof AutofillError)
      return NextResponse.json({ error: err.message }, { status: 422 });
    return NextResponse.json(
      { error: 'Cortex no pudo llenarlo ahora. Llénalo a mano.' },
      { status: 503 },
    );
  }
}
