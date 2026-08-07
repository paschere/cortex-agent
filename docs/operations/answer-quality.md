# Evaluación continua de la calidad de las respuestas

Un conjunto de preguntas con respuesta conocida que corre contra el sistema real
y dice, con un número, si un cambio mejoró o empeoró las respuestas.

Vive en `packages/agent-tools/src/evaluation/`. La medición congelada está en
`packages/agent-tools/src/evaluation/fixtures/`, una por modelo de embeddings.
La pantalla está en `/evaluation`.

> Este documento es para quien cambia el código. El runbook de pruebas manuales
> para no ingenieros es `cortex-evaluation-runbook.md` y es otra cosa.

---

## Por qué existe

En un solo día se cambió el modelo conversacional, el motor de embeddings y los
umbrales de relevancia, y se verificaron los tres comprobando que el código
compilaba. Lo que pasó después:

- Un umbral mal calibrado descartaba el único documento que contestaba la
  pregunta. Lo encontró el dueño del producto, con una captura de pantalla.
- Un canal llevaba meses descartando todo resultado correcto que se le daba, sin
  dejar rastro: sin contexto, sin registro, con el modelo respondiendo de memoria.
- El agente respondía «no puedo ayudarte con eso» teniendo la herramienta
  delante, porque la selección no la encontraba.

Los tres eran invisibles para `typecheck`, para los tests y para el build, porque
los tres son propiedades de **una respuesta** y nada en el repositorio afirmaba
nada sobre una respuesta.

---

## Qué se evalúa: tres capas, y no se mezclan

| Capa | Qué pregunta | ¿Corre un modelo? | Costo | Dura |
|---|---|---|---|---|
| **Recuperación** | ¿Volvió el material correcto y sobrevivió al piso de relevancia? | No | 0 | ~1 s |
| **Selección** | ¿Se le ofreció al modelo la herramienta que sabe hacer esto? | No | 0 | ~1 s |
| **Respuesta** | ¿La frase que lee una persona está sostenida por lo que se encontró? | Sí, dos veces | USD 0,38 | 15 min |

Las dos primeras son objetivas: cada número es un conteo, no hay opinión de por
medio, y son las que habrían cazado los tres incidentes de arriba. Corren en
`pnpm test`, en cada cambio. La tercera es la cara, la lenta y la menos
confiable, y corre a mano.

### Dos números por capa, nunca uno

Cada capa reporta **fundamento** (de las preguntas que el corpus sí responde,
cuántas se respondieron desde la fuente correcta) y **prudencia** (de las que no
responde, cuántas se reconocieron como tales). Nunca se promedian.

Un sistema que responde todo con seguridad saca 1,00 en el primero y 0,00 en el
segundo. Promediados dan 0,50, que es exactamente lo que saca un sistema honesto
y mediocre. Son fallas distintas, con arreglos distintos, y en este paquete no se
suman en ningún lado.

### El caso de «no sé» pesa igual que el acierto

De las veintidós preguntas que califican recuperación, doce las responde el
corpus, cinco son verosímiles y **no están**, y cinco no tienen nada que ver.
Fallar en las últimas diez es una falla, no un detalle: son casi la mitad del
conjunto, y ese peso es a propósito.

La distinción entre los dos grupos negativos importa: para las verosímiles el
veredicto correcto es `thin` **o** `nothing` — la política de vacaciones sí es el
documento que hay que leer sobre trabajo desde el exterior, simplemente no tiene
una regla— y para las no relacionadas solo `nothing` es correcto. Exigir
`nothing` en las dos empujaría el piso hacia arriba hasta que empiecen a fallar
preguntas reales, que es exactamente el error que se está corrigiendo.

---

## Cómo se juzga una respuesta libre sin engañarse

Comparar cadenas no sirve para una respuesta en prosa, y un juez de modelo tiene
una trampa conocida: **un juez indulgente hace que todo parezca bien**, y falla
en la dirección que nadie revisa, porque un reporte verde no se investiga.

Cuatro cosas, en orden:

1. **Lo que se puede comprobar con código, se comprueba con código.** ¿Aparece
   `44.900.000`? ¿Aparece la fecha? Eso es `includes()` normalizando separadores
   de miles y tildes, y su resultado **nunca se le muestra al juez**.

2. **Al juez solo se le hacen preguntas de sí o no con respuesta verificable.**
   «¿Se apoya en el plan de arranque para BBIC y no en otro documento?», «¿dice
   que no hay nada guardado sobre eso?». Nunca «¿es buena?». «Buena» no tiene
   valor de verdad y un modelo al que se le pide una produce lo que sugiera el
   tono del prompt; «¿cita este documento?» sí lo tiene.

