/**
 * Los archivos que alguien soltó en un chat, y la única cosa que se puede hacer
 * con ellos después de haber contestado la pregunta del momento.
 *
 * Familia propia y no un `kb.*` a propósito: lo que esta herramienta toca es el
 * ADJUNTO —una fila de `chat_attachments`, con su id, su conversación y su
 * caducidad de una semana—, y el documento del cerebro es su consecuencia, no
 * su sujeto. Meterla en `kb` la haría aparecer en la misma lista que buscar y
 * crear documentos, donde el modelo la leería como «otra forma de guardar
 * texto» y la llamaría sin adjunto delante.
 */
export { attachmentsPromote } from './promote';
