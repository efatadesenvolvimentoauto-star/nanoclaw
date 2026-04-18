import fs from 'fs';
import http from 'http';
import path from 'path';

import {
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  deleteTask,
  getAllTasks,
  getMessagesSince,
  getTaskById,
  getTaskRunLogs,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { logger } from './logger.js';
import { formatMessages } from './router.js';
import { RegisteredGroup } from './types.js';

// Paths allowed for memory read/write (relative to project root)
const MEMORY_ROOTS = ['groups/global', 'groups/whatsapp_main'];

function resolveMemoryPath(
  projectRoot: string,
  filePath: string,
): string | null {
  const normalized = path.normalize(filePath).replace(/^\//, '');
  const allowed = MEMORY_ROOTS.some((root) => normalized.startsWith(root));
  if (!allowed) return null;
  return path.join(projectRoot, normalized);
}

interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children?: FileNode[];
}

function buildFileTree(
  projectRoot: string,
  dirPath: string,
  relBase: string,
): FileNode[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const nodes: FileNode[] = [];
  for (const entry of entries) {
    const relPath = path.join(relBase, entry.name);
    if (entry.isDirectory()) {
      // Only recurse into relevant dirs
      const skipDirs = new Set(['logs', 'images', 'node_modules', '.git']);
      if (skipDirs.has(entry.name)) continue;
      nodes.push({
        name: entry.name,
        path: relPath,
        type: 'dir',
        children: buildFileTree(
          projectRoot,
          path.join(dirPath, entry.name),
          relPath,
        ),
      });
    } else if (entry.name.endsWith('.md') || entry.name === 'CLAUDE.md') {
      nodes.push({ name: entry.name, path: relPath, type: 'file' });
    }
  }
  return nodes.sort((a, b) =>
    a.type === b.type
      ? a.name.localeCompare(b.name)
      : a.type === 'dir'
        ? -1
        : 1,
  );
}

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
  timezone: string;
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

    // Auth for all non-health routes
    if (secret) {
      const auth = req.headers['authorization'] || '';
      if (auth !== `Bearer ${secret}`) {
        sendJson(401, { error: 'Unauthorized' });
        return;
      }
    }

    const url = new URL(req.url || '/', `http://localhost`);

    // --- Memory API ---
    if (url.pathname === '/memory/tree' && req.method === 'GET') {
      const projectRoot = process.cwd();
      const tree: FileNode[] = [];
      for (const root of MEMORY_ROOTS) {
        const absRoot = path.join(projectRoot, root);
        if (fs.existsSync(absRoot)) {
          tree.push({
            name: root,
            path: root,
            type: 'dir',
            children: buildFileTree(projectRoot, absRoot, root),
          });
        }
      }
      sendJson(200, { tree });
      return;
    }

    if (url.pathname === '/memory/file' && req.method === 'GET') {
      const filePath = url.searchParams.get('path') || '';
      const abs = resolveMemoryPath(process.cwd(), filePath);
      if (!abs) {
        sendJson(403, { error: 'Path not allowed' });
        return;
      }
      try {
        const content = fs.readFileSync(abs, 'utf-8');
        sendJson(200, { path: filePath, content });
      } catch {
        sendJson(404, { error: 'File not found' });
      }
      return;
    }

    if (url.pathname === '/memory/file' && req.method === 'PUT') {
      const rawBody = await readBody(req);
      let payload: { path?: string; content?: string };
      try {
        payload = JSON.parse(rawBody);
      } catch {
        sendJson(400, { error: 'Invalid JSON' });
        return;
      }
      const { path: filePath, content } = payload;
      if (!filePath || content === undefined) {
        sendJson(400, { error: 'Missing path or content' });
        return;
      }
      const abs = resolveMemoryPath(process.cwd(), filePath);
      if (!abs) {
        sendJson(403, { error: 'Path not allowed' });
        return;
      }
      try {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, content, 'utf-8');
        logger.info({ path: filePath }, 'Memory file updated via API');
        sendJson(200, { ok: true });
      } catch (err) {
        logger.error({ err, filePath }, 'Memory write error');
        sendJson(500, { error: 'Write failed' });
      }
      return;
    }

    if (url.pathname === '/memory/file' && req.method === 'DELETE') {
      const filePath = url.searchParams.get('path') || '';
      const abs = resolveMemoryPath(process.cwd(), filePath);
      if (!abs) {
        sendJson(403, { error: 'Path not allowed' });
        return;
      }
      try {
        fs.unlinkSync(abs);
        logger.info({ path: filePath }, 'Memory file deleted via API');
        sendJson(200, { ok: true });
      } catch {
        sendJson(404, { error: 'File not found' });
      }
      return;
    }
    // --- End Memory API ---

    // --- Tasks API ---
    // GET  /tasks          → list all tasks
    // GET  /tasks/:id      → get task + run logs
    // POST /tasks          → create task
    // PUT  /tasks/:id      → update task (status, prompt, etc.)
    // DELETE /tasks/:id    → delete task
    if (url.pathname === '/tasks' && req.method === 'GET') {
      sendJson(200, { tasks: getAllTasks() });
      return;
    }

    const taskMatch = url.pathname.match(/^\/tasks\/([^/]+)$/);
    if (taskMatch) {
      const taskId = taskMatch[1];

      if (req.method === 'GET') {
        const task = getTaskById(taskId);
        if (!task) {
          sendJson(404, { error: 'Task not found' });
          return;
        }
        const logs = getTaskRunLogs(taskId, 20);
        sendJson(200, { task, logs });
        return;
      }

      if (req.method === 'PUT') {
        let payload: Partial<import('./types.js').ScheduledTask>;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          sendJson(400, { error: 'Invalid JSON' });
          return;
        }
        const task = getTaskById(taskId);
        if (!task) {
          sendJson(404, { error: 'Task not found' });
          return;
        }
        updateTask(taskId, payload);
        sendJson(200, { ok: true, task: getTaskById(taskId) });
        return;
      }

      if (req.method === 'DELETE') {
        const task = getTaskById(taskId);
        if (!task) {
          sendJson(404, { error: 'Task not found' });
          return;
        }
        deleteTask(taskId);
        logger.info({ taskId }, 'Task deleted via API');
        sendJson(200, { ok: true });
        return;
      }
    }

    if (url.pathname === '/tasks' && req.method === 'POST') {
      let payload: {
        name?: string;
        prompt: string;
        schedule_type: 'cron' | 'interval' | 'once';
        schedule_value: string;
        group_folder?: string;
        chat_jid?: string;
        script?: string;
        initial_memory?: string;
      };
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        sendJson(400, { error: 'Invalid JSON' });
        return;
      }

      if (
        !payload.prompt ||
        !payload.schedule_type ||
        !payload.schedule_value
      ) {
        sendJson(400, {
          error: 'Missing prompt, schedule_type or schedule_value',
        });
        return;
      }

      const groups = options.registeredGroups();
      const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
      if (!mainEntry) {
        sendJson(503, { error: 'No group available' });
        return;
      }
      const [mainJid, mainGroup] = mainEntry;

      const now = new Date().toISOString();
      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const groupFolder = payload.group_folder || mainGroup.folder;

      // Seed specialist memory if provided
      if (payload.initial_memory && groupFolder !== mainGroup.folder) {
        const projectRoot = process.cwd();
        const claudeMdPath = path.join(
          projectRoot,
          'groups',
          groupFolder,
          'CLAUDE.md',
        );
        try {
          fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
          if (!fs.existsSync(claudeMdPath)) {
            fs.writeFileSync(claudeMdPath, payload.initial_memory, 'utf-8');
            logger.info({ groupFolder }, 'Specialist CLAUDE.md initialized');
          }
        } catch (err) {
          logger.error(
            { err, groupFolder },
            'Failed to write specialist CLAUDE.md',
          );
        }
      }

      createTask({
        id: taskId,
        name: payload.name || null,
        group_folder: groupFolder,
        chat_jid: payload.chat_jid || mainJid,
        prompt: payload.prompt,
        script: payload.script || null,
        schedule_type: payload.schedule_type,
        schedule_value: payload.schedule_value,
        context_mode: 'isolated',
        next_run: now,
        status: 'active',
        created_at: now,
      });
      const task = getTaskById(taskId);
      logger.info({ taskId, name: payload.name }, 'Task created via API');
      sendJson(201, { task });
      return;
    }
    // --- End Tasks API ---

    if (req.method !== 'POST' || url.pathname !== '/chat') {
      sendJson(404, { error: 'Not found' });
      return;
    }

    let body: {
      userId?: string;
      message?: string;
      senderName?: string;
      groupFolder?: string;
    };
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(400, { error: 'Invalid JSON' });
      return;
    }

    const { userId, message, senderName, groupFolder: targetFolder } = body;
    if (!userId || !message) {
      sendJson(400, { error: 'Missing userId or message' });
      return;
    }

    // Find the main group to use as fallback / Atlas context
    const groups = options.registeredGroups();
    const mainEntry = Object.entries(groups).find(([, g]) => g.isMain);
    if (!mainEntry) {
      sendJson(503, { error: 'Atlas unavailable' });
      return;
    }
    const [mainJid, mainGroup] = mainEntry;

    // Route to specialist if groupFolder provided, otherwise Atlas (main)
    const isSpecialist = !!targetFolder && targetFolder !== mainGroup.folder;
    const group: RegisteredGroup = isSpecialist
      ? {
          folder: targetFolder!,
          name: targetFolder!,
          trigger: '',
          added_at: new Date().toISOString(),
          requiresTrigger: false,
          isMain: false,
        }
      : mainGroup;
    const chatJid = isSpecialist ? `${targetFolder}@specialist` : EFATA_WEB_JID;

    const displayName = senderName || userId;
    const sessionId = options.sessions()[group.folder];

    let prompt: string;
    if (isSpecialist) {
      // Specialist chat: no cross-channel injection, just direct message
      prompt = `[${displayName} via Efata Web]: ${message}`;
    } else {
      // Atlas: inject recent messages from all registered chats for full context
      const allGroups = options.registeredGroups();
      const contextParts: string[] = [];
      for (const [jid, g] of Object.entries(allGroups)) {
        const recent = getMessagesSince(jid, '', options.assistantName, 30);
        if (recent.length > 0) {
          const formatted = formatMessages(recent, options.timezone);
          contextParts.push(`[Histórico recente — ${g.name}]:\n${formatted}`);
        }
      }

      // Inject specialist CLAUDE.md summaries so Atlas knows what each specialist knows
      const projectRoot = process.cwd();
      const specialistParts: string[] = [];
      const allTasks = getAllTasks();
      const specialistFolders = [
        ...new Set(
          allTasks
            .filter((t) => t.group_folder !== mainGroup.folder)
            .map((t) => t.group_folder),
        ),
      ];
      for (const folder of specialistFolders) {
        const claudeMd = path.join(projectRoot, 'groups', folder, 'CLAUDE.md');
        if (fs.existsSync(claudeMd)) {
          const content = fs.readFileSync(claudeMd, 'utf-8').trim();
          const taskName =
            allTasks.find((t) => t.group_folder === folder)?.name || folder;
          if (content) {
            specialistParts.push(
              `[Especialista: ${taskName}]:\n${content.slice(0, 800)}`,
            );
          }
        }
      }

      const contextBlock =
        contextParts.length > 0
          ? `${contextParts.join('\n\n')}\n\n[Mensagem atual via Efata Web — ${displayName}]:\n`
          : `[${displayName} via Efata Web]: `;
      const specialistBlock =
        specialistParts.length > 0
          ? `\n\n[Conhecimento dos especialistas]:\n${specialistParts.join('\n\n')}`
          : '';
      prompt = `${contextBlock}${message}${specialistBlock}`;
    }

    // Keep task snapshot fresh so the agent can see scheduled tasks
    const tasks = getAllTasks();
    writeTasksSnapshot(
      group.folder,
      !isSpecialist,
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
      chatJid,
      isMain: !isSpecialist,
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
              .replace(/<execute_bash>[\s\S]*?<\/execute_bash>/g, '')
              .replace(/<read_file>[\s\S]*?<\/read_file>/g, '')
              .replace(/<write_file>[\s\S]*?<\/write_file>/g, '')
              .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
              .replace(/\n{3,}/g, '\n\n')
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
