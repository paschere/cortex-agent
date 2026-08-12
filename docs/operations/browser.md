# Trámites web

Cortex can now do paperwork on other people's websites: open a portal, log in,
fill a form, and come back with the certificate.

1. A person does the errand **once**, sharing the tab, and Cortex reads the
   recording and proposes the steps.
2. Cortex immediately runs the proposal against the real site. Only a clean
   end-to-end run makes it **probado**; otherwise it stays **propuesto**.
3. From then on it repeats the errand with **no language model in the loop** —
   a few seconds, no cost, the same result every time.
4. When the portal changes, it tries to find the moved element and **updates
   the flow**, so the fix is paid for once rather than every time.

It never invents a trámite. Everything it can do is something a person
demonstrated, and anything that writes on a third-party system asks a human
first.

---

## ⚠️ Read this first

- **`BROWSER_SERVICE_TOKEN` is operator infrastructure, not a customer
  credential.** Anything holding it can make Cortex drive a browser, and the
  request body it accepts carries **decrypted portal passwords**. It belongs in
  exactly two places — the Railway service and Vercel — and is never issued to a
  customer, rendered in the UI or sent to a browser.
- **A `propuesto` trámite has never been shown to work.** It is a model's
  reading of a recording. It is runnable by hand, deliberately invisible to the
  agent in chat, and must not be scheduled.
- **A trámite marked `write` acts with the company's identity on a system nobody
  here administers.** It is gated by the ordinary approval card, and there is no
  undo from Cortex.
- **Only ever share one tab.** The screen shows this before recording starts.
  Sharing a window or the whole screen is refused with an explanation, because
  a full-screen share captures the notification from another client that slides
  in mid-errand.
- **No video and no frame is stored anywhere.** Not in Postgres, not in object
  storage, not on disk. See § 4.
- **One replica.** Each run gets its own browser context, but the concurrency
  ceiling (`BROWSER_MAX_CONCURRENT`) is per process, and a second replica would
  double it silently on a box sized for one.

---

## 1. How it is put together

```
  Person's tab ──frames──▶ Cortex (Vercel) ──▶ model ──▶ proposed steps
                             │
                             │  https + bearer
                             ▼
                        services/browser  ──▶  the portal
                          (Railway)
                          Playwright + Chromium
```

**Why two pieces.** Playwright drives a real Chromium: a process with a few
hundred megabytes resident that has to stay alive across the dozen navigations
one errand takes. A serverless invocation structurally cannot hold that. So the
browser lives on Railway and talks to Cortex over HTTPS, exactly like
`services/whatsapp`.

**The service owns no data.** It has no database credentials, keeps nothing
between runs, and does not know what a workspace is. Cortex sends it a step
list, the values to fill in, and — for a trámite that logs in — the decrypted
credential for that one call. Every decision about who may run what, and every
row that results, is on the Cortex side.

**One browser, one context per run.** Launching Chromium costs about a second;
a context costs almost nothing. The context is also the isolation boundary that
matters: cookies, `localStorage` and any session a login just created belong to
it and die with it, so two workspaces running errands on the same portal in the
same second cannot see each other's session.

| File | What it is |
|---|---|
| `infra/supabase/migrations/0087_browser_flows.sql` | The schema, and the reasoning for every table |
| `infra/supabase/migrations/0091_browser_learning.sql` | `needs-login`, and where a downloaded document comes from |
| `packages/agent-tools/src/browser/refine.ts` | The video says which steps; the DOM says what they are called |
| `packages/agent-tools/src/browser/download.ts` | Why the file does not travel in the result |
| `apps/web/lib/browser-download.ts` | Where a fetched certificate lands, and why not somewhere shared |
| `scripts/browser-cases/` | The three errands every engine change is measured against |
| `packages/agent-tools/src/browser/extract.ts` | Reading an errand off a recording |
| `packages/agent-tools/src/browser/execute.ts` | The run: replay → classify → repair |
| `packages/agent-tools/src/browser/classify.ts` | "the site changed" vs "the errand failed" |
| `packages/agent-tools/src/browser/redact.ts` | Why a credential cannot reach a log or a row |
| `packages/agent-tools/src/browser/access.ts` | Who may spend a login they cannot see |
| `services/browser/src/snapshot.ts` | How the page is described, and the locator ranking |
| `services/browser/src/replay.ts` | The step loop. No model anywhere in it |
| `apps/web/app/(app)/browser/` | The screen |

