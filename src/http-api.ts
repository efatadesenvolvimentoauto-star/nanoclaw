import http from 'http';

import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import { getAllTasks } from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

// Virtual JID used for Efata web platform messages (not a real WhatsApp JID)
export const EFATA_WEB_JID = 'efata-web@virtual';

const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3001', 10);

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function startHttpApi(options: {
  registeredGroups: () => Record<string, RegisteredGroup>;
  sessions: () => Record<string, string>;
  setSession: (folder: string, sessionId: string) => void;
  queue: GroupQueue;
  assistantName: string;
  ownerPhone?: string;
  ownerLid?: string;
}): http.Server {
  const secret = process.env.NANOCLAW_SECRET || '';

  const server = http.createServer(async (req, res) => {
    const sendJson = (status: number, body: object) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/health') {
      sendJson(200, { status: 'ok' });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/chat') {
      sendJson(404, { error: 'Not found' });
      return;
    }

    // Auth
    if (secret) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${secret}`) {
        sendJson(401, { error: 'Unauthorized' });
        return;
      }
    }

    let body: { userId?: string; message?: string; senderName?: string };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(400, { error: 'Invalid JSON' });
      return;
    }

    const { userId, message, senderName } = body;
    if (!userId || !message) {
      sendJson(400, { error: 'Missing userId or message' });
      return;
    }

    // Find the main group to use as execution context
    const groups = options.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
    if (!mainEntry) {
      sendJson(503, { error: 'Atlas unavailable' });
      return;
    }
    const [, group] = mainEntry;

    const displayName = senderName || userId;
    const prompt = `[${displayName} via Efata Web]: ${message}`;
    const sessionId = options.sessions()[group.folder];

    // Keep task snapshot fresh so the agent can see scheduled tasks
    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      true,
      tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
    );

    const input: ContainerInput = {
      prompt,
      sessionId,
      groupFolder: group.folder,
      chatJid: EFATA_WEB_JID,
      isMain: true,
      assistantName: options.assistantName,
      senderPhone: userId,
      ownerPhone: options.ownerPhone,
      ownerLid: options.ownerLid,
    };

    let responseText = '';
    let agentError = '';

    try {
      const output = await runContainerAgent(
        group,
        input,
        (proc, containerName) =>
          options.queue.registerProcess(
            EFATA_WEB_JID,
            proc,
            containerName,
            group.folder,
          ),
        async (result: ContainerOutput) => {
          if (result.newSessionId) {
            options.setSession(group.folder, result.newSessionId);
          }
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              responseText += (responseText ? '\n' : '') + text;
            }
          }
          if (result.status === 'error') {
            agentError = result.error || 'Agent error';
          }
        },
      );

      if (output.newSessionId) {
        options.setSession(group.folder, output.newSessionId);
      }

      if (agentError || output.status === 'error') {
        logger.error({ agentError, userId }, 'HTTP chat agent error');
        sendJson(500, { error: agentError || 'Agent failed' });
        return;
      }

      logger.info(
        { userId, displayName, responseLen: responseText.length },
        'HTTP chat response',
      );
      sendJson(200, { response: responseText || '' });
    } catch (err) {
      logger.error({ err, userId }, 'HTTP chat error');
      sendJson(500, { error: 'Internal error' });
    }
  });

  server.listen(HTTP_PORT, '0.0.0.0', () => {
    logger.info({ port: HTTP_PORT }, 'HTTP API listening');
  });

  return server;
}
