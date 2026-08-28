import { describe, expect, it } from 'vitest';
import { filterTools } from '../../index';
import {
  ERRAND_TOOLS,
  ERRAND_TRAMITE_TOOLS,
  OutboundToolRefused,
  assertProposalOnly,
  errandToolAllowlist,
  isErrandTool,
  readsAsOutbound,
} from '../boundary';
import { toolsFor } from '../kinds';

/**
 * THE TEST THAT GUARDS THE LINE.
 *
 * An errand searches, compares and proposes; it never buys, books, signs or
 * sends. That promise is kept by an allow-list of exact tool ids, and an
 * allow-list is only as good as the review it gets — so the review happens in
 * CI, against the real registry, on every diff.
 *
 * If one of these fails, the fix is almost never to widen the list. It is to
 * ask why an errand needs a tool that can act outward, and the answer is that
 * it does not: whatever wants sending goes through /approvals or /actions,
 * where a person sees it first and the payload is hash-bound to what they
 * approved.
 */
describe('the errand boundary', () => {
  it('names only tools the registry actually has', () => {
    // A hallucinated id in the allow-list is worse than useless: it looks like
    // a capability, silently matches nothing, and hides the fact that the
    // errand never had that ability at all.
    const known = new Set(filterTools(['*']).map((t) => t.id));
    const missing = ERRAND_TOOLS.filter((id) => !known.has(id));
    expect(missing, `these ids are not in the registry: ${missing.join(', ')}`).toEqual([]);
  });

  it('hands out nothing that needs a human to approve it', () => {
    // `requiresConfirmation` is the registry's own statement that a tool has
    // consequences a person must see. An unattended run must never be offered
    // one — and the fact that the executor would turn it into a skip is not a
    // reason to offer it, it is a reason it should not be in this list.
    const offenders = filterTools([...ERRAND_TOOLS])
      .filter((t) => t.requiresConfirmation)
      .map((t) => t.id);
    expect(offenders, `these require approval and cannot be in an errand: ${offenders}`).toEqual(
      [],
    );
  });

  it('hands out nothing whose name says it changes the world', () => {
    // A blunt instrument on purpose. It cannot prove a tool is read-only, but
    // it catches the whole class of mistake this list exists to prevent — a
    // `send`, a `create`, a `submit` slipping in beside its harmless siblings
    // during a hurried diff.
    const offenders = ERRAND_TOOLS.filter(readsAsOutbound);
    expect(offenders, `these read as outbound: ${offenders.join(', ')}`).toEqual([]);
  });

  it('the outbound heuristic catches the real ones without flagging reads', () => {
    // The guard above is only useful if it is calibrated. These are the exact
    // cases that made it a whole-segment match rather than a substring one.
    for (const outbound of [
      'gmail.send_message',
      'slack.post_message',
      'hubspot.create_deal',
      'gsheets.append_row',
      'reports.share',
      'browser.run_flow',
      'payroll.run',
      'commitments.record',
      'commitments.mark_met',
      'hubspot.log_activity',
    ]) {
      expect(readsAsOutbound(outbound), `${outbound} should read as outbound`).toBe(true);
    }
    for (const read of [
      'documents.records',
      'documents.totals',
      'web.search',
      'github.repo_activity',
      'linear.list_issues',
      'kb.context',
    ]) {
      expect(readsAsOutbound(read), `${read} is a read`).toBe(false);
    }
  });

  it('contains no wildcards, so a new tool is never granted by accident', () => {
    // The load-bearing rule. `gmail.*` would have absorbed `gmail.send_message`
    // the day it was added, with no diff to review and no test to fail.
    expect(ERRAND_TOOLS.filter((id) => id.includes('*'))).toEqual([]);
  });

  it('specifically withholds the tools that send, buy, book or publish', () => {
    // Spelled out rather than derived, because these are the exact ids that
    // would break the promise, and a named test failure is a better warning
    // than a heuristic one.
    for (const forbidden of [
      'gmail.send_message',
      'gmail.send_draft',
      'gmail.draft',
      'outlook.send_draft',
      'slack.post_message',
      'chat.send_message',
      'chat.send_dm',
      'hubspot.create_deal',
      'hubspot.update_deal',
      'linear.create_issue',
      'github.create_issue',
      'gcal.create_event',
      'mscal.create_event',
      'gsheets.append_row',
      'reports.share',
      'actions.propose',
      'payroll.run',
      // The taught browser (0087). Absent deliberately and not by oversight —
      // see the header of boundary.ts for where it will plug in and why it
      // cannot be admitted as a family.
      'browser.run_flow',
      'browser.submit_flow',
    ]) {
      expect(isErrandTool(forbidden), `${forbidden} must never be an errand tool`).toBe(false);
    }
  });

  it('withholds the errand tools themselves, so an errand cannot spawn an errand', () => {
    // `errands.start` is invokable from the chat, which means it is a tool like
    // any other — and a tool an errand's own sub-agents could reach would let
    // one ambiguous request fan out into a tree of autonomous work nobody
    // authorised, walking straight past the per-workspace live cap from the
    // inside. `errands.status` and `errands.answer` are withheld for the
    // narrower reason that an errand answering its own clarifying question is
    // the exact behaviour the question exists to prevent.
    for (const own of ['errands.start', 'errands.status', 'errands.answer']) {
      expect(isErrandTool(own), `${own} must never be handed to an errand's legs`).toBe(false);
    }
  });

  it('refuses the whole set when anything outbound is asked for', () => {
    expect(() => assertProposalOnly(['web.search', 'gmail.send_message'])).toThrow(
      OutboundToolRefused,
    );
    // All-or-nothing: a caller that asked for a sending tool has misunderstood
    // what an errand is, and quietly dropping it would ship that
    // misunderstanding.
    try {
      assertProposalOnly(['web.search', 'gmail.send_message', 'slack.post_message']);
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(OutboundToolRefused);
      expect((err as OutboundToolRefused).toolIds).toEqual([
        'gmail.send_message',
        'slack.post_message',
      ]);
      expect((err as OutboundToolRefused).spanish).toContain('no compra');
    }
  });

  it('passes the allow-list itself, and passes what every kind is handed', () => {
    expect(() => assertProposalOnly(errandToolAllowlist())).not.toThrow();
    for (const kind of ['research_compare', 'gather_sources', 'monitor_change'] as const) {
      expect(() => assertProposalOnly(toolsFor(kind))).not.toThrow();
    }
  });

  it('hands back a copy, so nobody can widen the line for the rest of the process', () => {
    const first = errandToolAllowlist();
    first.push('gmail.send_message');
    expect(isErrandTool('gmail.send_message')).toBe(false);
    expect(errandToolAllowlist()).not.toContain('gmail.send_message');
  });

  it('still lets an errand do its actual job', () => {
    // The negative tests above are satisfiable by an empty list. This one says
    // the boundary did not achieve safety by achieving nothing.
    for (const needed of ['web.search', 'web.scrape', 'kb.search']) {
      expect(isErrandTool(needed)).toBe(true);
    }
    expect(filterTools([...ERRAND_TOOLS]).length).toBeGreaterThan(15);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOS TRÁMITES WEB, ADMITIDOS DE A UNO
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `boundary.ts` escribió, antes de que existiera la función, cuál sería el
 * movimiento correcto: NO meter `browser.run_flow` en `ERRAND_TOOLS`, sino
 * admitir flujos marcados uno por uno. Estas pruebas son sobre esa distinción,
 * que es fácil de perder en un diff apurado — meter la herramienta en la lista
 * de siempre haría pasar el caso feliz y volaría la línea entera.
 */
describe('un encargo y los trámites web', () => {
  it('sigue sin tener la herramienta en la lista de siempre', () => {
    // Lo que hace que un espacio de trabajo que nunca abrió esta puerta tenga
    // un encargo idéntico al de antes.
    expect(isErrandTool('browser.run_flow')).toBe(false);
    expect(errandToolAllowlist()).not.toContain('browser.run_flow');
    expect(() => assertProposalOnly(['web.search', 'browser.run_flow'])).toThrow(
      OutboundToolRefused,
    );
  });

  it('sin ningún trámite marcado, admitir no admite nada', () => {
    // El caso que decide si esto es un permiso o un interruptor. Una lista
    // vacía de flujos tiene que comportarse exactamente como no pasar nada.
    const none = { admittedFlows: [] };
    expect(errandToolAllowlist(none)).toEqual(errandToolAllowlist());
    expect(() => assertProposalOnly(['browser.run_flow'], none)).toThrow(OutboundToolRefused);
  });

  it('con un trámite marcado, admite exactamente dos ids', () => {
    const admitted = { admittedFlows: ['certificado-dian'] };
    const widened = errandToolAllowlist(admitted);
    const added = widened.filter((id) => !ERRAND_TOOLS.includes(id));
    expect(added.sort()).toEqual(['browser.list_flows', 'browser.run_flow']);
    expect(() => assertProposalOnly(widened, admitted)).not.toThrow();
  });

  it('nunca admite el que escribe en el portal ajeno, marcado o no', () => {
    // La única cosa que este archivo entero existe para decir: una corrida
    // desatendida no radica nada. `browser.submit_flow` además lleva
    // `requiresConfirmation`, así que el propio ejecutor lo saltaría — pero
    // que algo más lo pararía nunca ha sido razón para ofrecerlo.
    const admitted = { admittedFlows: ['radicar-dian', 'otro'] };
    expect(errandToolAllowlist(admitted)).not.toContain('browser.submit_flow');
    expect(() => assertProposalOnly(['browser.submit_flow'], admitted)).toThrow(
      OutboundToolRefused,
    );
    expect(ERRAND_TRAMITE_TOOLS).not.toContain('browser.submit_flow');
  });

  it('la puerta abierta no se lleva por delante nada más', () => {
    // Admitir un trámite no puede ser una forma indirecta de admitir un correo.
    const admitted = { admittedFlows: ['certificado-dian'] };
    expect(() => assertProposalOnly(['gmail.send_message'], admitted)).toThrow(OutboundToolRefused);
    expect(() => assertProposalOnly(['errands.start'], admitted)).toThrow(OutboundToolRefused);
  });

  it('los dos ids que admite existen de verdad en el registro', () => {
    // Mismo argumento que para la lista principal: un id inventado parece una
    // capacidad, no coincide con nada y esconde que nunca existió.
    const known = new Set(filterTools(['*']).map((t) => t.id));
    expect(ERRAND_TRAMITE_TOOLS.filter((id) => !known.has(id))).toEqual([]);
  });

  it('el catálogo viaja con el ejecutor, porque uno sin el otro no sabe qué correr', () => {
    // `run_flow` recibe un slug. Un sub-agente con el ejecutor y sin el
    // catálogo tiene que inventarse uno.
    expect(ERRAND_TRAMITE_TOOLS).toContain('browser.list_flows');
  });

  it('cada tipo de encargo recibe lo mismo, admitido o no', () => {
    const admitted = { admittedFlows: ['certificado-dian'] };
    for (const kind of ['research_compare', 'gather_sources', 'monitor_change'] as const) {
      expect(() => assertProposalOnly(toolsFor(kind, admitted), admitted)).not.toThrow();
      expect(toolsFor(kind, admitted)).toContain('browser.run_flow');
      expect(toolsFor(kind)).not.toContain('browser.run_flow');
    }
  });
});

describe('lo que queda del guardarraíl', () => {
  it('still lets an errand do its actual job', () => {
    // The negative tests above are satisfiable by an empty list. This one says
    // the boundary did not achieve safety by achieving nothing.
    for (const needed of ['web.search', 'web.scrape', 'kb.search']) {
      expect(isErrandTool(needed)).toBe(true);
    }
    expect(filterTools([...ERRAND_TOOLS]).length).toBeGreaterThan(15);
  });
});