---

## 2. Deploying on Railway

### 1. Set the shared secret in Cortex

```sh
openssl rand -base64 32
```

Put it on Vercel as `BROWSER_SERVICE_TOKEN`, and `BROWSER_SERVICE_URL` as the
public origin Railway gives the service (no trailing slash).

### 2. Create the service

New service in the same Railway project as the WhatsApp bridge.

- **Root Directory:** `/` (the whole repo — pnpm needs the workspace manifest)
- **Config as code:** `services/browser/railway.json`

The Dockerfile builds from the repository root and runs on
`mcr.microsoft.com/playwright:v1.49.1-jammy`. **That tag must match the
`playwright` version in `services/browser/package.json`** — Playwright refuses
to run against browsers built for a different release, and the symptom is a
container that starts and immediately dies with no message.

### 3. Variables on the Railway service

| Variable | Value |
|---|---|
| `BROWSER_SERVICE_TOKEN` | the same secret you put on Vercel |
| `PORT` | Railway injects it; the default is 3300 |
| `BROWSER_MAX_CONCURRENT` | optional, default `3` — contexts at once |
| `BROWSER_RUN_TIMEOUT_MS` | optional, default `180000` — one whole errand |
| `BROWSER_STEP_TIMEOUT_MS` | optional, default `20000` — one step |
| `BROWSER_SESSION_IDLE_MS` | optional, default `300000` — idle session sweep |
| `BROWSER_VIEWPORT_WIDTH` / `_HEIGHT` | optional, default `1366×900` |
| `LOG_LEVEL` | optional, default `info` |

Give it **1 GB of memory minimum**. Chromium plus a heavy portal will use
several hundred megabytes, and an OOM kill mid-errand looks like a timeout.

> **Keep `numReplicas` at 1.** `railway.json` sets it. The concurrency ceiling
> is per process; a second replica doubles the load on a box sized for one.

### 4. Run the migration

`infra/supabase/migrations/0087_browser_flows.sql` — six tables, all RLS-on and
service-role only, like everything since 0064.

### 5. Deploy

The first boot logs, in order:

```
{"level":"info","service":"cortex-browser","msg":"browser service listening","port":3300}
{"level":"info","service":"cortex-browser","msg":"chromium ready"}
```

`chromium ready` is the line that matters — it means the image has the forty-odd
shared libraries Chromium needs. If it is missing, the base image is wrong.

`/health` is unauthenticated on purpose (Railway polls it) and answers **200 even
when Chromium is down**: the container is healthy and relaunches the browser on
demand, and failing the check would have Railway restart the process in the
middle of doing exactly that.

---

## 3. Teaching a trámite

**Trámites web → Enséñame.** Share the tab, do the errand, press Terminar.

What Cortex extracts from the recording:

- **The sequence of actions** — navigate, fill, choose, click, read, download.
- **A ranked list of ways to find each element**, best first. All semantic:
  the element's role plus its visible name, the label printed beside a field,
  the placeholder inside it, the form field's `name`, the words on a link. A
  structural CSS path is last, and is only ever a fallback.
- **Which typed values change between runs** — the plate, the NIT, the month —
  declared as variables, so one recording serves every plate. Anything the
  extractor left as fixed that should vary is corrected on the review screen
  before saving; getting this wrong is the difference between a procedure and a
  souvenir.
- **Two or three page landmarks per step** — a heading, the portal's name. Not
  used to find anything. Used later to answer "is this even the page we
  learned on".

### Why those locators survive a redesign

Playwright resolves elements the way a person does: by role, by accessible name,
by the label next to the field. Those are also exactly the things a picture of a
page shows, which is what makes reading a recording viable in the first place.

The ranking, best first, and what each one survives:

| Rank | Locator | Survives |
|---|---|---|
| 1 | `data-testid` | anything — it was put there for automation |
| 2 | role + accessible name | restyle, wrapper divs, class renames, a framework migration |
| 3 | the field's label | anything short of rewording the form |
| 4 | placeholder | a restyle; placeholders get reworded more often than labels |
| 5 | `name` attribute | any cosmetic change — the JSF/ASP.NET stacks most Colombian portals run on almost never touch it |
| 6 | visible link/button text | a restyle |
| 7 | `#id`, when it does not look generated | a restyle |
| 8 | CSS path | very little. First to break |

**Several per step, and that is the feature.** At replay the flow tries each in
order and takes the first that resolves to exactly one visible element. When
rank 0 stops matching and rank 2 works, the flow just absorbed a redesign: no
model, no failed run, and the step is rewritten with the survivor first
(`drifted` in the version history). The step trace marks it *vía alterna*, which
is how you see a portal changing weeks before it breaks.

Ambiguity counts as not-found. Two matches means acting on a guess, and on a
page that files something with a government body a guess is the one outcome
worth failing to avoid.

### El DOM tiene la última palabra sobre cómo se llaman las cosas

Una grabación es de píxeles. Sirve para decir **qué pasos hay y en qué orden** —
eso es exactamente de lo que una secuencia de fotos es evidencia — y no puede
decir cómo se llama nada por debajo: un `data-testid` puesto ahí para
automatizar, el nombre accesible que leería un lector de pantalla, el atributo
`name` que el servidor le generó al campo. Nada de eso se ve en una foto.

Pero la pasada de verificación corre en nuestro propio Playwright, que **sí ve
el DOM**. Así que en el momento en que un paso resuelve, se le pregunta al
elemento cómo se llama de verdad (`observeTargets`), y el trámite se reescribe
con lo que dijo la página en vez de con lo que el modelo dedujo de la imagen.
Los localizadores del modelo se conservan debajo: son una descripción distinta
—cómo se veía la página el día que se enseñó— y el día que el portal regenere
sus `name`, son los que cargan el paso.

Queda como versión `refined`, **sin perder la prueba**: esos localizadores
salieron de los elementos que esa misma corrida tocó, así que el trámite que
describen es el que acaba de funcionar.

### Propuesto vs probado

Saving does not just store the proposal. Cortex runs it against the real site
with the values you gave, and:

- **it completes** → **probado**, with the date. Visible to the agent in chat.
- **a step the model misread fails** → Cortex shows the model the live page,
  lets it correct that one step, and runs the whole thing again. If it now
  completes it is **probado** and the correction is saved as a `refined`
  version.
- **it still fails** → **propuesto**, with the failing step named. Runnable by
  hand from the screen; invisible to the agent.

---

## 4. What happens to the recording, and to what you typed

**No video is ever created.** The page samples the shared tab into a canvas and
keeps only the frames where the picture visibly changed — typically twelve to
twenty for a whole errand, capped at twenty. There is no `MediaRecorder`, no
blob and no stream upload.

**No frame is ever stored.** They go up in one request to
`/api/browser/extract`, straight to the model, and the response is a step list.
Nothing writes them to Postgres, to object storage or to disk; there is no queue
and no job holding them. When the request returns they are garbage. All that
survives is `recording_frames` (a count) and `extraction_cost_usd`, so the
teaching step can be audited and priced without keeping the pictures.

This is why extraction is synchronous even though it takes most of a minute.
A background job would need somewhere to park the frames while it waited, and
"somewhere" is a copy of somebody's screen that then has to be defended,
audited, and eventually deleted by a sweeper that will one day not run. **The
cheapest way not to leak a recording is not to have one.**

**Passwords.** Three defences, in order of how much they are relied on:

1. **A password field renders as dots.** The camera sees `••••••••`. This
   covers the ordinary case completely.
2. **The extractor is told never to transcribe a credential** and to emit a
   `secret` placeholder instead.
3. **`enforceSecrets` assumes it did anyway.** Any step whose label or locator
   looks like a credential field — contraseña, clave, usuario, PIN, token,
   código de verificación — has whatever text came back **discarded** and is
   rewritten to `{kind:'secret'}`. This is what catches a revealed password, a
   "show password" eye toggle, and a password manager overlay. The characters
   are dropped, not masked.

