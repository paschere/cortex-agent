import { describe, expect, it, vi } from 'vitest';
import { type Tables, createFakeSupabase } from '../../tenancy/__tests__/fake-postgrest';
import {
  type MailAttachmentRef,
  ingestAttachments,
  resolveMime,
  worthKeeping,
} from '../attachments';

const ORG = 'org-acme';
const ANA = '00000000-0000-0000-0000-0000000000a1';
const SPACE = '00000000-0000-0000-0000-0000000000b1';
const THREAD_DOC = '00000000-0000-0000-0000-0000000000c1';

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  // biome-ignore lint/suspicious/noExplicitAny: standing in for pino's surface
} as any;

function ref(over: Partial<MailAttachmentRef> = {}): MailAttachmentRef {
  return {
    key: 'att-1',
    filename: 'contrato.txt',
    mime: 'text/plain',
    sizeBytes: 4096,
    messageId: 'msg-1',
    ms: Date.parse('2026-03-04T10:00:00Z'),
    ...over,
  };
}

function world(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    kb_documents: [
      { id: THREAD_DOC, collection_id: SPACE, title: 'El hilo', sha256: 'hilo', source: 'gmail' },
    ],
    kb_chunks: [],
    kb_collections: [{ id: SPACE, organization_id: ORG, scope: 'user', scope_id: ANA }],
    mail_attachment_ingests: [],
    app_files: [],
    kb_embedding_usage: [],
    ...seed,
  };
  const fake = createFakeSupabase(tables);
  return { tables, db: fake.client };
}

function input(atts: MailAttachmentRef[], fetchBytes?: (r: MailAttachmentRef) => Promise<Buffer>) {
  return {
    provider: 'gmail' as const,
    threadId: 'thread-1',
    spaceId: SPACE,
    parentDocumentId: THREAD_DOC,
    subject: 'Contrato Acme',
    attachments: atts,
    fetchBytes:
      fetchBytes ??
      (async () =>
        Buffer.from(
          'Cláusula sexta. El plazo de pago acordado es de treinta días calendario.\n\nCláusula séptima. La tarifa de bodegaje es de 12.000 por tonelada.',
          'utf-8',
        )),
  };
}

// ---------------------------------------------------------------------------
// El filtro: la mitad del valor está en lo que NO se descarga
// ---------------------------------------------------------------------------

describe('worthKeeping', () => {
  it('acepta un PDF aunque el proveedor lo declare como octet-stream', () => {
    // Es el caso real y frecuente: el tipo depende del cliente que lo mandó, no
    // del archivo. Un filtro que se fiara sólo del tipo tiraría contratos.
    const verdict = worthKeeping(
      ref({ filename: 'Contrato firmado.pdf', mime: 'application/octet-stream' }),
    );
    expect(verdict).toEqual({ keep: true, mime: 'application/pdf' });
  });

  it('descarta la firma criptográfica y las imágenes numeradas de una firma', () => {
    expect(worthKeeping(ref({ filename: 'smime.p7s' })).keep).toBe(false);
    expect(worthKeeping(ref({ filename: 'image001.png', mime: 'image/png' })).keep).toBe(false);
    expect(worthKeeping(ref({ filename: 'invitacion.ics', mime: 'text/calendar' })).keep).toBe(
      false,
    );
  });

  it('descarta lo que pesa más de 25 MB, y lo dice en megas', () => {
    const verdict = worthKeeping(ref({ filename: 'demo.pdf', sizeBytes: 60 * 1024 * 1024 }));
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toMatch(/60 MB/);
  });

  it('descarta lo que no se sabe abrir, nombrando la extensión', () => {
    const verdict = worthKeeping(ref({ filename: 'entrega.zip', mime: 'application/zip' }));
    expect(verdict.keep).toBe(false);
    if (!verdict.keep) expect(verdict.reason).toMatch(/zip/);
  });

  it('un .docx pasa; resolveMime no se lo inventa', () => {
    expect(resolveMime({ filename: 'propuesta.docx', mime: '' })).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });
});

// ---------------------------------------------------------------------------
// La ingesta
// ---------------------------------------------------------------------------

