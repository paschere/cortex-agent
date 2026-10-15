import { NO_THINKING, utilityModel } from '@cortex/agent-tools';
import { generateText } from 'ai';
import { TITLE_PROMPT, cleanGeneratedTitle, titleFromText } from './conversation-title';
import { toTuteo } from './es-co';

/** Título en español del primer pedido real; si el modelo falla, el pedido recortado. */
export async function generateConversationTitle(request: string): Promise<string> {
  try {
    const { text } = await generateText({
      model: utilityModel(),
      prompt: TITLE_PROMPT(request),
      providerOptions: NO_THINKING,
      maxTokens: 64,
      abortSignal: AbortSignal.timeout(8_000),
    });
    const cleaned = cleanGeneratedTitle(toTuteo(text));
    if (cleaned) return cleaned;
  } catch {
    /* cae al recorte */
  }
  return titleFromText(request);
}
