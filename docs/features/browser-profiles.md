# Perfiles personales y enseñanza en el navegador

## Experiencia

Todos los accesos de enseñanza usan `BrowserWorkspace`. El botón del chat abre
`/browser#cortex-browser` en otra pestaña para conservar el borrador de la
conversación; el botón de la biblioteca enfoca el navegador ya montado.
Se retiraron `TeachFlow` y `TeachFlowDialog`, que aún iniciaban la grabación de
la pestaña personal. La transmisión del navegador remoto sigue siendo necesaria
para interactuar con el portal, pero enseñar no llama a `getDisplayMedia`.
El control independiente de compartir pantalla del chat conserva su función de
consulta y no inicia una enseñanza de trámites.

Validación de estos accesos: TypeScript y 44 pruebas de contratos de navegador;
Chromium con API remota simulada comprobó apertura, inicio, fin y revisión de
enseñanza, navegación desde chat y foco desde biblioteca, bloqueando explícitamente
`getDisplayMedia`. No constituye una prueba de extremo a extremo contra la DIAN.

En **Trámites**, el navegador de Cortex permite crear perfiles privados, abrir
un portal e iniciar sesión dentro de Cortex. La persona dueña puede compartir
un perfil con su compañía; eso concede el uso de sus sesiones iniciadas y de los
trámites vinculados. Otros miembros, incluidos administradores, no pueden usar
un perfil privado. La sesión interactiva pertenece a quien la abrió, incluso
cuando las cookies vienen de un perfil compartido. Cada perfil admite un uso
simultáneo. Cerrar la pestaña conserva el perfil.

**Enseñar este trámite** toma el control y empieza una captura de acciones reales.
Los pasos aparecen junto a la transmisión. Terminar abre el editor existente:
permite revisar pasos, variables, dirección inicial y efecto. Guardar crea un
borrador vinculado al perfil; no vuelve a ejecutar los envíos de la demostración.
La prueba se pide después desde la biblioteca. La enseñanza descartada no se
inserta en la base de datos ni en el cerebro. La captura activa sólo vive en la
memoria de esa sesión del servicio.

Los campos escritos y las selecciones se convierten en variables sin valores de
ejemplo. Contraseñas y campos identificados como códigos o secretos se convierten
en pausas manuales. Las capturas de pantalla no se guardan como material de
enseñanza. Etiquetas y selectores sí forman parte de la propuesta: revisarlos
antes de guardarla, especialmente si el portal pone datos personales en ellos.

## Activación

1. Aplicar `infra/supabase/migrations/0129_browser_profiles.sql` antes de publicar
   la aplicación. Agrega `browser_profiles` y `browser_flows.profile_id`.
2. Montar almacenamiento persistente en el servicio de navegador y configurar
   `BROWSER_PROFILES_DIR` hacia ese volumen. Sin esa variable, abrir un perfil
   falla explícitamente: no se promete persistencia con almacenamiento temporal.
3. Publicar juntos el servicio y la aplicación. El protocolo del stream incluye
   ACK con secuencia, y las sesiones nuevas llevan identidad personal.
4. Mantener `BROWSER_SERVICE_URL`, `BROWSER_SERVICE_TOKEN` y una
   `BROWSER_SERVICE_PUBLIC_URL` alcanzable por WebSocket desde el cliente.

El servicio está diseñado para **una instancia con su volumen**. Los bloqueos y
las revisiones de revocación están en ese proceso. Escalar a varias réplicas
requiere enrutamiento por perfil, bloqueo distribuido y revocación coordinada.
No compartir el mismo directorio Chromium entre réplicas.

Los antiguos directorios por organización quedan separados; no se adoptan como
perfiles personales. La exportación antigua usada por meet-bot conserva su
contrato. Los trámites existentes sin perfil conservan su mecanismo de ejecución.

## Aislamiento y revocación

La aplicación resuelve permisos con el cliente de base de datos de la compañía.
El servicio recibe una clave opaca de perfil y una revisión; no decide ACL. Al
cambiar visibilidad, primero se incrementa el límite de revisión del servicio y
se cierran páginas, sockets y contexto sin borrar el disco. Las aperturas en vuelo
con revisión anterior se rechazan. Después se actualiza la fila mediante una
comparación de revisión. Si esa actualización falla, el perfil queda bloqueado de
forma segura hasta reintentar. La clave de sesión personal incluye compañía y
persona, sin reutilizar el perfil del navegador local del usuario.

## Captura y transmisión

La captura usa listeners en el documento y en iframes, incluso de otro origen.
Los destinos guardan la ruta de marcos por URL sin query y nombre. Reproducir no
recurre a otro marco cuando desaparece el aprendido; los destinos ambiguos se
rechazan. Los snapshots de diagnóstico también incluyen elementos de los marcos.
Las descargas iniciadas por un clic se reconocen como pasos de descarga.

