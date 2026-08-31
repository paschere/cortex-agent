#!/usr/bin/env node
/**
 * BORRA DEL CEREBRO LO QUE ENTRÓ DE GMAIL, PARA PODER VOLVER A EMPEZAR FILTRADO.
 *
 * ===========================================================================
 * QUÉ PASÓ, Y POR QUÉ HACE FALTA ESTO
 * ===========================================================================
 * La carga histórica de un buzón no filtraba nada: pedía `in:anywhere` —correo,
 * archivado, papelera y spam— y archivaba el buzón entero, con el argumento de
 * que archivar no le molesta a nadie porque el espacio es privado. El argumento
 * era falso, y se vio el mismo día: cientos de boletines compitiendo en cada
 * búsqueda, y el cupo de embeddings agotado indexando campañas de marketing.
 *
 * El filtro ya está puesto (`worthRemembering`, en mail/attention.ts). Lo que
 * este script arregla es el pasado: lo que entró antes de que existiera.
 *
 * ===========================================================================
 * POR QUÉ BORRA TODO LO DE GMAIL Y NO SÓLO LO MASIVO
 * ===========================================================================
 * Sería más fino volver a juzgar documento por documento y borrar sólo lo que
 * el filtro rechazaría. No se hace, por una razón práctica: la decisión vive en
 * las CABECERAS del correo —`List-Unsubscribe`, `Precedence`, la categoría con
 * la que Gmail lo archivó— y esas cabeceras no se guardaron. Volver a juzgar
 * significaría volver a bajarse los hilos de Gmail uno por uno, con un token de
 * acceso que este script no tiene.
 *
 * Y no hace falta, porque borrar de más aquí no cuesta nada: el correo sigue en
 * Gmail. Volver a encender el aprendizaje lo trae otra vez, ya filtrado, y lo
 * bueno vuelve solo. Un documento del cerebro que se puede reconstruir con un
 * botón no es un dato que haya que proteger — es una caché.
 *
 * NO TOCA NADA MÁS. Sólo documentos con `source = 'gmail'`. Las notas, los
 * documentos subidos a mano, lo de Drive, las reuniones y lo de WhatsApp se
 * quedan donde están.
 *
 * ===========================================================================
 * USO
 * ===========================================================================
 *   # 1. Ver qué se borraría, sin borrar nada:
 *   RAILWAY_DB_URL='postgresql://…' node scripts/kb-prune-gmail.mjs
 *
 *   # 2. Borrarlo de verdad:
 *   RAILWAY_DB_URL='postgresql://…' node scripts/kb-prune-gmail.mjs --yes
 *
 * La URL no se imprime ni se guarda en ningún archivo.
 */

import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const url = (process.env.RAILWAY_DB_URL ?? '').trim();
if (!url) {
  console.error('Falta RAILWAY_DB_URL (la DATABASE_PUBLIC_URL del Postgres en Railway).');
  process.exit(1);
}

const commit = process.argv.includes('--yes');

const require = createRequire(join(root, 'apps/web/package.json'));
const { Client } = require('pg');

const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();

try {
  // El recuento va primero y se imprime SIEMPRE, también cuando se va a
  // borrar: quien ejecuta esto tiene que poder ver el número antes de que
  // desaparezca, aunque no haya pedido el ensayo.
  const summary = await client.query(`
    select c.name                        as space,
           count(*)::int                 as documents,
           coalesce(sum(ch.n), 0)::int   as chunks
    from public.kb_documents d
    join public.kb_collections c on c.id = d.collection_id
    left join lateral (
      select count(*)::int as n from public.kb_chunks k where k.document_id = d.id
    ) ch on true
    where d.source = 'gmail'
    group by c.name
    order by documents desc
  `);

  if (summary.rows.length === 0) {
    console.log('No hay ningún documento de Gmail en el cerebro. Nada que hacer.');
    process.exit(0);
  }

  console.log('Documentos que entraron por Gmail:\n');
  let totalDocs = 0;
  let totalChunks = 0;
  for (const r of summary.rows) {
    console.log(
      `  ${r.space.padEnd(28)} ${String(r.documents).padStart(6)} documentos, ${r.chunks} fragmentos`,
    );
    totalDocs += r.documents;
    totalChunks += r.chunks;
  }
  console.log(
    `\n  TOTAL${''.padEnd(23)} ${String(totalDocs).padStart(6)} documentos, ${totalChunks} fragmentos`,
  );

  // Los adjuntos cuelgan del hilo por `parent_document_id` (migración 0124) y
  // se van con él, así que se cuentan aparte para que el número no sorprenda.
  const attachments = await client.query(`
    select count(*)::int as n
    from public.kb_documents d
    where d.parent_document_id is not null
      and exists (
        select 1 from public.kb_documents p
        where p.id = d.parent_document_id and p.source = 'gmail'
      )
  `);
  if (attachments.rows[0].n > 0) {
    console.log(`  …de los cuales ${attachments.rows[0].n} son adjuntos colgados de un hilo.`);
  }

  if (!commit) {
    console.log('\nEnsayo: no se borró nada. Añade --yes para borrarlo de verdad.');
    console.log(
      'El correo sigue en Gmail: al volver a encender el aprendizaje entra otra vez, ya filtrado.',
    );
    process.exit(0);
  }

  // Una transacción, porque dejar los documentos borrados y el libro lleno
  // haría que el próximo barrido creyera que ya archivó esos hilos y no los
  // volviera a traer — que es exactamente el estado del que no se sale solo.
  await client.query('begin');

  // `kb_chunks` cae por cascada desde `kb_documents`; los adjuntos NO, porque
  // su `parent_document_id` es `on delete set null` a propósito (un contrato
  // sobrevive al correo que lo trajo). Aquí sí se van con el hilo: no son un
  // contrato que alguien quiso guardar, son parte de la misma carga a limpiar.
  const deletedAttachments = await client.query(`
    delete from public.kb_documents d
    where d.parent_document_id is not null
      and exists (
        select 1 from public.kb_documents p
        where p.id = d.parent_document_id and p.source = 'gmail'
      )
  `);
  const deletedDocs = await client.query("delete from public.kb_documents where source = 'gmail'");
  const clearedLedger = await client.query('delete from public.gmail_thread_ingests');
  const clearedAttachmentLedger = await client.query(
    "delete from public.mail_attachment_ingests where provider = 'gmail'",
  );

  await client.query('commit');

  console.log(
    `\nBorrados ${deletedDocs.rowCount} documentos y ${deletedAttachments.rowCount} adjuntos.`,
  );
  console.log(
    `Libro de hilos vaciado (${clearedLedger.rowCount} filas) y de adjuntos (${clearedAttachmentLedger.rowCount}).`,
  );
  console.log('\nAhora: pon EMBEDDING_MODEL=voyage-4-lite, quita KB_REINDEX_PAUSED y vuelve a');
  console.log('encender el aprendizaje del buzón. Lo que entre esta vez ya viene filtrado.');
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error('No se pudo limpiar:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
