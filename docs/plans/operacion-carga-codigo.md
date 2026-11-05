# Operación de carga con código (v2)

Decisiones del dueño (2026-11-05): reemplazo directo de las 14 pantallas de bloques de
«Operación de carga» (app `control_de_vuelos_de_carga`, org Groundflex) por pantallas con
código, estilo Cortex claro (cuaderno: claro, legible al sol, cifras completas — pesos sin
abreviar salvo ≥ mil millones). Nuevas: tablero vivo de vuelos, manifiesto inteligente,
operario en campo, gerencia y costos. Se conservan las mismas TABLAS, ROLES y REGLAS
(las 19 automatizaciones siguen disparando: las escrituras del SDK emiten los mismos eventos).
Prefacturación no se toca.

Inventario de producción (solo lectura): `scratchpad/ops/actual.json` (tablas, campos, roles,
reglas, vistas actuales con su spec). Tablas clave: `vuelos`, `prefacturacion` (las guías del
vuelo: etapa Esperada→Recibida→Prefacturada, relación `vuelo`, `prealerta`), `prealertas`,
`atenciones`, `equipos_usados`, `eventos_operacion`, `tarifas_proveedores`.
Roles: documental, operario, supervisor, gerencia (permisos por tabla con `actions`).

## Contrato SDK v2 (`@cortex/app-sdk`, lo agrega la plataforma)

Todo pasa por el puente postMessage → `/api/apps/[id]/code/[screen]/sdk` → `runSdkOp`, con
los permisos del rol decididos en el servidor. Lo que necesita al navegador (cámara,
ubicación, descarga) lo hace el MARCO PADRE (CodeScreen.tsx), porque el iframe tiene origen nulo.

```ts
cortex.tables.action(table: string, id: string, action: string, opts?: { reason?: string })
  : Promise<{ message: string; row?: SdkRow }>
// Corre el botón/acción de flujo con esa clave (p. ej. 'tomar', 'cerrar', 'aprobar',
// 'rechazar', 'devolver', 'llego', 'en_camino', 'demorado') exactamente como lo hace la vista
// de bloques: misma validación de rol (`permissions.tables[t].actions`), mismos efectos y
// mismas reglas. Error claro si el rol no tiene esa acción.

cortex.tables.listActions(table: string): Promise<{ key: string; label: string }[]>

cortex.files.upload(file: File | Blob, opts: { table: string; id: string; field: string; name?: string })
  : Promise<{ url: string; name: string; values: Record<string, unknown> }>
// Sube y AGREGA al campo `file` de esa fila (respeta permisos de edición de campo).

cortex.files.pick(opts?: { accept?: string; capture?: 'environment' | 'user'; multiple?: boolean })
  : Promise<File[]>   // el selector/cámara lo abre la propia pantalla con <input type=file>; helper de conveniencia en el SDK

cortex.docs.scan(file: File | Blob, opts?: { kind?: 'manifiesto' | 'guia' | 'general'; rows?: boolean })
  : Promise<{ fields: Record<string, string | number>; rows: Record<string, string | number>[]; text?: string }>
// Reusa apps/web/lib/views/scan-doc.ts (imagen o PDF ≤ 4 MB).

cortex.voice.transcribe(audio: Blob): Promise<{ text: string }>
// Reusa lo que ya usa el dictado de vistas (apps/web/app/api/voice o equivalente).

cortex.location.current(): Promise<{ lat: number; lng: number; accuracy: number;
  zone: string | null; inside: boolean | null } | null>
// El padre pide geolocalización (con el consentimiento de ubicación de la app) y evalúa
// las geocercas de la app. null = sin señal / sin permiso.

cortex.ui.download(filename: string, data: Blob | string, mime?: string): Promise<void>
// El padre descarga (el iframe sandbox no puede).

cortex.ui.confirm(text: string, opts?: { confirmLabel?: string; danger?: boolean }): Promise<boolean>
```

React: `useQuery(fn, deps, { refreshMs })` debe admitir sondeo (tablero vivo cada 15–30 s).

## Pantallas (un solo proyecto, `docs/examples/operacion-carga/`)

| slug | título | roles | qué hace |
|---|---|---|---|
| `tablero` | Tablero | supervisor, documental, gerencia | Inicio. Línea de tiempo del día (vuelos por hora estimada actual), estado de cada vuelo Programado→…→Cerrado con colores, retrasos, diferencias fuera de margen, por aprobar, eventos críticos abiertos. Sondeo 20 s. |
| `vuelos` | Vuelos | documental, supervisor | Lista/filtrar por fecha; crear y editar vuelo (lo esperado), marcar En camino / Demorado / Llegó, posición. |
| `vuelo` | Vuelo | documental, supervisor, gerencia | Detalle: datos, guías del vuelo (prefacturacion por relación `vuelo`), prealertas cruzadas, documentos, atención y equipos, eventos, línea de tiempo del vuelo. **Manifiesto inteligente**: foto/PDF → `docs.scan` → renglones → cruce por número de guía con `prealertas` → marca coincide / faltante / sobrante / diferencia de kilos → el documental revisa y crea las guías (prefacturacion, etapa Esperada, `vuelo`, `prealerta`) y guarda el documento en el vuelo. |
| `campo` | En campo | operario | Móvil, botones grandes. Vuelos por tomar (hora, posición, minutos) → Tomar (acción `tomar`, ubicación). Atención en curso: cronómetro, real vs esperado con diferencia resaltada en vivo, equipos (tarifa del tarifario, cantidad, foto obligatoria), eventos rápidos (tanqueo, equipo varado…), novedades por voz, fotos, Cerrar (acción `cerrar`, ubicación de cierre). Corrección pedida → la ve arriba con la nota. |
| `aprobar` | Por aprobar | supervisor | Atenciones Por aprobar con diferencias, fotos, equipos y costo; Aprobar / Rechazar (motivo) / Pedir corrección (nota). |
| `eventos` | Eventos | operario, supervisor, gerencia | Registrar evento (con o sin vuelo) y revisar/resolver (supervisor). |
| `indicadores` | Indicadores | supervisor, gerencia | Tiempos (llegada→toma, atención, total), kilos y piezas, % fuera de margen, por aerolínea / día / operario; gráficos. |
| `costos` | Costos | supervisor, gerencia | Por pagar a proveedores (estado_costo), tarifario editable (supervisor), costo por vuelo/aerolínea/proveedor, exportar a Excel. |
| `torre` | Torre de control | supervisor, gerencia | Se conserva. |

Código compartido en `lib/` (formato de pesos/kilos/horas en Bogotá, colores de estado,
componentes UI propios: tarjetas, chips, tablas, botones grandes). `package.json` con
dependencias fijadas.
