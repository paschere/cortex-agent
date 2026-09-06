import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { type Operation, type OperationEvent, operationCommandSchema } from './operation-shape';
import { ManagementError } from './store';
export async function readOperations(db: SupabaseClient) {
  const result = await db
    .from('management_operations')
    .select('id,data,state,revision,created_at,updated_at')
    .order('created_at', { ascending: false })
    .limit(21);
  if (result.error)
    throw new ManagementError(
      'No se pudo leer la operación. Comprueba la conexión y la migración 0135.',
    );
  return {
    operations: (result.data ?? []).slice(0, 20) as Operation[],
    truncated: (result.data?.length ?? 0) > 20,
  };
}
export async function readOperationEvents(db: SupabaseClient, id: string) {
  const result = await db
    .from('management_operation_events')
    .select('id,revision,actor_id,kind,data,created_at')
    .eq('operation_id', z.string().uuid().parse(id))
    .order('revision', { ascending: true })
    .limit(301);
  if (result.error) throw new ManagementError('No se pudo leer el historial de la operación.');
  return {
    events: (result.data ?? []).slice(0, 300) as OperationEvent[],
    truncated: (result.data?.length ?? 0) > 300,
  };
}
export async function commandOperation(
  db: SupabaseClient,
  actorId: string,
  input: unknown,
  id?: string,
  revision?: number,
) {
  const command = operationCommandSchema.parse(input);
  if (command.kind !== 'create' && (!id || !revision))
    throw new ManagementError('Actualiza la operación antes de continuar.');
  const result = await db.rpc('management_operate', {
    p_actor_id: actorId,
    p_id: id ? z.string().uuid().parse(id) : null,
    p_revision: revision ?? 0,
    p_command: command,
  });
  if (result.error)
    throw new ManagementError(
      result.error.code === 'P0001' ? result.error.message : 'No se pudo guardar la operación.',
    );
  return result.data as Operation;
}
