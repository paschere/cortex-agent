import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Lo que estas pruebas vigilan es UN documento de más y UN archivo de menos.
 *
 * Promover es la única operación de este producto que publica algo sin que haya
 * un formulario delante: la pide el modelo, en medio de una conversación, sobre
 * un archivo que la persona ya había dicho que no quería guardar. Las dos
 * maneras de hacerlo mal no se ven en ninguna pantalla — un segundo documento
 * idéntico compitiendo consigo mismo en la recuperación, o un documento sin
 * original detrás que nadie descubre hasta que intenta descargarlo — así que se
 * fijan aquí.
 *
 * La base es un doble mínimo que implementa exactamente las formas de consulta
 * que usa la herramienta. Los espacios, la ingesta de texto y el almacén están
 * simulados: lo que se prueba es la DECISIÓN (qué camino, cuántas veces, qué se
 * le dice a la persona), no el troceado ni los embeddings, que tienen sus
 * propias pruebas.
 */

const SPACE = { id: 'space-1', name: 'Mis notas', kind: 'personal' as const };
const OTHER_SPACE = { id: 'space-2', name: 'Toda la empresa', kind: 'global' as const };

const spaces = {
  ensurePersonalSpace: vi.fn(async () => SPACE),
  resolveSpaceByName: vi.fn(async (_db: unknown, _u: string, name: string) =>
    name === OTHER_SPACE.name ? OTHER_SPACE : null,
  ),
  assertCanWriteToSpace: vi.fn(async () => OTHER_SPACE),
  listVisibleSpaces: vi.fn(async () => [SPACE, OTHER_SPACE]),
};
vi.mock('../../kb/spaces', () => spaces);

const ingestMarkdown = vi.fn(async (_db: unknown, _input: unknown) => ({
  documentId: 'doc-text',
  chunks: 3,
}));
vi.mock('../../kb/ingest', () => ({ ingestMarkdown }));

const files = {
  getFile: vi.fn(async () => null as { content: Uint8Array; contentType: string | null } | null),
  putFile: vi.fn(async () => undefined),
  removeFiles: vi.fn(async () => undefined),
};
vi.mock('../../files', () => files);

const { attachmentsPromote } = await import('../promote');
import type { ToolContext } from '../../types';

// ---------------------------------------------------------------------------
// La base, con sólo las dos tablas que la herramienta toca
// ---------------------------------------------------------------------------
type Row = Record<string, unknown>;

/**
 * Clase y no objeto literal: PostgREST se espera con `await` sin terminador, así
 * que el constructor tiene que ser «thenable», y un `then` puesto a mano sobre
 * un objeto es precisamente lo que la regla `noThenProperty` prohíbe — con razón,
 * porque en un objeto de datos es una trampa. Aquí es la interfaz que se está
 * imitando. Mismo recurso que `vehicles/__tests__/vehicles-tools.test.ts`.
 */
class Builder {
  private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private patch: Row = {};
  private filtered: Row[];

  constructor(
    private readonly rows: Row[],
    private readonly sink: { inserted: Row[]; deleted: string[] },
  ) {
    this.filtered = [...rows];
  }

  select() {
    return this;
  }
  insert(row: Row) {
    this.op = 'insert';
    this.patch = row;
    return this;
  }
  update(row: Row) {
    this.op = 'update';
    this.patch = row;
    return this;
  }
  delete() {
    this.op = 'delete';
    return this;
  }
  eq(col: string, value: unknown) {
    this.filtered = this.filtered.filter((r) => r[col] === value);
    return this;
  }
  is(col: string, value: unknown) {
    this.filtered = this.filtered.filter((r) => (r[col] ?? null) === value);
    return this;
  }
  limit() {
    return this;
  }
  async maybeSingle() {
    return { data: this.filtered[0] ?? null, error: null };
  }
  async single() {
    return { data: this.filtered[0] ?? null, error: null };
  }

  // biome-ignore lint/suspicious/noThenProperty: los query builders de supabase-js son thenables; el doble tiene que serlo para poder suplantarlos.
  then<T>(resolve: (v: { data: unknown; error: unknown }) => T): PromiseLike<T> {
    if (this.op === 'insert') {
      this.rows.push(this.patch);
      this.sink.inserted.push(this.patch);
    }
    if (this.op === 'update') for (const r of this.filtered) Object.assign(r, this.patch);
    if (this.op === 'delete') {
      for (const r of this.filtered) {
        this.sink.deleted.push(r.id as string);
        this.rows.splice(this.rows.indexOf(r), 1);
      }
    }
    return Promise.resolve({ data: null, error: null }).then(resolve);
  }
}

