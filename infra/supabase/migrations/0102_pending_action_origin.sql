-- De dónde salió lo que está esperando permiso.
--
-- ===========================================================================
-- POR QUÉ HACE FALTA UNA COLUMNA Y NO BASTA CON `decided_via`
-- ===========================================================================
-- `mcp_pending_actions` sabe desde la migración 0047 dónde se DECIDIÓ algo
-- (`decided_via`: web | google_chat | mcp). Lo que nunca supo es dónde se
-- QUEDÓ PARADO, y son dos hechos distintos: una fila sin decidir tiene el
-- segundo y no puede tener el primero todavía.
--
-- Hasta ahora daba igual, porque la única pantalla que las leía era /approvals
-- y ahí todas las filas se ven iguales. Deja de dar igual en cuanto se puede
-- preguntar «¿qué espera mi aprobación?» dentro del chat: la respuesta útil no
-- es «tres cosas», es «tres cosas, y una la dejó pendiente tu conversación en
-- Claude anoche». Sin esta columna esa frase no se puede decir sin inventarla.
--
-- ===========================================================================
-- NULABLE A PROPÓSITO
-- ===========================================================================
-- Las filas que ya existían no tienen forma de saber de dónde vinieron, y
-- rellenarlas con un valor plausible sería exactamente eso: plausible. Un nulo
-- se lee como «no consta», que es la verdad, y las superficies que la muestran
-- se callan el origen en vez de afirmar uno.
alter table public.mcp_pending_actions
  add column if not exists staged_via text;

alter table public.mcp_pending_actions
  drop constraint if exists mcp_pending_actions_staged_via_check;
alter table public.mcp_pending_actions
  add constraint mcp_pending_actions_staged_via_check
  check (staged_via is null or staged_via in ('mcp', 'google_chat', 'whatsapp', 'web', 'schedule'));

comment on column public.mcp_pending_actions.staged_via is
  'Superficie donde la llamada se paró a pedir permiso: mcp | google_chat | whatsapp | web | schedule. Nulo en las filas anteriores a la migración 0102, y nulo se lee como "no consta" — nunca como "web".';