**Pause** is on screen the whole time a recording runs, as a large button, and
it stops sampling entirely. Somebody will need to open another customer's record
mid-errand, and the honest answer to that is a button rather than a promise
about what we do with the pixels afterwards.

---

## 4.b Cuando el trámite necesita una cuenta

**La forma más probable de que un trámite falle no es que el portal cambie: es
que nunca se grabó la puerta.** Quien enseña ya está adentro — entrar no es
parte de la diligencia y a nadie se le ocurre grabarlo — así que la grabación
empieza *dentro* de una sesión. Al reproducir desde un navegador limpio se cae
en la pantalla de acceso y el primer paso no encuentra nada.

Eso **no es un fallo, es una pregunta sin responder**: con cuál cuenta. Y tiene
respuesta, una sola vez, de una persona que estaba ahí cuando se grabó.

- **Se detecta al enseñar.** La verificación corre desde un navegador limpio
  apenas se guarda, así que el problema aparece mientras la persona sigue en la
  pantalla de revisión y todavía se acuerda de con qué cuenta entró.
- **La regla que lo distingue** de «se venció la sesión» es la misma de antes,
  con un dato más: hay un campo de contraseña en pantalla, el paso que falló no
  es un paso de ingreso, **y el trámite no tiene ningún paso de ingreso**. Un
  trámite que sí sabe entrar y aun así termina en la puerta es una credencial
  rechazada, y eso sigue siendo `legitimate`.
- **El estado es `needs-login`**, una cuarta clase de fallo (migración 0091). No
  se reintenta, no se marca roto, no se llama al modelo, y el trámite conserva
  el estado que tenía: propuesto sigue propuesto.
- **La segunda vez ni siquiera abre el navegador.** `login_required` queda en la
  fila del trámite, así que la siguiente ejecución pregunta de una.
- **Aprender el ingreso**: no hay forma de parchear una grabación que empezó
  después de la puerta, porque no hay pasos donde meter la clave. La frase que
  ve la persona lo dice explícitamente: hay que enseñarlo otra vez **cerrando
  sesión primero**, para que la grabación incluya el ingreso, y vincularle la
  credencial. Grabado así, los campos de contraseña salen como `secret` — que es
  lo que el extractor ya hace — y `unlockForRun` los llena en cada corrida.

## 4.c El papel: lo que el trámite trae de vuelta

Casi todos estos trámites terminan en un archivo. Hasta ahora el flujo llegaba a
la pantalla de resultado y ahí se quedaba, que es mandar a alguien a una
diligencia y que vuelva sin el papel.

**Dónde se guarda.** Como un documento cualquiera: el bucket privado
`kb-uploads` y una fila en `kb_documents`, exactamente igual que un archivo
subido a mano. Eso no es una decisión de comodidad — es lo que hace que todo lo
de más abajo funcione sin saber que existen los trámites.

**Con qué límites**, y falla con una frase en español, no con un stack:

| Límite | Valor | Por qué |
|---|---|---|
| Tamaño | 10 MB | El mismo techo con el que se creó el bucket en la migración 0013 |
| Tipos | pdf, xml, csv, txt, json, xls(x), doc(x), zip, png, jpg | Un portal que entrega un `.exe` no está haciendo papeleo |
| Bytes en la fila del run | ninguno | Ver abajo |

**El archivo no viaja en el resultado.** Un `download` devolvía el PDF entero en
base64 dentro de `output`, y ese objeto va a tres sitios donde no debe ir: la
columna `result` del run, el contexto del modelo y la respuesta de la API. Los
bytes se sacan en el borde (`browser/download.ts`); lo que queda es el nombre,
el tipo, el tamaño y el `documentId`.

**Y entonces sirve para algo**, que es el punto. Al quedar como `kb_documents`
con `source = 'tramite'` y su procedencia en `metadata.tramite` (de qué portal,
qué trámite, qué corrida, cuándo), se dispara `kb/document.ingest`, y de ahí en
adelante ya existía todo:

- **Al cerebro** — se parsea, se trocea, se indexa y queda **citable** en Brain
  Knowledge con su procedencia.
- **A datos** — la misma pasada corre la extracción estructurada de la migración
  0076, así que un certificado descargado suelta sus campos con su cita igual
  que una factura subida a mano.