3. **Todo «sí» tiene que venir con una cita textual, y la cita se verifica en
   código.** Un «sí» cuya cita no está en la respuesta **se convierte en «no»** y
   se cuenta como error del juez. No se le puede adular a un juez para que
   encuentre una frase que no está escrita.

4. **El juez se califica en la misma corrida.** `JUDGE_PROBES` son nueve
   respuestas fijas con veredicto conocido; cinco están mal a propósito, en las
   formas en que este producto falla de verdad: la cifra derogada dicha con
   seguridad, la invención plausible, el documento equivocado citado para el dato
   correcto, la mitad de un dato de dos partes, y una negativa sobre material que
   sí respondía. La fracción de malas que el juez aprueba es su **indulgencia**;
   la de buenas que reprueba es su **severidad**. Si alguna no es cero,
   `trusted: false` y la capa de respuestas se reporta como no confiable en el
   reporte, en la pantalla y en la comparación. `compareRuns` directamente se
   niega a comparar respuestas juzgadas por un juez que no pasó sus propias
   sondas.

---

## Reproducibilidad: qué se fija y qué se deja variar

**Fijo** (en git, cubierto por `suiteDigest()`): los bytes del corpus, las
preguntas, sus grupos, sus documentos correctos, el troceador y sus valores por
defecto, la profundidad de recuperación, el orden de todas las listas, el prompt
del juez y el de respuesta.

**Variable** (registrado en `RunIdentity`, que es el punto): los umbrales, el
modelo de embeddings, el catálogo de herramientas y sus descripciones, las
constantes del ranqueador, el modelo de chat.

`compareRuns` **se niega** —no advierte, se niega— cuando las dos corridas tienen
huellas de conjunto distintas. Dos corridas con huellas distintas no respondieron
el mismo cuestionario, y restar sus puntajes no es una mejora más pequeña, no es
un número.

**Un límite real, dicho en voz alta:** el muestreo no se puede fijar. El modelo de
chat no acepta `temperature` en esta cuenta (ver `model.ts`), así que dos
corridas de la capa de respuestas con la misma configuración difieren un poco.
Las capas 1 y 2 son exactamente reproducibles y ahí están las barreras; la capa 3
es una lectura con ruido y se reporta como tal. Un caso de diferencia sobre doce
es ruido, no una regresión.

**Otro límite:** la reproducción offline es solo semántica. El SQL de producción
ordena con una mezcla 0,7 semántico / 0,3 palabras que no se puede recalcular
fuera de Postgres. Eso pesa menos de lo que suena — `kb/relevance.ts` demuestra
que la mezcla es un buen ORDEN y una MAGNITUD sin sentido, y todos los umbrales
del sistema están sobre el coseno— pero significa que `fundamento 1,00` no es una
afirmación sobre el SQL.

---

## Qué corre en cada cambio y qué corre a mano

### En cada cambio, automático, gratis

```
pnpm test          # incluye src/evaluation/__tests__/offline.test.ts
```

Reproduce la medición congelada a través de los umbrales reales, el
`assessCoverage` real y el `rankTools` real. Un segundo, cero red, cero pesos.
Falla si:

- el fundamento o la prudencia bajan del piso registrado;
- **algún fragmento correcto se recuperó y se descartó por el piso** (la falla de
  producción, fijada en cero);
- **alguna pregunta sin respuesta se marcó como `answered`** (la falla contraria,
  también en cero);
- alguna familia de herramientas que la suite evalúa no llegó al modelo;
- el modelo de embeddings configurado **no tiene medición**;
- una herramienta de esas familias cambió de descripción desde la medición.

Esa última lista es la razón de ser del paquete: mueve `STRONG_MATCH` y el número
se mueve en CI, antes de que el cambio se mezcle.

### Cuando toques embeddings, troceado o descripciones de herramientas

```
set -a; source .env.local; set +a
EVAL_MEASURE=1 pnpm --filter @cortex/agent-tools exec vitest run src/evaluation
git add packages/agent-tools/src/evaluation/fixtures/
```

Vuelve a medir contra la API real y reescribe el fixture del modelo configurado.
**El fixture se commitea.**

Medido el 7 de agosto de 2026: **22 209 tokens, USD 0,00044, quince minutos y
medio**. Lo lento no es el precio ni el trabajo: la cuenta sin método de pago
está limitada a **3 peticiones y 10 000 tokens por minuto**, y hay una petición
por pregunta. La medición se autorregula contra ese límite y reintenta cuando se
pasa. Con una tarjeta registrada baja a menos de un minuto.