function makeDb(store: { chat_attachments: Row[]; kb_documents: Row[] }) {
  const sink = { inserted: [] as Row[], deleted: [] as string[] };
  const db = {
    from: (table: string) => new Builder(store[table as keyof typeof store], sink),
  } as never;
  return { db, inserted: sink.inserted, deleted: sink.deleted };
}

const ATTACHMENT: Row = {
  id: 'att-1',
  disposition: 'turn',
  filename: 'contrato.pdf',
  mime: 'application/pdf',
  sha256: 'abc123',
  extracted_text: 'CLÁUSULA PRIMERA. El objeto del contrato es…',
  file_path: 'user-1/att-1/contrato.pdf',
  promoted_document_id: null,
  promoted_space_id: null,
};

function makeCtx(
  db: unknown,
  enqueue?: (n: string, d: Record<string, unknown>) => Promise<boolean>,
) {
  return {
    organizationId: 'org-1',
    userId: 'user-1',
    agentId: 'agent-1',
    db,
    integrations: {} as never,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    enqueueJob: enqueue,
  } as unknown as ToolContext;
}

const run = (ctx: ToolContext, input: { attachmentId: string; space?: string }) =>
  attachmentsPromote.handler(input, ctx);

beforeEach(() => {
  vi.clearAllMocks();
  files.getFile.mockResolvedValue(null);
  ingestMarkdown.mockResolvedValue({ documentId: 'doc-text', chunks: 3 });
});

describe('attachments.promote — con el archivo detrás', () => {
  it('mete el archivo por la tubería de siempre y encola la ingesta', async () => {
    files.getFile.mockResolvedValue({ content: new Uint8Array([1, 2, 3]), contentType: 'pdf' });
    const enqueue = vi.fn(async () => true);
    const { db, inserted } = makeDb({ chat_attachments: [{ ...ATTACHMENT }], kb_documents: [] });

    const out = await run(makeCtx(db, enqueue), { attachmentId: 'att-1' });

    expect(out.promoted).toBe('file');
    expect(out.status).toBe('pending');
    expect(out.space).toBe('Mis notas');
    // El binario se copió al bucket del cerebro y el documento apunta ahí.
    expect(files.putFile).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ bucket: 'kb-uploads' }),
    );
    expect(inserted[0]).toMatchObject({ source: 'upload', status: 'pending', sha256: 'abc123' });
    expect(enqueue).toHaveBeenCalledWith('kb/document.ingest', { documentId: out.documentId });
    // Y NO se ingirió el texto: eso sería el documento de segunda.
    expect(ingestMarkdown).not.toHaveBeenCalled();
  });

  it('deja el rastro en el adjunto, para que la segunda llamada no cueste otro documento', async () => {
    files.getFile.mockResolvedValue({ content: new Uint8Array([1]), contentType: 'pdf' });
    const row = { ...ATTACHMENT };
    const { db } = makeDb({ chat_attachments: [row], kb_documents: [] });
    const ctx = makeCtx(
      db,
      vi.fn(async () => true),
    );

    const first = await run(ctx, { attachmentId: 'att-1' });
    expect(row.promoted_document_id).toBe(first.documentId);
    expect(row.promoted_space_id).toBe(SPACE.id);
    expect(row.promoted_at).toBeTruthy();

    const second = await run(ctx, { attachmentId: 'att-1' });
    expect(second.alreadyThere).toBe(true);
    expect(second.documentId).toBe(first.documentId);
  });

  it('si la cola no acepta el trabajo, deshace y guarda el texto en vez de dejar un documento que nunca se indexa', async () => {
    files.getFile.mockResolvedValue({ content: new Uint8Array([1]), contentType: 'pdf' });
    const { db, deleted } = makeDb({ chat_attachments: [{ ...ATTACHMENT }], kb_documents: [] });

    const out = await run(
      makeCtx(
        db,
        vi.fn(async () => false),
      ),
      { attachmentId: 'att-1' },
    );

    expect(deleted).toHaveLength(1);
    expect(files.removeFiles).toHaveBeenCalled();
    expect(out.promoted).toBe('text');
    expect(ingestMarkdown).toHaveBeenCalled();
  });
});