- **Al chat** — el resultado de la herramienta lleva el nombre y el
  `documentId`, y la guía le dice al modelo que diga dónde quedó en vez de
  pegar el contenido.

**Dónde NO queda: en un espacio compartido.** Va al espacio personal de quien
corrió el trámite. Un certificado de antecedentes, una declaración de renta o un
extracto bancario son justo los documentos donde un destino «útil» por omisión
sería una divulgación, y lo que se comparte de más no se puede des-leer. Moverlo
a un espacio de equipo es un clic, y es de quien corrió la diligencia.

**Descargar no convierte un trámite en `write`.** Bajar y guardar es inofensivo;
mandar el archivo a alguien no lo es, y eso ya son otras herramientas
(`gmail.send`, WhatsApp) que pasan por la tarjeta de aprobación que ya existe.
La clasificación por efecto no cambia porque haya una descarga: cambia si el
trámite envía, radica o paga.

## 5. The measured comparison

`pnpm browser:bench` — the numbers below are its output, not an estimate.

It runs the same errand two ways against the same fixture portal
(`scripts/browser-benchmark/portal.ts`, a stand-in for the RUNT: three pages, a
form with a server-generated field name, a results table, and a fixed 350 ms of
latency per page **paid identically by both sides**, so it cancels out).

| | Time (median) | Cost | Model calls |
|---|---:|---:|---:|
| **Aprendido** (replay) | **2.28 s** | **US$0.0000** | **0** |
| **Razonado** (model drives the browser) | 11.71 s | US$0.0089 | 3 |

**5.1× faster, and free.** Priced at Anthropic's list rate for `claude-sonnet-5`
($3/$15 per MTok); the promotional rate in force until 2026-08-31 halves the
reasoned figure and leaves the learned one at zero.

The reasoned baseline is not a strawman: it gets the same browser, the same page
snapshot with the same semantic locators, and it succeeded on all three runs.
(An earlier version of the benchmark reported 28× — because the snapshot only
carried interactive elements, so the reasoning agent could not read a results
table and gave up. Adding page text to the snapshot fixed the baseline and cut
the headline number in half. The smaller number is the true one.)

**How it scales, and why the gap widens.** The errand above is four steps. The
reasoned side spent 3 calls, ~3.9 s and ~$0.003 each — roughly one call per
meaningful decision. A learned replay is a for-loop, so its cost stays flat in
the number of model calls at zero and grows only with the portal's own latency.
A twelve-step errand is about the same replay plus more page waits, against
roughly nine to twelve model calls on the reasoned side.

Put in a month: an errand run 40 times costs **$0.00** learned and about
**$0.36** reasoned, and takes 1.5 minutes rather than 8. Teaching it cost one
extraction — around **$0.08** for twenty frames, once.

**The other number worth knowing:** after the fixture portal renames its submit
button, the learned replay fails in **2.27 s without calling the model at all**,
and the evidence it hands back (landmarks present, zero candidate matches,
HTTP 200, no refusal text) is what the classifier reads. Failing fast and cheap
is what makes it affordable to be careful about when to repair.

---

---

## 5.b El juego de casos: qué tanto sale bien a la primera

`pnpm browser:bench` compara aprendido contra razonado. Eso responde «¿vale la
pena?». La otra pregunta — «¿esto quedó mejor que ayer?» — necesitaba algo que
no existía, y la razón por la que no existía era falsa: se creía que hacían
falta personas grabando.

**No hacen falta.** `scripts/browser-cases/` conduce un portal de prueba con
Playwright, **fotografía la diligencia mientras la hace** — con el puntero
dibujado encima de lo que va a pulsar, porque el capturador real lleva
`cursor: 'always'` y sin él las grabaciones sintéticas serían *más difíciles* de
leer que las de verdad — y le pasa esos cuadros al extractor real. Sale una
grabación repetible, sin humanos, y del mismo tipo de evidencia: píxeles de una
página a media diligencia, sin DOM, sin eventos de clic y sin barra de
direcciones.

