-- Un trámite que corre solo y deja el resultado donde nadie mira no sirve.
--
-- ---------------------------------------------------------------------------
-- THE GAP
-- ---------------------------------------------------------------------------
-- Migration 0087 taught Cortex to DO the errand. It said nothing about what the
-- errand is FOR. A run finished, the result went back to whoever was holding
-- the HTTP response, and that was the end of it: the certificate existed for
-- the length of one fetch. The screen shows the last few runs, so a person who
-- thinks to open the screen can find out — which is precisely the audience that
-- does not need help. The one that does is the person who scheduled a trámite
-- for three in the morning and is asleep.
--
-- Two columns' worth of decision, in the person's words:
--
--   1. WHAT DOES IT PRODUCE. A document (el certificado, el paz y salvo), a
--      datum (el estado de la placa, la fecha de vencimiento), or nothing but
--      the fact that it worked. This is not decoration: it decides what the
--      notification can say, and it is the difference between "el trámite
--      corrió" and "el certificado de tradición de ABC123 está listo".
--
--   2. WHERE DOES IT LAND. In the conversation, in the person's inbox, or
--      nowhere in particular.
--
-- ---------------------------------------------------------------------------
-- THERE IS NO RECIPIENT COLUMN, AND THAT IS THE SECURITY DESIGN
-- ---------------------------------------------------------------------------
-- Delivery always goes to the person who asked for the trámite. Not to an
-- address typed into a box, not to a list, not to a client.
--
-- A free-text recipient here would have created a brand-new way for company
-- data to leave the company — a scheduled job that mails a downloaded
-- certificate to any address, with no approval anywhere in the path — and it
-- would have been the ONLY such path in the product that nobody reviews.
-- Everything else that sends outward is gated: `gmail.send_draft` and
-- `browser.submit_flow` carry `requiresConfirmation`, and the risk policy
-- pushes anything with an external recipient to `external_send`.
--
-- So the boundary is drawn in the schema rather than in a check somewhere:
-- **telling the person who asked is not sending, and this table cannot express
-- sending.** Somebody who needs the certificate to reach a client uses the
-- tools that already ask a human first.
--
-- ---------------------------------------------------------------------------
-- WHY FAILURE IS DELIVERED TOO, BY THE SAME ROUTE
-- ---------------------------------------------------------------------------
-- Finding out that the certificate did NOT come out is more urgent than
-- receiving it when it does: the successful case can wait until somebody looks,
-- the failed one has a deadline attached to it. So a delivery destination
-- covers both outcomes, and `deliver_when = 'failure'` exists for the opposite
-- case — a daily check that succeeds thirty times a month and is worth hearing
-- about only on the thirty-first.

alter table public.browser_flows
  -- document      it comes back with a file: a certificate, a paz y salvo, a
  --               statement. What the notification announces is the document.
  -- data          it comes back with a value read off the last page: a status,
  --               an expiry date, an amount.
  -- confirmation  it produces nothing to carry away, and the news is that it
  --               worked. A trámite that files something is usually this.
  add column if not exists output_kind text not null default 'confirmation'
    check (output_kind in ('document', 'data', 'confirmation')),

  -- What the thing is called, in the words the person used: "Certificado de
  -- tradición", "Estado del vehículo". Empty is allowed and means the
  -- notification falls back to the trámite's own name.
  add column if not exists output_label text not null default '',

  -- none   stays on the trámite's screen, which is a legitimate answer for an
  --        errand somebody runs by hand while watching it.
  -- chat   an assistant message in the conversation, so the result lands where
  --        the question was asked.
  -- email  the product's own transactional mail to the person who asked, plus
  --        a Google Chat DM for anyone who linked it. Two channels carrying one
  --        message, never two messages — the rule in lib/dev-work-notify.ts.
  add column if not exists deliver_to text not null default 'none'
    check (deliver_to in ('none', 'chat', 'email')),

  -- always   every run, worked or not.
  -- failure  only when it did not. For the daily check nobody wants to read.
  add column if not exists deliver_when text not null default 'always'
    check (deliver_when in ('always', 'failure'));

comment on column public.browser_flows.output_kind is
  'What the errand comes back with: a document, a datum, or only the fact that it worked. Proposed from the recording — a download step means document, an extract step means data — and confirmed by a person on the review screen, because the model reads what the page did and only the person knows what they went there for.';

comment on column public.browser_flows.output_label is
  'The name of the thing produced, in the person''s words. Used as the subject line and the first sentence of the notification, so "Certificado de tradición" reads better here than anything derived from a URL.';

comment on column public.browser_flows.deliver_to is
  'Where the result goes. Always to whoever asked for the run — there is deliberately no recipient column, because a free-text address here would be the only unreviewed way for company data to leave the company. Sending outward stays with the tools that require an approval.';

comment on column public.browser_flows.deliver_when is
  'Whether a successful run is worth announcing. Failure is always announced when a destination is set: not getting the certificate is more urgent than getting it.';
