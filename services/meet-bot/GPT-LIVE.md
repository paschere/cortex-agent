# GPT-Live 1 en Meet

Las llamadas con voz usan un detector local del nombre Cortex. Mientras está en reposo, el audio de la sala solo pasa por ese detector en el servidor del bot: no se envía a OpenAI ni Deepgram. El detector emite una señal de activación; no guarda ni publica una transcripción de la sala.

Tras la activación se crea una sesión GPT-Live 1 (`store: false`). Cortex dice «Te escucho»; espera esa señal antes de formular la pregunta. No se conserva un búfer de audio previo al despertar. El audio activo se transmite por WebSocket y se reproduce en el micrófono virtual de Meet. El cerebro de la empresa se consulta por la ruta existente con contexto de la conversación activa y confirmación obligatoria para las acciones que la requieren. Una interrupción de voz detiene audio pendiente; no se presenta como cancelación de una operación empresarial.

Cierre: «Gracias Cortex», «Cortex, eso es todo», silencio/interacción ausente durante 30 segundos, límite de 3 minutos por activación, silenciar o salir de la llamada. El límite no garantiza duración de factura exacta: la finalización del proveedor tarda y puede fallar. Se registra `usage.seconds` del proveedor y si es final. Se puede llamar a Cortex de nuevo después del cierre. Los saludos/fragmentos transcritos no prueban que alguien oyó la respuesta.

Precio publicado 2026-09-12: USD 0.05/minuto de sesión, facturado por segundo, más cerebro y herramientas. En reposo no existe sesión facturable de GPT-Live. El servidor/detector tiene su propio costo de infraestructura. Las llamadas iniciadas sin voz conservan el modo anterior de transcripción Deepgram: no son el modo de reposo conversacional.

## Configuración

- `OPENAI_API_KEY` en **Railway meet-bot**. La misma variable en Vercel sirve para el modo voz web; no se comparte automáticamente entre proveedores.
- Docker instala el detector local. No usar una escucha cloud como fallback si el detector falla.
- El acceso real a `gpt-live-1` debe verificarse con la cuenta. Si falta la clave, `/join` con voz devuelve un error explícito antes de entrar.

## Validación necesaria antes de activar

1. Validar el nombre con una voz colombiana real y con conversación de fondo; medir falsos despertares.
2. Probar sesión real de OpenAI: entrada, respuesta audible por otro participante, interrupción, consulta al cerebro, cierre y uso final.
3. Confirmar que no sale audio hacia OpenAI/Deepgram durante reposo.
4. No confundir admisión en Meet con audio audible ni con éxito de herramientas.

Fuentes: https://developers.openai.com/api/docs/guides/live ; https://developers.openai.com/api/docs/guides/voice-websockets?api=live ; https://developers.openai.com/api/docs/guides/live-conversations ; https://developers.openai.com/api/docs/models/gpt-live-1