Tres errands, elegidos porque rompen cosas distintas: **detrás de un ingreso**,
**formulario largo con un campo dependiente**, y **tabla de resultados donde hay
que leer el dato de la fila correcta**. Una cuarta (`acceso-grabado`) es la
primera enseñada con el ingreso incluido, que es lo que § 4.b pide.

### La medida

**A la primera** = pasos que corrieron *y* resolvieron con su **primer**
localizador: sin recurrir a un suplente, sin reparación y sin modelo. Un paso
que sólo funciona por un suplente no es gratis — está a un rediseño de ser un
incidente — y uno reparado por un modelo tampoco.

Y **la meta**: el trámite se corre siempre con **valores distintos de los que se
enseñaron**. Repetir la grabación con los mismos datos demuestra que la
grabación se puede re-enactuar; lo que interesa es si sirve para la siguiente.

### Las cifras

Con el extractor real (`pnpm browser:cases`), tres errands, un modelo de verdad:

| | a la primera | meta |
|---|---:|---:|
| Motor como estaba | **2 / 20 (10 %)** | 0 / 3 |

Esa corrida costó US$0.33 y **agotó el saldo de la API**, así que las cifras de
«después» de las mejoras que dependen del modelo no se pudieron tomar. Lo que sí
dejó fueron los tres modos de fallo, y los tres se reproducen sin modelo con
hipótesis fijas (`--fixed`, ver `scripts/browser-cases/hypotheses.ts`: lo que
escribiría un lector competente de fotos, degradado en las cuatro formas que una
cámara impone y en ninguna otra). Sobre eso, cada cambio del motor está medido:

| Motor | a la primera | meta |
|---|---:|---:|
| Como estaba (3 casos) | 5 / 23 (22 %) | 0 / 3 |
| `expect` deja de ser un veredicto | — | — |
| \+ ambigüedad ≠ reintento (3 casos) | **16 / 23 (70 %)** | 1 / 3 |
| Los 4 casos, sin refinar | 22 / 32 (69 %) | 1 / 4 |
| \+ refinar contra el DOM | **24 / 32 (75 %)** | **2 / 4** |
| \+ `needs-login` | 24 / 32 (75 %) | 2 / 4 |

Qué compró cada uno, en concreto:

- **`expect` no vuelve a matar un paso** (+11 pasos). El modelo escribe la frase
  que *vio*, y lo que escribió en un campo se ve en pantalla sin ser texto de la
  página. Un `fill` perfecto se quedaba los 20 s del timeout y reportaba la
  diligencia entera como fallida, con veredicto `transient/unknown`. Ahora
  `expect` decide **cuándo seguir**, nunca **si falló**.
- **Ambigüedad ≠ reintento.** Cinco filas con cinco enlaces que dicen «Ver
  detalle»: `resolveTarget` se niega a adivinar, y eso llegaba como
  `transient/blocked` — se reintentaba para siempre contra una página que nunca
  iba a contestar distinto. Ahora es `site-changed/ambiguous`, que es lo que
  deja que una reparación haga el paso específico.
- **Refinar contra el DOM** (+2 a la primera, y **una meta más**). La meta es lo
  interesante: el paso `extract` apuntaba al valor que vio («CON ANTECEDENTES»),
  que funciona el día que se enseña y devuelve nada con el siguiente documento.
  El DOM le dio la dirección de la celda. Eso es la diferencia entre un
  procedimiento y un recuerdo, y sólo la página podía decirla.
- **`needs-login`** no mueve pasos y no pretende hacerlo: mueve el veredicto de
  `legitimate/refusal-text` — un callejón sin salida — a una pregunta que alguien
  puede responder. Es la mitad del caso `acceso`, y con el ingreso grabado
  (`acceso-grabado`) esa misma diligencia corre 8/9 y llega a la meta.

### Lo que no se pudo medir, dicho como es

**Cuadros en pareja** y **extracción en dos pases** están implementados y
**apagados**, porque las dos son afirmaciones sobre cómo lee un modelo y el
saldo se acabó antes de poder tomarles el número. Montarlas encendidas «porque
suenan bien» es exactamente lo que este módulo no hace. Cada una tiene un
comando que la decide:

```sh
pnpm browser:cases                  # sueltos, un pase
pnpm browser:cases -- --pairs       # pareja, MISMO presupuesto de imágenes
pnpm browser:cases -- --two-pass    # segmentar y después detallar
```

- **Pareja**: el tope es de imágenes, no de momentos, así que veinte cuadros en
  pareja cubren diez momentos en vez de veinte. Encenderlo es un argumento en
  `TeachFlow` (`pairs: true`).
- **Dos pases**: manda los cuadros **dos veces** — el doble de tokens de entrada
  y casi el doble de latencia en una llamada que ya tarda casi un minuto con una
  persona esperando. Es la que menos evidencia tiene de compensarlo. **Si el
  número no la respalda, bórrala**; no la dejes encendida.

## 6. What cannot be learned from a recording

A shared tab gives **pixels, not events**. There is no click stream, no keydown
and no DOM — everything is inferred from what changed on screen. That is enough
for the overwhelming majority of portal work, and these are the exceptions,
stated rather than papered over:

| Step kind | Why the recording is not enough | What to do |
|---|---|---|
| **Hover-only menus** | A menu that opens on hover and closes when the mouse leaves may never appear in a sampled frame, and even when it does, the *hover* that caused it is invisible. Cortex will usually record the click on the final item and miss the step that revealed it. | Click the parent menu instead of hovering while teaching, if the portal allows it. Otherwise the flow needs the hover step added by hand. **Paired frames (§ 5.b) are aimed exactly at this** — a frame from before the menu closed, with the pointer on what opened it — but they are off until somebody runs the measurement, so today this is unchanged. |
| **File uploads** | The OS file picker is a native dialog outside the tab. It is not in the capture at all, and there is no `upload` action in the step vocabulary. | Not supported. Note this is now the *only* half of the file story that is missing: a trámite can BRING a document back (§ 4.c) and cannot take one in. Adding it means an `upload` action plus a document picker for where the file comes from — and `kb_documents` is now the obvious source, since that is where a downloaded one already lands. |
| **Codes that arrive elsewhere** | An OTP by SMS or email is on a phone, not the tab. The recording shows six digits appearing in a box and nothing about where they came from. | The step is captured as a `secret`, which is the right shape but not yet a working one — nothing feeds it. Portals with mandatory 2FA on every login are out of scope. |
| **Captchas** | Deliberately unlearnable. | Out of scope. `vehicles/client.ts` solves this with OCR for two specific sites; generalising it is a different project. |
| **Canvas / PDF viewers / iframes from another origin** | A value drawn on a `<canvas>` or inside a cross-origin iframe has no element behind it to locate, even though it is plainly visible in the frame. | `extract` will fail. **Download the document instead**, which is now a real answer rather than a deferral: the file is stored, parsed, indexed and its fields extracted (§ 4.c). A PDF viewer whose contents could not be read on screen is exactly the case this closed. |
| **Drag and drop, and anything timing-dependent** | The intermediate states are between frames. | Not supported. |

### Lo que se movió de imposible a posible

Esta tabla existe para que nadie pierda una tarde. Tres renglones cambiaron:

- **Un trámite detrás de un ingreso** era el fallo más probable del módulo y ni
  siquiera estaba en la lista, porque no se veía como una limitación de la
  grabación sino como un trámite roto. **Ahora se detecta al enseñar, se dice en
  una frase accionable y se pide la credencial** (§ 4.b). Lo que sigue sin poder
  hacerse es *adivinar* el ingreso: hay que volver a grabar con la sesión
  cerrada, y eso el producto ahora lo dice en vez de dejar que se descubra.
- **Traer el archivo** no estaba en la lista y era una limitación real: el flujo
  llegaba al resultado y soltaba el papel. **Ahora vuelve con él, indexado y
  citable** (§ 4.c). Subir un archivo sigue sin poder hacerse.
- **Un dato dentro de un visor de PDF o un `<canvas>`** deja de ser un callejón:
  descargar el documento es hoy una respuesta completa, no un consuelo.

Y uno que **no** se movió, contra lo que podría parecer: leer el dato de la fila
correcta en una tabla. Un localizador **no puede llevar una variable** — los
`targets` son texto fijo — así que un trámite puede leer *la factura F-00312*
pero no *la factura que le pasen*. El caso `tabla` de `browser:cases` es
exactamente esto y por eso se queda en 3/5. Arreglarlo es darle plantillas a los
localizadores, que es un cambio de vocabulario y no un cambio de motor.