La transmisión usa JPEG de CDP, ACK con número de secuencia, descarte ante
congestión, entrada ordenada y una cola limitada. El canvas descarta decodificaciones
viejas y libera sus bitmaps. El cliente reconecta con espera creciente y usa
capturas como respaldo durante una caída.

## Límites de esta versión

- Hasta 60 pasos y 12 variables por enseñanza; al llegar al límite se pide dividirla.
- No resuelve CAPTCHA, MFA ni firmas por sí solo; conserva intervención humana.
- La dirección inicial elimina query/hash para no guardar tokens de sesión y se
  puede corregir en la revisión. Algunos portales necesitan parámetros funcionales.
- Controles dibujados sólo en canvas, arrastres, componentes sin etiquetas y cargas
  de archivos pueden requerir pasos manuales. No se afirma validación específica
  contra DIAN: se verificaron iframes de otro origen en un portal de prueba local.
- Una sesión o un contenedor que se cierre pierde una enseñanza no guardada.
- Los portales pueden caducar su login o exigirlo de nuevo; un perfil persistente
  no evita las políticas de sesión del sitio.

## Validación local

- `pnpm --filter @cortex/browser-service test`: Chromium real para captura en
  iframes, ausencia de valores escritos, aislamiento de cookies, persistencia,
  revocación, exclusión de uso simultáneo y pausas sucesivas; prueba del stream
  con ACK tardío y congestión.
- `pnpm --filter @cortex/agent-tools exec vitest run src/browser/__tests__`:
  motor de trámites y permisos personales (incluido administrador y otra compañía).
- Typecheck de web y servicio. Revisión visual del componente real con respuestas
  API de prueba en escritorio y móvil, incluyendo edición y guardado de propuesta.

La migración no se aplicó ni se desplegaron servicios durante esta implementación.

## Recorridos entre sitios y explicaciones

La barra **Ir a otro sitio** mantiene el perfil y la enseñanza en la misma
pestaña. Cada navegación explícita añade un `goto` al recorrido. Los clics que
navegan siguen registrados como clics, sin duplicar la navegación. Esto permite
enseñar un recorrido de varias páginas, no gestionar varias pestañas simultáneas.

**Explicar este paso** vincula una nota al paso seleccionado. Se conserva en
`steps[].explanation` al guardar y se puede editar en la revisión. Es contexto
humano, no una instrucción ejecutable: escribir “toma el NIT de Drive” no configura
por sí solo una extracción de una hoja ni una conexión entre variables. El texto
pegado en un campo sigue convirtiéndose en una variable sin guardar su contenido.
Para repetir automáticamente Drive → DIAN con datos nuevos se necesita declarar
archivo/hoja/columna, criterio de fila y correspondencia con la variable destino.

## Selección, portapapeles y lectura ampliada

El navegador ofrece **Seleccionar todo**, **Copiar selección**, **Pegar copiado**,
**Copiar a mi equipo** y **Leer página**. Ctrl/Cmd+A, C y V funcionan sobre la
pantalla remota. Al volver de otra aplicación, el pegado usa el texto que entregue
el navegador local. El botón Pegar copiado siempre utiliza el portapapeles remoto.
La lectura también está disponible en pantalla completa.

El portapapeles remoto es memoria de UNA sesión; no usa el portapapeles del sistema
operativo del servidor, no cruza perfiles, no se guarda en el cerebro y se borra al
cerrar la sesión. Admite texto plano, tabulaciones y saltos de línea, hasta 100.000
caracteres por copia/pegado; un exceso se rechaza en vez de cortarse. Las selecciones
de campos de contraseña o identificados como secretos se rechazan. Los editores
que manejan eventos copy/paste pueden aportar/recibir su texto tabular. Algunos
editores exigen eventos nativos confiables: esta implementación no garantiza la
compatibilidad con Google Sheets ni con todas las interfaces dibujadas en canvas.

Para Cortex, `browser.act` añade `select_text`, `copy`, `copy_selection`, `paste`
y `scroll`. Siguen respetando quién tiene el control. `browser.read_page` entrega
`content.text` en partes de hasta 20.000 caracteres y `content.nextOffset` para
continuar. Incluye los documentos cargados de hasta 100 frames, componentes con
shadow DOM abierto y valores visibles no secretos de formularios. Devuelve los
marcos inaccesibles/omitidos y sus limitaciones. `elementOffset` recorre los
controles del snapshot de navegación; ese inventario sigue teniendo un límite.

No se confunde texto cargado con el contenido completo de una aplicación: filas
virtualizadas, páginas de PDF renderizadas como imagen, canvas, shadow DOM cerrado
y contenido todavía no cargado requieren navegación, accesibilidad u otra fuente.
La lectura es en vivo: si la página cambia entre partes, puede cambiar su contenido.


## Resultados

Un trámite de consulta tiene que devolver *algo*: el estado de una guía, «no se
encontró», un valor. Eso se llama un **resultado** y se señala, no se programa.

