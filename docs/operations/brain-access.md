# Quién ve qué en el cerebro

Hasta la migración 0123 un espacio de Brain Knowledge tenía dos formas: lo veía
toda la empresa, o lo veías solo tú. Ahora hay una tercera —**repartido**— y
tres niveles de permiso. Este documento dice qué significa cada cosa, quién
puede cambiarla y qué pasó con lo que ya existía.

---

## Las tres formas de un espacio

| Forma | Quién entra | Cómo se reconoce |
|---|---|---|
| **Común** | Toda la empresa | Etiqueta azul «Común» |
| **Repartido** | Solo los equipos y personas que se añadan | Etiqueta «Repartido» |
| **Propio** | Solo su dueño, salvo que lo preste | Etiqueta gris «Propio» |

Común y repartido son **el mismo espacio por dentro**: los dos pertenecen a la
organización. Lo único que los separa es si existe el acceso «toda la empresa»,
que se enciende y se apaga desde el panel *Quién lo ve*. Por eso publicar un
espacio repartido, o cerrar uno común, es un clic y no una mudanza.

## Los tres niveles

| Nivel | Puede |
|---|---|
| **Ver** | Buscar y leer. Cortex responde con este material a esa persona. |
| **Aportar** | Además, guardar documentos ahí. |
| **Administrar** | Además, repartir el acceso, renombrar y borrar el espacio. |

Cuando a alguien le llega el acceso por varios caminos —por su equipo y además
a título personal— **gana el más alto**.

## Quién puede repartir

- El **dueño de un espacio propio**, sobre lo suyo. Nadie más, ni un
  administrador de la organización.
- Cualquiera con nivel **Administrar** sobre un espacio de la empresa.
- Un **administrador de la organización** sobre todos los espacios de la
  empresa, se los hayan concedido o no. Es a propósito: si no, un espacio mal
  repartido se queda sin nadie que lo pueda arreglar. No alcanza a las notas
  personales de nadie.

## Las dos reglas del cuaderno personal

Un espacio propio se puede **prestar** (ver o aportar), pero:

1. **No se abre a toda la empresa.** Para eso se mueve el documento a un espacio
   común, que es una decisión visible.
2. **No delega su administración.** Quien recibe tus notas no puede pasárselas a
   un tercero. Repartir lo tuyo te queda a ti.

Las dos las hace cumplir la base de datos (un disparador en `kb_space_grants`),
no solo la pantalla.

---

## Qué pasó con lo que ya había

La migración le escribió el acceso «toda la empresa» a **todo espacio que ya era
global**. Nadie perdió nada: lo que veías ayer lo sigues viendo, dicho ahora en
el idioma nuevo. Los espacios personales no se tocaron.

## Desde el chat

- «que Comercial vea Tarifas»
- «deja que Ana guarde en Tarifas»
- «quítale el acceso a Finanzas»
- «que esto no lo vea toda la empresa»

Cortex necesita **administrar** ese espacio para hacerlo; si no, lo dice y
nombra a quién pedírselo.

---

## Piezas, para quien tenga que diagnosticar

| Pieza | Dónde |
|---|---|
| Tabla | `kb_space_grants` — una fila por (espacio, sujeto, nivel) |
| Migración | `0123_kb_space_access.sql` |
| La frontera | `packages/agent-tools/src/kb/spaces.ts` |
| Las funciones | `kb_visible_space_ids`, `kb_space_level`, `kb_spaces_for`, `kb_space_for`, `kb_space_access` |
| El panel | `apps/web/app/(app)/kb/_components/AccessPanel.tsx` |
| La herramienta | `kb.share_space` |

**Preguntas frecuentes al diagnosticar:**

- *«Un espacio común desapareció para todo el mundo.»* Le falta la fila
  `subject_kind = 'everyone'` en `kb_space_grants`. Se arregla desde el panel
  («Abrirlo a todos») o reescribiendo el relleno de la 0123 § 3.
- *«Alguien ve algo que no debería.»* `select * from kb_space_access('<usuario>',
  '<espacio>')` con el usuario que administra, y mire por qué camino le llega:
  un equipo suyo, él mismo, o que el espacio esté abierto.
- *«El botón de guardar aparece y el servidor lo rechaza.»* La pantalla toma
  `canWrite` del nivel que resolvió la base de datos; si discrepan, es que la
  página se sirvió antes del cambio de acceso. Recargar.