**If a portal needs several of these, recording is the wrong mechanism for it** —
the answer would be to also capture browser events, which means an extension or
a Cortex-driven browser, which is the trade-off this design deliberately made
the other way. Adoption beats fidelity for the ninety percent; the ten percent
should be named rather than half-supported.

---

## 7. When something goes wrong

### The screen says "El servicio de navegador no está conectado"

`BROWSER_SERVICE_URL` or `BROWSER_SERVICE_TOKEN` is missing on Vercel. Nothing
is broken; the feature is dark until both are set.

### "El servicio de navegador rechazó nuestra clave"

The tokens on Vercel and Railway no longer match. Rotate both together.

### "El servicio de navegador está ocupado"

`BROWSER_MAX_CONCURRENT` contexts are already in flight. Raise it if the box has
the memory, or wait — errands are seconds long.

### A trámite says "El portal respondió y rechazó el trámite"

It worked; the answer was no. The message quotes what the portal said — a plate
that does not exist, a rejected password, an expired session, a validation
error. **Cortex deliberately did not touch the flow.** Fix the input or the
credential.

### A trámite says it needs an account and will not run

`needs-login`. It is not broken and it was not refused: the recording started
inside a session, so the flow has no idea how to sign in. Bind a credential AND
re-teach it with the sign-in in the recording — § 4.b explains why the second
half is not optional. Until then it asks instead of opening a browser, which is
why it costs nothing to leave it in that state.

### A step says several elements answer to the same description

`site-changed/ambiguous`. A results table with five identical "Ver detalle"
links, most likely. Cortex refuses to act on a guess — on a page that files
something with a government body that is the one outcome worth failing to avoid
— and the repair pass is what makes the step specific, usually by binding it to
an `aria-label` the recording could not show. If the row it must open depends on
the run's inputs, no repair will help: see the note at the end of § 6.

### A trámite says "El portal cambió" and is now marked roto

The repair either could not identify the moved element with confidence, or it
did and the repaired flow still failed. Both leave the steps exactly as they
were — nothing is saved on the strength of the model having answered. Re-teach
it from a new recording.

### A trámite repaired itself three times today and is now roto

The thrash guard (`MAX_REPAIRS_PER_WINDOW`, three in 24 hours). A flow being
rewritten repeatedly by a model against a page nobody has looked at is not
drifting; it needs a person. Look at the version history — every repair is a row
with the model's own sentence about what it changed.

### The step trace shows "vía alterna" on some steps

The preferred locator stopped matching and a lower-ranked one carried the step.
Nothing is wrong; the flow rewrote itself and no model was involved. It is
worth reading as an early warning that the portal is being worked on.

### A recording produced no steps

The shared tab was in the background the whole time, so nothing changed on
screen. Keep the portal tab visible while doing the errand.

### "Compartiste una ventana o la pantalla completa"

Deliberate refusal. Share the tab: it is the narrowest thing the browser offers
and it is what keeps everything behind it out of the capture.

### Somebody asks whether their password was recorded

No. It renders as dots on screen, so the camera never sees the characters; the
extractor is told not to transcribe credentials; and any step that looks like a
credential field has its text discarded before the proposal is even returned to
the browser. What is stored is the *name* of the field and a pointer to an
encrypted credential. The step trace shows `***`, which is a fixed string and
not a mask — not even the length is kept.

---

## Related

- `infra/supabase/migrations/0087_browser_flows.sql` — the schema and the reasoning behind every table, including why credentials are separate from flows
- `packages/agent-tools/src/browser/classify.ts` — the failure taxonomy, and the login-page rule that stops an expired session from corrupting a good flow
- `packages/agent-tools/src/browser/execute.ts` — why a repair only counts if the whole errand then works
- `packages/agent-tools/src/browser/__tests__/browser.test.ts` — the five properties, asserted
- `services/browser/README.md` — the service on its own terms
- `docs/operations/whatsapp.md` — the other Railway service, same deployment shape