```
EVAL_LIVE=1 pnpm --filter @cortex/agent-tools exec vitest run src/evaluation
```

Mide y califica sin escribir el fixture. Es lo que hay que correr cuando se
sospecha que el proveedor cambió el modelo detrás del nombre: un coseno guardado
no puede darse cuenta de eso.

### Antes de cambiar el modelo, el prompt, o de soltar una versión

```
EVAL_ANSWERS=1 pnpm --filter @cortex/agent-tools exec vitest run src/evaluation
```

Genera una respuesta por pregunta y la juzga. Medido el 7 de agosto de 2026:
**quince minutos y USD 0,3776** — veintidós generaciones, veintidós juicios y
nueve sondas de calibración, todo en Sonnet 5 con razonamiento activo, que es lo
que se lleva el tiempo.

**Mira primero el estado del juez.** Si no pasó sus propias sondas, los dos
números de abajo no significan nada todavía. En la primera corrida el juez quedó
**calibrado**: aprobó las cuatro respuestas correctas y reprobó las cinco malas,
incluida la cifra derogada dicha con seguridad.

**Esta capa no tiene un piso numérico y es a propósito.** Un umbral inventado hoy
es teatro, y uno copiado de una corrida anterior es ruido: el modelo de chat no
acepta temperatura en esta cuenta, así que la misma configuración no da dos veces
el mismo puntaje. Lo único que se afirma es que el juez se ganó el derecho a que
le crean. Para «¿esto empeoró?» el instrumento es `compareRuns` contra una
corrida guardada, no un umbral.

El reporte imprime **cada criterio que falló al lado de la frase que lo falló**.
Eso es lo que hay que leer: la primera corrida dio 42% de fundamento y 40% de
prudencia, y la única forma de saber cuánto de eso es el sistema y cuánto es una
rúbrica escrita demasiado apretada es leer las transcripciones. Cuatro de las
doce preguntas respondibles ya venían con la recuperación en `thin` o `nothing`
(ver los hallazgos de abajo), así que el modelo matizó con razón y la rúbrica lo
contó como fallo — esa parte es arrastre de la capa 1, no un defecto nuevo.

### Nunca en CI

Ninguna de las tres de arriba. CI no tiene llaves, y una barrera que llama a una
API de pago falla por la caída de un tercero y la desactiva la tercera persona a
la que le estorba.

---

## Cómo leer una corrida

`formatRun(run)` imprime un bloque para la terminal o para un comentario de PR.
`/evaluation` muestra lo mismo con la diferencia contra la corrida comparable
anterior.

Lo primero que hay que mirar no son los porcentajes, son los dos conteos:

- **descartados por el piso** — un fragmento correcto volvió y se botó. Bajar el
  piso lo lleva a cero **y sube el otro**.
- **respondidos de más** — una pregunta sin respuesta se vendió como respondida.
  Subir el piso lo lleva a cero **y sube el primero**.

Un cambio que cambia uno por el otro no mejoró nada, se movió. Un promedio se
desliza suavemente mientras eso pasa; los dos conteos no.

---

## Cómo agregar una pregunta

En `suite.ts`, con:

- `group` — el grupo **es** la respuesta correcta. Si el corpus no la responde,
  va en `absent` o `unrelated` y su `gold` queda vacío. Esa lista vacía es la
  afirmación, no un campo sin llenar.
- `query` — escrita como la escribe la gente. Medido: el mismo pasaje da 0,489
  con el fragmento que alguien teclea y 0,652 con la pregunta bien formada. Un
  conjunto de preguntas pulidas mide un sistema que nadie usa.
- `answer` — solo criterios verificables. Cifras y títulos en `contains`;
  preguntas de sí o no en `rubric`. Si la única forma de expresar el criterio es
  «que esté bien», el caso todavía no está listo.
- `why` — por qué está. Lo lee quien tenga que arreglarlo.

Después: `EVAL_MEASURE=1` (la huella cambió, así que el fixture quedó viejo) y
commitear el fixture nuevo junto con la pregunta.

## Cómo agregar un modelo de embeddings

1. Mídele los umbrales y agrégalo a `CALIBRATIONS` en `kb/relevance.ts`.
2. `EMBEDDING_MODEL=<modelo> EVAL_MEASURE=1 …` y commitea el fixture nuevo.