- **Al enseñar.** En el panel de la enseñanza, **Señalar resultado** enciende un
  modo en que el siguiente clic no actúa sobre el portal: elige el texto que es la
  respuesta (el elemento se resalta al pasar el cursor). Cortex muestra lo que
  señalaste, propone un nombre a partir del rótulo vecino («Estado» → `estado`) y
  pregunta, opcional, **«Si no aparece, el resultado es»** (p. ej. `no encontrado`).
  Se graba como un paso `extract` (`extractAs` = el nombre, `extractDefault` = el
  valor por defecto).
- **Cómo se vuelve a encontrar.** Con un localizador que no depende del valor: el
  `data-testid` si existe, **el rótulo vecino** («el elemento que sigue a “Estado”»,
  con o sin «:»), el `name` y, al final, una ruta CSS. El servicio solo conserva
  las formas que, contra la página viva, dan UN elemento con ESE mismo texto. El
  valor señalado **no se guarda** en el paso: solo se le muestra a la persona para
  confirmar. Un campo para escribir, o un lugar sin texto, no se puede señalar.
- **En el editor** (revisión tras enseñar): cada resultado muestra su nombre
  (`result.<nombre>`) y su valor por defecto, ambos editables, y se puede quitar
  como cualquier paso. **Agregar un resultado** crea uno a mano indicando el rótulo
  que está junto al valor. Nombres: minúsculas, números y `_`; únicos; no
  `download`, `ok` ni `result`.
- **Probar.** En **Trámites**, al correr un trámite, cada resultado señalado se
  lista como `result.<nombre>` con lo que devolvió («no devolvió nada» si salió
  vacío), para comprobar que lee lo que debe.
- **Contrato de `result`.** `browser.run_flow` (y `resume_flow`) devuelven los
  resultados señalados en `result.<nombre>` como texto; `browser.list_flows` los
  anuncia en `results`. Si el elemento no aparece y hay valor por defecto, el
  resultado es ese valor y el trámite sigue (la espera de ese paso es de 10 s en
  vez de 20); sin valor por defecto, que no aparezca falla como siempre.
  Una descarga sigue en `result.download`.

## Desde automatizaciones

Una regla de una app con «Pedirle algo a Cortex» puede consultar un portal con
un trámite aprendido, sin ninguna lógica específica de ese portal:

> Consulta la guía {{guia}} con el trámite "Validar guía" y escribe result.estado
> en el campo Validación.

Cortex llama a `browser.run_flow` (corre sin aprobación: solo corre trámites de
consulta y solo los que un administrador habilitó para trabajos desatendidos) y,
con `result.estado`, escribe en la fila según el permiso de la instrucción.

**Si el portal pide una persona** (el código que llegó al celular, un captcha, o
la sesión del perfil venció) la corrida no falla: pasa a **`waiting_person`**
(«Esperando a una persona»), se guarda una espera (`custom_app_automation_waits`,
migración 0214) y se avisa por campana, push y correo con un enlace a
`/browser/espera/<id>`:

- *Código o captcha*: esa pantalla abre la pestaña viva del trámite. El código se
  teclea ahí; **el captcha lo resuelve la persona con un clic, nunca se automatiza**.
  El aviso va a quien creó la regla, porque la pestaña es de quien corrió el trámite.
- *Sesión vencida*: el aviso va al dueño del perfil (o a quien creó la regla); entra al
  portal desde el navegador de Cortex y pulsa «Ya inicié sesión, continuar».

Cada minuto el reloj de automatizaciones (`apps/automation.dispatch`) revisa las
esperas: cuando el trámite ya se retomó y terminó, la corrida vuelve a la cola y la
acción **continúa** con el modelo recibiendo el `result` (sin volver a correr el
trámite). Es idempotente con la corrida: una sola espera abierta por corrida y
acción, y resolver o vencer es un UPDATE condicionado, así que dos barridos no
reencolan dos veces. Una acción admite hasta 3 pausas seguidas.

**Expiración.** Si nadie lo atiende en 2 horas (o si la pestaña del navegador se
pierde antes), la corrida queda **`unresolved`** («Sin resolver»), se avisa y no se
reintenta; la siguiente corrida de la regla vuelve a intentar.

**Para que la espera sea real** hay que subir `BROWSER_HANDOFF_HOLD_MS` en el
servicio de navegador (p. ej. `7200000`): es cuánto sostiene la pestaña que espera
a una persona. Por defecto vale lo mismo que `BROWSER_SESSION_IDLE_MS` (5 min) y
entonces la espera vence a los 5 min con «la sesión del navegador venció». Cada
pestaña sostenida ocupa un cupo de `BROWSER_MAX_CONCURRENT` y el perfil (un uso
simultáneo): conviene que sean pocas.

Pruebas: `services/browser/tests/results.test.ts` (señalar, grabar, repetir con otro
valor y con valor por defecto; necesita Chromium: `CHROME_PATH=<ruta de Chrome>` si
no está el de Playwright), `packages/agent-tools/src/apps/automations/__tests__/waits.test.ts`
(pausa → aviso → reanudar → continuar, expiración, tope), y los de `browser-steps`.
