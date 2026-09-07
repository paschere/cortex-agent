import 'server-only';
import type { SessionUser } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

export class CorporateSupervisionError extends Error {
  constructor() {
    super('Solo un fundador puede supervisar la actividad corporativa de esta empresa.');
    this.name = 'CorporateSupervisionError';
  }
}

export function assertCorporateFounder(user: SessionUser): void {
  if (user.organization.kind !== 'company' || user.organization.role !== 'owner') {
    throw new CorporateSupervisionError();
  }
}

interface DirectoryRow {
  id: string;
  name: string | null;
  email: string;
}

export interface TeamActivityItem {
  id: string;
  type: 'conversation' | 'report';
  title: string;
  summary: string;
  occurredAt: string;
  member: DirectoryRow | null;
  source: string;
}

export interface TeamActivitySnapshot {
  members: DirectoryRow[];
  items: TeamActivityItem[];
  totals: { conversations: number; reports: number };
}

export async function listTeamActivity(
  db: SupabaseClient,
  options: {
    limit?: number;
    memberId?: string | null;
    type?: 'conversation' | 'report' | null;
  } = {},
): Promise<TeamActivitySnapshot> {
  const limit = Math.min(Math.max(options.limit ?? 80, 1), 100);
  const { data: memberRows, error: memberError } = await db
    .from('users')
    .select('id,name,email')
    .order('name', { ascending: true });
  if (memberError) throw new Error('No se pudo leer el directorio corporativo.');
  const members = (memberRows ?? []) as DirectoryRow[];
  const byId = new Map(members.map((member) => [member.id, member]));

  const [conversationResult, reportResult] = await Promise.all([
    db
      .from('conversations')
      .select('id,title,surface,user_id,created_at,updated_at')
      .order('updated_at', { ascending: false })
      .limit(limit),
    db
      .from('reports')
      .select('id,title,kind,period_label,generated_by,generated_at')
      .order('generated_at', { ascending: false })
      .limit(limit),
  ]);
  if (conversationResult.error || reportResult.error)
    throw new Error('No se pudo leer la actividad corporativa.');

  const conversations = (conversationResult.data ?? []) as Array<{
    id: string;
    title: string | null;
    surface: string;
    user_id: string;
    created_at: string;
    updated_at: string;
  }>;
  const reports = (reportResult.data ?? []) as Array<{
    id: string;
    title: string;
    kind: string;
    period_label: string;
    generated_by: string | null;
    generated_at: string;
  }>;

  const items: TeamActivityItem[] = [
    ...conversations.map((row) => ({
      id: row.id,
      type: 'conversation' as const,
      title: row.title?.trim() || 'Conversación sin título',
      summary: `Chat desde ${row.surface}`,
      occurredAt: row.updated_at || row.created_at,
      member: byId.get(row.user_id) ?? null,
      source: row.surface,
    })),
    ...reports.map((row) => ({
      id: row.id,
      type: 'report' as const,
      title: row.title,
      summary: row.period_label || 'Informe corporativo',
      occurredAt: row.generated_at,
      member: row.generated_by ? (byId.get(row.generated_by) ?? null) : null,
      source: row.kind,
    })),
  ]
    .filter(
      (item) =>
        (!options.type || item.type === options.type) &&
        (!options.memberId || item.member?.id === options.memberId),
    )
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, limit);

  return {
    members,
    items,
    totals: { conversations: conversations.length, reports: reports.length },
  };
}

export type TeamActivityDetail =
  | {
      type: 'conversation';
      id: string;
      title: string;
      occurredAt: string;
      member: DirectoryRow | null;
      source: string;
      messages: Array<{ id: string; role: string; content: string; created_at: string }>;
    }
  | {
      type: 'report';
      id: string;
      title: string;
      occurredAt: string;
      member: DirectoryRow | null;
      source: string;
      periodLabel: string;
      subtitle: string | null;
    };

export async function readTeamActivity(
  db: SupabaseClient,
  type: 'conversation' | 'report',
  id: string,
): Promise<TeamActivityDetail | null> {
  if (type === 'conversation') {
    const { data } = await db
      .from('conversations')
      .select('id,title,surface,user_id,updated_at')
      .eq('id', id)
      .maybeSingle();
    if (!data) return null;
    const [{ data: author }, { data: messages }] = await Promise.all([
      db.from('users').select('id,name,email').eq('id', data.user_id).maybeSingle(),
      db
        .from('messages')
        .select('id,role,content,created_at')
        .eq('conversation_id', id)
        .order('created_at', { ascending: true })
        .limit(300),
    ]);
    return {
      type,
      id: data.id,
      title: data.title?.trim() || 'Conversación sin título',
      occurredAt: data.updated_at,
      member: (author as DirectoryRow | null) ?? null,
      source: data.surface,
      messages: (messages ?? []) as Array<{
        id: string;
        role: string;
        content: string;
        created_at: string;
      }>,
    };
  }

  const { data } = await db
    .from('reports')
    .select('id,title,subtitle,kind,period_label,generated_by,generated_at')
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  const { data: author } = data.generated_by
    ? await db.from('users').select('id,name,email').eq('id', data.generated_by).maybeSingle()
    : { data: null };
  return {
    type,
    id: data.id,
    title: data.title,
    occurredAt: data.generated_at,
    member: (author as DirectoryRow | null) ?? null,
    source: data.kind,
    periodLabel: data.period_label,
    subtitle: data.subtitle,
  };
}