Sin lo segundo, `offline.test.ts` falla con `UnmeasuredModelError` y dice cómo
arreglarlo. No hay repliegue a la medición de otro modelo: los cosenos de dos
modelos son coordenadas de espacios distintos, y usar unos por otros es
exactamente el error que dejó los umbrales huérfanos.

---

## Lo que encontró la primera corrida

Sirve de ejemplo de qué caza esto. Los dos hallazgos están fijados en
`offline.test.ts` con su tamaño de hoy, no arreglados a la fuerza ni escondidos:
bajarlos es un arreglo, subirlos rompe el build.

Los números del 7 de agosto de 2026, sobre voyage-4-lite, **antes** de arreglar
los dos defectos:

```
Recuperación   fundamento 67%   prudencia 100%   primer lugar 92%
               descartados por el piso 1   respondidos de más 0
Selección      alcance 60% sobre 5 casos
```

Y **después**, el mismo día, con el mismo fixture y el mismo cuestionario:

```
Recuperación   fundamento 75%   prudencia 100%   primer lugar 92%
               descartados por el piso 1   respondidos de más 0
Selección      alcance 80% sobre 5 casos
```

Lo que hay que mirar no es que suba el 67 al 75, es que **los dos conteos de
error se quedaron quietos**: no se cambió una falla por la otra. Los pisos de
`offline.test.ts` se subieron a 0,74 y 0,79 para que el arreglo quede sostenido
por algo. Ninguno de los dos se arregló moviendo el corte que fallaba —abajo
está el detalle, y es la parte que importa.

### 1. Al corte de relevancia ya no le queda margen con documentos de largo real

Tres preguntas que el corpus responde de sobra quedaron por debajo del corte
fuerte y volvieron como `thin`. La peor es la de siempre: «¿plan de arranque de
cortex?» da **0,458 contra un corte de 0,46**. Dos milésimas. Es literalmente el
incidente de producción otra vez.

No es casualidad. `kb/relevance.ts` midió que la dilución por longitud de
fragmento cuesta cerca de 0,03, y puso el corte con 0,029 de margen sobre un
corpus de once documentos cortos. Este corpus tiene documentos del largo que la
gente sube de verdad, y el margen se acabó.

Una cuarta pregunta se descarta del todo: «cuanto dan para estudiar al año» da
**0,298**, por debajo del piso de 0,34, sobre un documento que dice la cifra
exacta. Frase coloquial contra encabezado formal, dentro de un fragmento largo de
nómina con otros diez temas.

**Cómo se arregló, y por qué no bajando el corte.** Se barrió el corte contra el
corpus y los grupos se entrelazan: la pregunta que el corpus **no** responde
(«licencia de paternidad…», 0,459) puntúa **más alto** que la que sí responde
(«¿plan de arranque de cortex?», 0,458). No existe ningún corte que admita la una
y excluya la otra. La tabla completa está en `kb/relevance.ts`; en resumen, bajar
el corte a 0,458 gana una pregunta y regala una, y bajarlo a 0,425 gana tres y
regala las cinco. El 0,46 está sobre la frontera.

Lo que se movió fue el tipo de evidencia. `queryNamesDocument` en
`kb/relevance.ts` lee una segunda señal que el coseno no ve: si **todas** las
palabras con contenido de la pregunta están en el **título** del documento, la
persona no está preguntando por un tema, está nombrando un documento. Medido
sobre los ocho documentos y las veintidós preguntas: llega a 1,00 exactamente una
vez —la del plan de arranque— y lo más alto que alcanza una pregunta que el
corpus no responde es 0,25. Margen de tres cuartos, contra las dos milésimas que
tenía el corte. Sube un fragmento de «relacionado» a «responde», nunca rescata
uno que el piso ya botó, y falla cerrado: una palabra de más en la pregunta y la
regla simplemente no aplica.

La cuarta pregunta (0,298) **sigue fallando y está contada**. Cualquier piso lo
bastante bajo para salvarla deja entrar también «a que hora juega la seleccion
colombia» (0,319). Es la otra falla, y cambiarla por esta no habría sido un
arreglo.

### 2. El piso de selección de herramientas quedó huérfano del mismo cambio de modelo

Este es el grande, y es exactamente la falla de «no puedo ayudarte con eso»
teniendo la herramienta al lado.

`tool-selection/rank.ts` fija `MIN_FAMILY_SCORE = 0.3` y lo justifica así: «los
pares consulta/documento de Voyage caen entre 0,2 y 0,35 para texto no
relacionado y **0,45 para arriba en una coincidencia real**, así que esto queda
justo encima del ruido».

