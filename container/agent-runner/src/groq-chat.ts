/**
 * Groq chat client for normal conversations.
 * Uses OpenAI-compatible API with llama-3.3-70b-versatile.
 * Maintains conversation history per group in /workspace/group/groq-history.json.
 */
import fs from 'fs';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const HISTORY_FILE = '/workspace/group/groq-history.json';
const MAX_HISTORY_MESSAGES = 20;

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function loadHistory(): Message[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveHistory(messages: Message[]): void {
  const trimmed = messages.slice(-MAX_HISTORY_MESSAGES);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(trimmed));
}

function buildSystemPrompt(assistantName: string): string {
  const paths = ['/workspace/group/CLAUDE.md', '/workspace/global/CLAUDE.md'];
  for (const p of paths) {
    if (fs.existsSync(p)) {
      return fs.readFileSync(p, 'utf-8');
    }
  }
  return `You are ${assistantName}, a personal AI assistant. Be helpful, concise, and friendly. Reply in the same language as the user.`;
}

export async function runGroqChat(
  prompt: string,
  assistantName = 'Atlas',
): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set in container env');

  const history = loadHistory();
  history.push({ role: 'user', content: prompt });

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt(assistantName) },
    ...history,
  ];

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      max_tokens: 1024,
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };
  const reply = data.choices?.[0]?.message?.content ?? '';

  if (reply) {
    history.push({ role: 'assistant', content: reply });
    saveHistory(history);
  }

  return reply;
}
