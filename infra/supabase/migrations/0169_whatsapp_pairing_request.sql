-- ===========================================================================
-- VINCULAR WHATSAPP CUANDO ALGUIEN LO PIDE, NO EN BUCLE
-- ===========================================================================
-- Hasta ahora el puente (services/whatsapp) que arrancaba sin sesión abría la
-- conexión con WhatsApp y pedía un QR tras otro: seis códigos de 20 segundos,
-- «QR refs attempts ended», espera exponencial y otra vez. En producción llegó a
-- miles de intentos sin que nadie mirara la pantalla, y cuando alguien por fin la
-- abría casi nunca había un código vigente — la espera ya iba por cinco minutos.
--
-- Ahora el puente sin sesión se queda QUIETO (estado `waiting`) y sólo habla con
-- WhatsApp cuando un administrador lo pide desde Integraciones → WhatsApp:
--
--   · `pairing_requested_at` — cuándo se pidió (o se renovó) el emparejamiento.
--     La pantalla abierta lo renueva; el latido del puente lo considera vivo
--     durante tres minutos. Sin nadie mirando, vence y el puente vuelve a
--     quedarse quieto.
--   · `pairing_phone` — si se pidió «Vincular con mi número»: los dígitos E.164
--     (ya pasados por `normalizePhone`) del teléfono dedicado. El puente pide a
--     WhatsApp un código de 8 caracteres para ese número en vez de mostrar un QR.
--   · `pairing_code` / `pairing_code_expires_at` — ese código, reportado por el
--     puente en su latido, con vencimiento corto como el QR.
--
-- `waiting` se suma a los estados: «el servicio está bien y espera que alguien
-- lo vincule». Distinto de `disconnected`, que es un número ya vinculado que no
-- logra conectarse — confundirlos es mandar a alguien a revisar Railway cuando
-- lo único que falta es tocar un botón.
--
-- Tenencia: la tabla ya existe, ya es `tenant()` en tenancy/tables.ts y sólo la
-- toca service_role. Aquí sólo se le agregan columnas.

alter table public.whatsapp_sessions
  add column if not exists pairing_requested_at    timestamptz,
  add column if not exists pairing_phone           text
    check (pairing_phone is null or pairing_phone ~ '^[0-9]{8,15}$'),
  add column if not exists pairing_code            text
    check (pairing_code is null or pairing_code ~ '^[A-Z0-9]{8}$'),
  add column if not exists pairing_code_expires_at timestamptz;

alter table public.whatsapp_sessions drop constraint if exists whatsapp_sessions_status_check;
alter table public.whatsapp_sessions
  add constraint whatsapp_sessions_status_check
  check (status in ('disconnected', 'waiting', 'pairing', 'connected', 'logged_out'));

comment on column public.whatsapp_sessions.pairing_requested_at is
  'Cuándo un administrador pidió (o la pantalla abierta renovó) vincular el número. El puente sin sesión sólo se conecta a WhatsApp mientras esto tenga menos de tres minutos.';
comment on column public.whatsapp_sessions.pairing_phone is
  'Dígitos E.164 del teléfono dedicado cuando se pidió vincular con código en vez de QR. Null = QR.';
comment on column public.whatsapp_sessions.pairing_code is
  'Código de 8 caracteres que WhatsApp generó para «Vincular con el número de teléfono». Vive lo que vive el intento.';
