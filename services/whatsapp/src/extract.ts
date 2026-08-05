import type { proto } from '@whiskeysockets/baileys';

/**
 * A Baileys message into the flat shape Cortex stores.
 *
 * WhatsApp's protobuf nests the same idea five ways — a caption on an image, a
 * caption on a document wrapped in a `documentWithCaptionMessage`, the same
 * message again inside `ephemeralMessage`, inside `viewOnceMessage`, inside
 * `editedMessage`. Reading only `conversation` (the obvious field) archives
 * about a third of a real group and silently drops the rest, so the unwrapping
 * is done properly, once, here.
 */

export type MessageKind =
  | 'text'
  | 'voice'
  | 'image'
  | 'video'
  | 'document'
  | 'location'
  | 'contact'
  | 'other';

export interface ExtractedMessage {
  messageId: string;
  groupJid: string;
  senderJid: string | null;
  senderName: string | null;
  sentAt: string;
  body: string | null;
  kind: MessageKind;
  mediaMime: string | null;
  mediaFilename: string | null;
  /** True when this is worth pulling bytes for. See `shouldDownload`. */
  hasMedia: boolean;
}

type AnyMessage = proto.IMessage | null | undefined;

/**
 * Peel the wrappers off until the real content is reached.
 *
 * Bounded rather than recursive-until-done: a malformed message could nest
 * forever, and this runs on every message a busy group produces.
 */
export function unwrap(message: AnyMessage): proto.IMessage | null {
  let current = message ?? null;
  for (let depth = 0; depth < 5 && current; depth++) {
    const inner =
      current.ephemeralMessage?.message ??
      current.viewOnceMessage?.message ??
      current.viewOnceMessageV2?.message ??
      current.viewOnceMessageV2Extension?.message ??
      current.documentWithCaptionMessage?.message ??
      current.editedMessage?.message ??
      null;
    if (!inner) return current;
    current = inner;
  }
  return current;
}

function classify(message: proto.IMessage): {
  kind: MessageKind;
  body: string | null;
  mime: string | null;
  filename: string | null;
  hasMedia: boolean;
} {
  if (message.conversation) {
    return {
      kind: 'text',
      body: message.conversation,
      mime: null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.extendedTextMessage?.text) {
    return {
      kind: 'text',
      body: message.extendedTextMessage.text,
      mime: null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.audioMessage) {
    // `ptt` is what distinguishes a voice note held down in the app from an
    // audio file someone attached. Only the first is treated as speech.
    return {
      kind: message.audioMessage.ptt ? 'voice' : 'other',
      body: null,
      mime: message.audioMessage.mimetype ?? 'audio/ogg',
      filename: null,
      hasMedia: Boolean(message.audioMessage.ptt),
    };
  }
  if (message.imageMessage) {
    return {
      kind: 'image',
      body: message.imageMessage.caption ?? null,
      mime: message.imageMessage.mimetype ?? null,
      filename: null,
      // The caption carries the meaning; the pixels are not something Brain
      // Knowledge can read. See `whatsapp/media.ts` in agent-tools.
      hasMedia: false,
    };
  }
  if (message.videoMessage) {
    return {
      kind: 'video',
      body: message.videoMessage.caption ?? null,
      mime: message.videoMessage.mimetype ?? null,
      filename: null,
      hasMedia: false,
    };
  }
  if (message.documentMessage) {
    return {
      kind: 'document',
      body: message.documentMessage.caption ?? null,
      mime: message.documentMessage.mimetype ?? null,
      filename: message.documentMessage.fileName ?? null,
      hasMedia: true,
    };
  }
  if (message.locationMessage || message.liveLocationMessage) {
    const location = message.locationMessage ?? message.liveLocationMessage;
    const name =
      (location as { name?: string | null } | null)?.name ??
      (location as { address?: string | null } | null)?.address ??
      null;
    return { kind: 'location', body: name, mime: null, filename: null, hasMedia: false };
  }
  if (message.contactMessage || message.contactsArrayMessage) {
    return {
      kind: 'contact',
      body: message.contactMessage?.displayName ?? null,
      mime: null,
      filename: null,
      hasMedia: false,
    };
  }
  return { kind: 'other', body: null, mime: null, filename: null, hasMedia: false };
}

/**
 * @returns null for anything that is not a real message from another person in
 *   a group — our own messages, protocol frames, reactions, receipts.
 */
export function extractGroupMessage(raw: proto.IWebMessageInfo): ExtractedMessage | null {
  const groupJid = raw.key?.remoteJid ?? '';
  if (!groupJid.endsWith('@g.us')) return null;
  // Our own messages are not part of the conversation being archived — the
  // account is a silent member and never writes in a group.
  if (raw.key?.fromMe) return null;
  const messageId = raw.key?.id;
  if (!messageId) return null;

  const message = unwrap(raw.message);
  if (!message) return null;
  // Reactions, edits-of-edits, poll updates and protocol frames are events
  // about the conversation rather than part of it.
  if (message.reactionMessage || message.protocolMessage || message.pollUpdateMessage) return null;

  const detail = classify(message);
  if (detail.kind === 'other' && !detail.body) return null;

  const timestamp = Number(raw.messageTimestamp ?? 0);
  const sentAt = new Date(
    // WhatsApp stamps in seconds; a zero means it never arrived, and dating the
    // message "now" would put it in the wrong conversation window.
    (Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Math.floor(Date.now() / 1000)) *
      1000,
  ).toISOString();

  return {
    messageId,
    groupJid,
    senderJid: raw.key?.participant ?? raw.participant ?? null,
    senderName: raw.pushName ?? null,
    sentAt,
    body: detail.body?.trim() || null,
    kind: detail.kind,
    mediaMime: detail.mime,
    mediaFilename: detail.filename,
    hasMedia: detail.hasMedia,
  };
}

/** The plain text of an incoming direct message, or null if there is none. */
export function extractDirectText(raw: proto.IWebMessageInfo): string | null {
  const message = unwrap(raw.message);
  if (!message) return null;
  const text = message.conversation ?? message.extendedTextMessage?.text ?? null;
  return text?.trim() || null;
}
