/**
 * Gemini chat client — multimodal (text, image, audio).
 * Uses gemini-2.5-flash. Maintains conversation history per group.
 */
import fs from 'fs';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const HISTORY_FILE = '/workspace/group/gemini-history.json';
const MAX_HISTORY = 20;

// Image marker written by whatsapp.ts: [Image: /workspace/group/images/file.jpg]
const IMAGE_MARKER = /\[Image:\s*([^\]]+)\]/g;

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiContent {
  role: 'user' | 'model';
  parts: GeminiPart[];
}

function loadHistory(): GeminiContent[] {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch {}
  return [];
}

function saveHistory(history: GeminiContent[]): void {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {}
}

function buildSystemInstruction(assistantName: string): string {
  const paths = ['/workspace/group/CLAUDE.md', '/workspace/global/CLAUDE.md'];
  for (const p of paths) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
  }
  return `You are ${assistantName}, a personal AI assistant powered by Google Gemini. Be helpful, concise, and friendly. Reply in the same language as the user.`;
}

function mimeFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    mp4: 'video/mp4', webm: 'video/webm',
  };
  return map[ext] || 'image/jpeg';
}

function buildUserParts(prompt: string): GeminiPart[] {
  const parts: GeminiPart[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  const regex = new RegExp(IMAGE_MARKER.source, 'g');

  while ((match = regex.exec(prompt)) !== null) {
    // Text before the image marker
    const textBefore = prompt.slice(lastIndex, match.index).trim();
    if (textBefore) parts.push({ text: textBefore });

    // Load image
    const imagePath = match[1].trim();
    try {
      const buffer = fs.readFileSync(imagePath);
      const mimeType = mimeFromPath(imagePath);
      parts.push({ inlineData: { mimeType, data: buffer.toString('base64') } });
    } catch (err) {
      parts.push({ text: `[Imagem não encontrada: ${imagePath}]` });
    }

    lastIndex = match.index + match[0].length;
  }

  // Remaining text after last image
  const remaining = prompt.slice(lastIndex).trim();
  if (remaining) parts.push({ text: remaining });

  // Fallback: just text
  if (parts.length === 0) parts.push({ text: prompt });

  return parts;
}

export async function runGeminiChat(
  prompt: string,
  assistantName = 'Atlas',
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set in container env');

  const history = loadHistory();
  const userParts = buildUserParts(prompt);
  history.push({ role: 'user', parts: userParts });

  const body = {
    system_instruction: { parts: [{ text: buildSystemInstruction(assistantName) }] },
    contents: history,
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
  };

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${err}`);
  }

  const data = (await response.json()) as {
    candidates: { content: { parts: GeminiPart[] } }[];
  };
  const reply = data.candidates?.[0]?.content?.parts
    ?.map((p) => p.text ?? '')
    .join('') ?? '';

  if (reply) {
    // Save history with text-only representation of user turn (images not stored)
    const textOnly = userParts.map(p => p.text || '[image]').join(' ');
    history[history.length - 1] = { role: 'user', parts: [{ text: textOnly }] };
    history.push({ role: 'model', parts: [{ text: reply }] });
    saveHistory(history);
  }

  return reply;
}

export async function transcribeAudioWithGemini(
  audioBuffer: Buffer,
  mimeType = 'audio/ogg',
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: audioBuffer.toString('base64') } },
        { text: 'Transcreva este áudio em texto. Responda apenas com a transcrição literal, sem comentários ou formatação adicional.' },
      ],
    }],
  };

  const response = await fetch(`${GEMINI_API_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    console.error(`Gemini transcription error ${response.status}: ${await response.text()}`);
    return null;
  }

  const data = (await response.json()) as {
    candidates: { content: { parts: { text?: string }[] } }[];
  };
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim() ?? null;
}