describe('ingestAttachments', () => {
  it('archiva el adjunto como documento propio, colgado del hilo', async () => {
    const { tables, db } = world();
    const res = await ingestAttachments(
      { organizationId: ORG, userId: ANA, db, logger: silentLogger },
      input([ref()]),
    );

    expect(res.archived).toBe(1);
    const doc = (tables.kb_documents ?? []).find((d) => d.id !== THREAD_DOC);
    expect(doc).toBeDefined();
    // Cuelga del hilo, pero es un documento aparte: es lo que evita que media
    // cláusula quede precedida de «Ana dijo a las 10:42».
    expect(doc?.parent_document_id).toBe(THREAD_DOC);
    expect(doc?.title).toContain('contrato.txt');
    expect(doc?.title).toContain('Contrato Acme');
    // La fecha del documento es la del correo, no la de hoy: es lo que hace que
    // la frescura signifique algo.
    expect(doc?.recorded_at).toBe(new Date(ref().ms).toISOString());
    // Y el archivo original queda guardado, no sólo su texto.
    expect(tables.app_files).toHaveLength(1);
    expect(doc?.source_ref).toBe((tables.app_files ?? [])[0]?.path);
    expect((tables.kb_chunks ?? []).length).toBeGreaterThan(0);
  });

  it('la segunda vez no vuelve a descargar nada', async () => {
    const { tables, db } = world();
    const ctx = { organizationId: ORG, userId: ANA, db, logger: silentLogger };
    await ingestAttachments(ctx, input([ref()]));

    const fetchBytes = vi.fn(async () => Buffer.from('otra cosa'));
    const again = await ingestAttachments(ctx, input([ref()], fetchBytes));

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(again.archived).toBe(0);
    expect(tables.kb_documents?.filter((d) => d.id !== THREAD_DOC)).toHaveLength(1);
  });

  it('anota lo descartado con su motivo, para no volver a bajarlo mañana', async () => {
    const { tables, db } = world();
    const fetchBytes = vi.fn(async () => Buffer.from('x'));
    const res = await ingestAttachments(
      { organizationId: ORG, userId: ANA, db, logger: silentLogger },
      input([ref({ filename: 'demo.mp4', mime: 'video/mp4', sizeBytes: 40 * 1024 * 1024 })], fetchBytes),
    );

    expect(res.skipped).toBe(1);
    // No se descargó: ése es todo el punto de decidir antes de pedir.
    expect(fetchBytes).not.toHaveBeenCalled();
    const row = (tables.mail_attachment_ingests ?? [])[0];
    expect(row?.status).toBe('skipped');
    expect(row?.reason).toMatch(/MB/);
    expect(row?.document_id).toBeNull();
  });

  it('el mismo archivo llegado por otro hilo apunta al documento que ya existe', async () => {
    const { tables, db } = world();
    const ctx = { organizationId: ORG, userId: ANA, db, logger: silentLogger };
    await ingestAttachments(ctx, input([ref()]));

    const second = {
      ...input([ref({ key: 'att-9', messageId: 'msg-9' })]),
      threadId: 'thread-2',
    };
    const res = await ingestAttachments(ctx, second);

    expect(res.archived).toBe(0);
    // Un documento, no dos: tres copias del mismo PDF compitiendo en la
    // recuperación es peor que ninguna.
    expect(tables.kb_documents?.filter((d) => d.id !== THREAD_DOC)).toHaveLength(1);
    const row = (tables.mail_attachment_ingests ?? []).find((r) => r.thread_id === 'thread-2');
    expect(row?.status).toBe('ready');
    expect(row?.document_id).toBe(
      tables.kb_documents?.find((d) => d.id !== THREAD_DOC)?.id,
    );
  });

  it('un adjunto que falla no se lleva por delante a los demás', async () => {
    const { tables, db } = world();
    const fetchBytes = vi.fn(async (r: MailAttachmentRef) => {
      if (r.filename === 'roto.txt') throw new Error('Gmail devolvió 500');
      return Buffer.from('El plazo de pago acordado es de treinta días calendario.');
    });

    const res = await ingestAttachments(
      { organizationId: ORG, userId: ANA, db, logger: silentLogger },
      input(
        [
          ref({ key: 'a', filename: 'roto.txt' }),
          ref({ key: 'b', filename: 'bueno.txt', messageId: 'msg-2' }),
        ],
        fetchBytes,
      ),
    );

    expect(res.failed).toBe(1);
    expect(res.archived).toBe(1);
    expect(tables.kb_documents?.filter((d) => d.id !== THREAD_DOC)).toHaveLength(1);
  });

  it('un archivo sin texto dentro se anota como escaneo, no como fallo', async () => {
    const { tables, db } = world();
    const res = await ingestAttachments(
      { organizationId: ORG, userId: ANA, db, logger: silentLogger },
      input([ref()], async () => Buffer.from('   \n  \n ')),
    );

    expect(res.skipped).toBe(1);
    expect(res.failed).toBe(0);
    expect((tables.mail_attachment_ingests ?? [])[0]?.reason).toMatch(/OCR/);
  });
});
