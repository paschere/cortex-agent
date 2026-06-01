export interface SlackPostMessageResult {
  ok: boolean;
  ts?: string;
  channel?: string;
  error?: string;
  [k: string]: unknown;
}

export async function slackPostMessage(body: {
  channel: string;
  text: string;
}): Promise<SlackPostMessageResult> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    throw new Error('SLACK_BOT_TOKEN not configured');
  }
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: 'Bearer ' + token,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const raw = await res.text().catch(() => '');
    throw new Error('Slack HTTP ' + res.status + ': ' + raw.slice(0, 300));
  }
  const data = (await res.json()) as SlackPostMessageResult;
  if (!data.ok) {
    throw new Error('Slack chat.postMessage failed: ' + (data.error ?? 'unknown_error'));
  }
  return data;
}
