# Cómo busca Cortex en el cerebro

Cuatro pasos, cada uno con un trabajo distinto. Este documento dice qué hace
cada uno, cómo se apaga si estorba, y qué mirar cuando una respuesta sale mal.

```
   la pregunta
        │
        ├─► ① dos búsquedas a la vez  ──►  ~20 candidatos
        │      significado (embeddings) + palabras (español)
        │
        ├─► ② el segundo lector       ──►  los mismos 20, en otro orden
        │      lee pregunta y pasaje juntos, uno por uno
        │
        ├─► ③ el suelo de relevancia  ──►  se quedan los que responden
        │      y lo que sobrevive se corta a `limit`
        │
        └─► ④ los bordes de al lado   ──►  la frase completa, no media
```

---

## ① Las dos búsquedas

**Por significado.** Un embedding de la pregunta contra los embeddings de los
pasajes. Encuentra «cuánto cobramos por guardar mercancía» aunque el documento
diga «tarifa de bodegaje».

**Por palabras.** Desde la migración 0125 en **español**: se pliegan los acentos
y se reduce a la raíz, con la configuración `es_unaccent`. Antes usaba `simple`,
que no sabe ningún idioma, y eso significaba tres cosas malas a la vez:

| Buscabas | Antes encontraba | Ahora |
|---|---|---|
| «facturación» | solo «facturación» | también «facturacion», «facturar», «facturas» |
| «¿cuál es la tarifa de bodegaje?» | solo pasajes que trajeran *cuál*, *es*, *la* y *de* | los que hablen de tarifa y bodegaje |
| `"nota crédito"` (entre comillas) | no se entendía | frase exacta |

Esa tercera fila es nueva: `websearch_to_tsquery` entiende comillas para una
frase exacta y `-palabra` para excluir.

La mitad por palabras es la que encuentra un NIT, un número de contrato, un
nombre propio — todo lo que un embedding difumina. Estaba prácticamente de
adorno; ahora trabaja.

## ② El segundo lector (reordenador)

Un embedding se calcula **sin haber visto la pregunta**, así que dos pasajes del
mismo tema quedan cerca aunque solo uno conteste. El reordenador lee la pregunta
y cada pasaje **juntos** y dice cuál responde. Cuesta una llamada por búsqueda y
solo corre sobre los ~20 candidatos que ya trajo el paso ①.

- **Se enciende solo** si hay `VOYAGE_API_KEY`. Se apaga con `KB_RERANK=off`.
- Modelo por defecto: `rerank-2.5-lite` (`KB_RERANK_MODEL` para cambiarlo).
- Si tarda más de 4 s (`KB_RERANK_TIMEOUT_MS`), **se sigue con el orden que
  había**. Nunca cuesta una respuesta.
- Solo puede **reordenar**: no añade, no filtra y no toca las puntuaciones. Los
  umbrales de relevancia están calibrados contra el coseno del embedding y
  meterles otra escala los volvería mentira.

**Solo corre en `kb.search`**, que es la búsqueda que le contesta a alguien. La
caja de búsqueda de la página de Brain Knowledge y su banco de memoria miden la
recuperación cruda a propósito y no pagan la llamada.

## ③ El suelo

Está en `kb/relevance.ts`, calibrado por modelo de embeddings. Lo que no llega
no se entrega: una lista de casi-aciertos es exactamente como se fabrica una
respuesta equivocada dicha con aplomo. De ahí salen `coverage` y `summary`.

## ④ Los bordes de al lado

Un documento se corta en trozos de ~400 tokens y el corte cae donde cae. Cuando
parte una cláusula, el fragmento dice «…el plazo de pago será de» y el número
está en el trozo siguiente — y el modelo o dice que no lo encontró, o lo
completa. Lo segundo suena bien, que es lo peligroso.

Así que al fragmento se le pegan los **bordes** de sus vecinos (280 caracteres
por lado, marcados con «…»), quitando lo que el solapamiento del troceador ya
había repetido. Tres límites:

1. Corre **después** del corte y del suelo: no cambia qué se recupera ni cómo se
   puntúa.
2. **Las grabaciones no se tocan.** Un trozo de transcripción lleva quién habló y
   en qué minuto; pegarle el turno anterior mete palabras de otra persona en la
   misma cita.
3. Se ve que está recortado, para que el modelo no lo lea como el principio del
   documento.

---

## Lo que ve el modelo en cada resultado

| Campo | Para qué |
|---|---|
| `coverage` | `answered` / `thin` / `nothing` / `keyword-only`. Se lee **antes** de contestar. |
| `relevance` | `strong` (cítalo) o `weak` (dilo como tangencial). |
| `age`, `freshness` | Nada vencido o reemplazado se cita como vigente. |
| `spaceKind` | `global` (toda la empresa), `shared` (un círculo — no lo repitas fuera de él), `personal` (notas de quien pregunta). |
| `spokenAt` | El minuto de la grabación, para poder ir a oírlo. |
| `conflicts` | Dos documentos de fechas distintas que se contradicen. |

---

## Piezas, para quien tenga que diagnosticar

| Pieza | Dónde |
|---|---|
| La consulta | `kb_search_scoped` (migración 0125) |
| La configuración de español | `public.es_unaccent`, índice `kb_chunks_content_es_idx` |
| El reordenador | `packages/agent-tools/src/kb/reranker.ts` |
| El ensanchado | `packages/agent-tools/src/kb/widen.ts` |
| El suelo | `packages/agent-tools/src/kb/relevance.ts` |
| La frontera de acceso | `kb_visible_space_ids` (ver `brain-access.md`) |

**Preguntas frecuentes al diagnosticar:**

- *«Busco una palabra exacta que sé que está y no aparece.»* Compruebe que la
  migración 0125 corrió: `select cfgname from pg_ts_config where cfgname =
  'es_unaccent'`. Sin ella el arm por palabras sigue en `simple`.
- *«Las respuestas empeoraron de golpe.»* Pruebe `KB_RERANK=off` y compare. Si
  mejora, el reordenador está peleado con este corpus y hay que medirlo en
  `/evaluation` antes de volver a encenderlo.
- *«Las búsquedas van más lentas.»* El segundo lector añade una llamada de red.
  Su techo es `KB_RERANK_TIMEOUT_MS`; bájelo antes que apagarlo.
- *«Un pasaje aparece con texto que no es suyo.»* Es el ensanchado del paso ④.
  Los bordes van entre «…»; si aparecen sin marcar, es un fallo.