describe('attachments.promote — cuando ya no hay archivo', () => {
  it('promueve el texto y lo DICE', async () => {
    const { db } = makeDb({
      chat_attachments: [{ ...ATTACHMENT, file_path: null }],
      kb_documents: [],
    });

    const out = await run(
      makeCtx(
        db,
        vi.fn(async () => true),
      ),
      { attachmentId: 'att-1' },
    );

    expect(out.promoted).toBe('text');
    expect(out.status).toBe('ready');
    expect(out.note).toMatch(/no se puede volver a descargar/);
    expect(ingestMarkdown).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ collectionId: SPACE.id, title: 'contrato.pdf' }),
    );
  });

  it('sin cola en el contexto ni siquiera intenta el camino con bytes', async () => {
    files.getFile.mockResolvedValue({ content: new Uint8Array([1]), contentType: 'pdf' });
    const { db } = makeDb({ chat_attachments: [{ ...ATTACHMENT }], kb_documents: [] });

    const out = await run(makeCtx(db, undefined), { attachmentId: 'att-1' });

    expect(out.promoted).toBe('text');
    expect(files.getFile).not.toHaveBeenCalled();
  });

  it('sin archivo y sin texto no inventa nada', async () => {
    const { db } = makeDb({
      chat_attachments: [{ ...ATTACHMENT, file_path: null, extracted_text: '   ' }],
      kb_documents: [],
    });

    await expect(
      run(
        makeCtx(
          db,
          vi.fn(async () => true),
        ),
        { attachmentId: 'att-1' },
      ),
    ).rejects.toThrow(/volver a subirlo/);
  });
});

describe('attachments.promote — lo que no hace dos veces, y lo que no hace nunca', () => {
  it('reutiliza el documento que ya tiene esos mismos bytes en ese espacio', async () => {
    files.getFile.mockResolvedValue({ content: new Uint8Array([1]), contentType: 'pdf' });
    const row = { ...ATTACHMENT };
    const { db, inserted } = makeDb({
      chat_attachments: [row],
      kb_documents: [
        {
          id: 'doc-viejo',
          status: 'ready',
          source_ref: 'p',
          collection_id: SPACE.id,
          sha256: 'abc123',
        },
      ],
    });

    const out = await run(
      makeCtx(
        db,
        vi.fn(async () => true),
      ),
      { attachmentId: 'att-1' },
    );

    expect(out.documentId).toBe('doc-viejo');
    expect(out.alreadyThere).toBe(true);
    expect(out.status).toBe('ready');
    expect(inserted).toHaveLength(0);
    // Y queda anotado, para que ni siquiera vuelva a mirarlo.
    expect(row.promoted_document_id).toBe('doc-viejo');
  });

  it('un adjunto que ya entró a la memoria al subirse no se promueve', async () => {
    const { db } = makeDb({
      chat_attachments: [{ ...ATTACHMENT, disposition: 'memory', extracted_text: null }],
      kb_documents: [],
    });
    await expect(
      run(
        makeCtx(
          db,
          vi.fn(async () => true),
        ),
        { attachmentId: 'att-1' },
      ),
    ).rejects.toThrow(/ya había entrado a Brain Knowledge/);
  });

  it('un id que no existe en este espacio de trabajo es «no existe», no «no puedes»', async () => {
    const { db } = makeDb({ chat_attachments: [], kb_documents: [] });
    await expect(
      run(
        makeCtx(
          db,
          vi.fn(async () => true),
        ),
        { attachmentId: 'att-9' },
      ),
    ).rejects.toThrow(/No encuentro ese archivo adjunto/);
  });

  it('un espacio nombrado pasa por el permiso de escritura antes de tocar nada', async () => {
    files.getFile.mockResolvedValue({ content: new Uint8Array([1]), contentType: 'pdf' });
    const { db } = makeDb({ chat_attachments: [{ ...ATTACHMENT }], kb_documents: [] });

    const out = await run(
      makeCtx(
        db,
        vi.fn(async () => true),
      ),
      {
        attachmentId: 'att-1',
        space: 'Toda la empresa',
      },
    );

    expect(spaces.assertCanWriteToSpace).toHaveBeenCalled();
    expect(out.space).toBe('Toda la empresa');
  });

  it('un espacio que no existe se rechaza nombrando los que sí, y no escribe nada', async () => {
    const { db, inserted } = makeDb({ chat_attachments: [{ ...ATTACHMENT }], kb_documents: [] });
    await expect(
      run(
        makeCtx(
          db,
          vi.fn(async () => true),
        ),
        { attachmentId: 'att-1', space: 'Ventas' },
      ),
    ).rejects.toThrow(/Mis notas/);
    expect(inserted).toHaveLength(0);
    expect(spaces.assertCanWriteToSpace).not.toHaveBeenCalled();
  });
});

describe('attachments.promote — la puerta de entrada', () => {
  it('exige un uuid: el modelo tiene el id delante, no el nombre del archivo', () => {
    expect(attachmentsPromote.inputSchema.safeParse({ attachmentId: 'contrato.pdf' }).success).toBe(
      false,
    );
    expect(
      attachmentsPromote.inputSchema.safeParse({
        attachmentId: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(true);
  });
});