Medido acá contra voyage-4-lite, **el coseno herramienta/consulta más alto de
toda la suite es 0,416** — la consulta de una placa contra `vehicles.get`, tan
inequívoca como hay en el catálogo. Nada llega a 0,45, porque ese 0,45 se midió
sobre voyage-3-large, que corre como una décima más arriba (las dos tablas de
`kb/relevance.ts` lo muestran). Es la misma orfandad que dejó la migración 0074
en los umbrales de relevancia, en el otro módulo que también depende de cosenos.

Un piso pensado para quedar encima del ruido quedó metido dentro de la señal:

- «mandale un correo a daniela con el resumen de la reunion» → `gmail` 0,291 y
  `outlook` 0,292, contra un piso de 0,30. **Ninguna familia de correo llega al
  modelo** en una petición que dice «mandale un correo».
- «cual es el correo de daniela rios» → `people.search`, la única herramienta
  cuyo trabajo entero es esa pregunta, queda de **decimotercera**, detrás de
  cuatro herramientas de gmail y de `clients.register`.

Arreglarlo es recalibrar `MIN_FAMILY_SCORE` por modelo, igual que `CALIBRATIONS`
hace con los umbrales de relevancia. No se hizo acá a propósito: este encargo era
construir el instrumento, y un instrumento que además ajusta lo que mide no deja
ver si el ajuste sirvió. Ahora el arreglo tiene un número contra el cual
demostrarse.

**Cómo se arregló.** `tool-selection/rank.ts` ya no tiene constantes: tiene
`SELECTION_CALIBRATIONS`, un mapa por modelo con el piso y la banda, más
`AWAITING_SELECTION_MEASUREMENT` para los modelos que nadie midió y
`uncalibratedSelection()` para los que no están en ninguno de los dos —que
recibe un piso deliberadamente **más bajo** que cualquiera medido, porque un
piso alto de más hace desaparecer una capacidad y uno bajo de más solo cuesta
unas declaraciones. `selectToolsForTurn` pasa el modelo que de verdad embebió la
consulta, así que cambiar `EMBEDDING_MODEL` mueve los cortes o los abre, pero no
los deja huérfanos. Y `tool-selection/__tests__/selection-calibration.test.ts`
rompe el build si el modelo por defecto de algún proveedor no está ni medido ni
declarado sin medir, igual que hace `relevance-calibration.test.ts`.

El piso para voyage-4-lite quedó en **0,25**, y ese número no se escogió para que
`gmail` pasara raspando. Se puso en la mitad de la franja entre las dos cosas que
sí se midieron: el techo del ruido (p90 = 0,213 sobre los 635 cosenos
herramienta/consulta de la suite) y la familia correcta más baja que la suite
exige (`gmail`, 0,291). Unas cuatro centésimas de margen a cada lado. Un 0,28 —el
valor que despeja `gmail` por 0,011— habría repetido exactamente el error del
corte de relevancia, que se puso con 0,029 de margen contra un efecto de 0,03.

**Lo que no se arregló, a propósito.** «cual es el correo de daniela rios» sigue
sin llegar a `people`: `people.search` da 0,177 y `clients.register` da 0,233,
con otras cinco familias en medio. Ningún piso rescata eso —queda de séptima
sobre una distribución plana, y es `MAX_FAMILIES` quien la corta, con razón,
porque una distribución plana significa que nada coincidió bien y la respuesta a
eso no es mandar más herramientas. Es un defecto de la **descripción** de la
herramienta, no del umbral, y bajar el corte hasta que pase lo habría escondido.

### 3. Y dos errores de la propia suite, que se corrigieron

Un caso pedía saber quién está de vacaciones la próxima semana y exigía la
familia `people`, que en este producto solo resuelve nombre → correo: una
afirmación sobre una capacidad que no existe mide la suite, no el sistema. Y la
política de vacaciones traía una línea que decía «esta política no regula el
trabajo permanente fuera del país», lo cual convertía una pregunta pensada como
ausencia en una que el corpus sí responde — y producía el único «respondido de
más» de la corrida. Se quitó: un corpus que anuncia sus propios huecos hace fácil
una prueba que en la vida real nunca lo es.

Vale la pena decirlo porque es la mitad del trabajo: las dos primeras veces que
una evaluación falla, más o menos la mitad de lo que reporta es culpa de la
evaluación. Distinguir eso de un defecto real es el juicio que no se puede
automatizar, y por eso cada caso lleva escrito en `why` por qué está.
