import { Channel, NewMessage } from './types.js';
import { formatLocalTime } from './timezone.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function formatMessages(
  messages: NewMessage[],
  timezone: string,
): string {
  const lines = messages.map((m) => {
    const displayTime = formatLocalTime(m.timestamp, timezone);
    const replyAttr = m.reply_to_message_id
      ? ` reply_to="${escapeXml(m.reply_to_message_id)}"`
      : '';
    const replySnippet =
      m.reply_to_message_content && m.reply_to_sender_name
        ? `\n  <quoted_message from="${escapeXml(m.reply_to_sender_name)}">${escapeXml(m.reply_to_message_content)}</quoted_message>`
        : '';
    const phoneAttr =
      m.sender && !m.is_from_me
        ? ` phone="${escapeXml(m.sender.split('@')[0].split(':')[0])}"`
        : '';
    return `<message sender="${escapeXml(m.sender_name)}"${phoneAttr} time="${escapeXml(displayTime)}"${replyAttr}>${replySnippet}${escapeXml(m.content)}</message>`;
  });

  const header = `<context timezone="${escapeXml(timezone)}" />\n`;

  return `${header}<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function stripToolArtifacts(text: string): string {
  return text
    .replace(/<internal>[\s\S]*?<\/internal>/g, '')
    .replace(/<execute_bash>[\s\S]*?<\/execute_bash>/g, '')
    .replace(/<read_file>[\s\S]*?<\/read_file>/g, '')
    .replace(/<write_file>[\s\S]*?<\/write_file>/g, '')
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    // Strip {"tool_code": ...} possibly prefixed with "json"
    .replace(/(?:^|\n)json?\s*\{[\s\S]*?"tool_code"[\s\S]*?\}/gm, '')
    .replace(/\{"tool_code"[\s\S]*?\}/g, '')
    // Strip bare bash/shell command lines (e.g. "bash\ncat /workspace/...")
    .replace(/^bash\n[^\n]+(\n[^\n]+)*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripToolArtifacts(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
