-- 0240 — Correo de la cuenta de Google conectada.
--
-- Cuando una hoja o un archivo de Drive responde 403, el mensaje tiene que
-- decir «compártelo con <correo>». La tabla sólo guardaba user_id. Se llena al
-- conectar y, en las conexiones que ya existían, la primera vez que hace falta
-- (se pide a Google con el token vigente y se guarda).
alter table integrations add column if not exists account_email text;
