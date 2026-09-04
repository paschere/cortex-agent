import { generateText } from 'ai';
import { utilityModel } from '../model';
import { type CallEvent, clockAt } from './timeline';

/**
 * Una lectura corta de lo que se VEÍA cuando alguien compartió.
 *
 * El fotograma ya está en app_files; esto solo escribe una frase en
 * `timeline[].caption` para que la búsqueda y el chat de Llamadas sepan
 * «era un Excel de cotización» sin volver a mandar la imagen cada vez.
 */

export interface CaptionableFrame {
  at: number;
  label: string;
  speaker?: string | null;
  image: string;
  mimeType?: string;
}

export async function captionCallFrames(frames: CaptionableFrame[]): Promise<string[]> {
  if (frames.length === 0) return [];
  const content: Array<
    { type: 'text'; text: string } | { type: 'image'; image: string; mimeType: string }
  > = [
    {
      type: 'text',
      text: [
        'Estas son capturas de una reunión de Google Meet, en orden.',
        'Para cada cuadro, una sola frase en español: qué se ve (documento, diapositiva, hoja, pestaña) y cualquier cifra o título legible.',
        'Si es solo el mosaico de caras, dilo. No inventes texto que no se lea. Responde una línea por cuadro, numeradas.',
      ].join(' '),
    },
  ];
  for (const [i, frame] of frames.entries()) {
    content.push({
      type: 'text',
      text: `Cuadro ${i + 1} · ${clockAt(frame.at)} · ${frame.speaker ?? 'sala'} · ${frame.label}`,
    });
    content.push({
      type: 'image',
      image: frame.image,
      mimeType: frame.mimeType ?? 'image/jpeg',
    });
  }

  const { text } = await generateText({
    model: utilityModel(),
    messages: [{ role: 'user', content }],
    maxTokens: 700,
  });

  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);
  return frames.map((_, i) => (lines[i] ?? '').slice(0, 280));
}

export function applyCaptions(events: CallEvent[], frames: CaptionableFrame[], captions: string[]): CallEvent[] {
  const byAt = new Map<number, string>();
  frames.forEach((f, i) => {
    const c = captions[i]?.trim();
    if (c) byAt.set(f.at, c);
  });
  if (byAt.size === 0) return events;
  return events.map((e) => {
    const caption = e.path ? byAt.get(e.at) : undefined;
    return caption ? { ...e, caption } : e;
  });
}
