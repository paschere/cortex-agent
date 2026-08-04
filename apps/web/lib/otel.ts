import { type Span, trace } from '@opentelemetry/api';

const tracer = trace.getTracer('cortex-agent');

export async function withToolSpan<T>(
  toolId: string,
  attrs: Record<string, string | number>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(`tool.${toolId}`, { attributes: attrs }, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err as Error);
      throw err;
    } finally {
      span.end();
    }
  });
}
