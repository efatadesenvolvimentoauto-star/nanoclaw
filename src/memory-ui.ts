/**
 * Memory UI — web interface for viewing and editing Atlas memory files.
 * Run: npm run memory
 * Open: http://localhost:3001
 */
import http from 'http';
import fs from 'fs';
import path from 'path';

const PORT = parseInt(process.env.MEMORY_UI_PORT || '3001', 10);
const GROUPS_DIR = path.resolve(process.cwd(), 'groups');
const GLOBAL_DIR = path.join(GROUPS_DIR, 'global');
const UI_DIR = path.resolve(process.cwd(), 'memory-ui');

function listMemoryFiles() {
  const result: {
    group: string;
    label: string;
    files: { name: string; path: string }[];
  }[] = [];

  const globalFiles = collectMdFiles(GLOBAL_DIR);
  if (globalFiles.length)
    result.push({ group: 'global', label: 'Global', files: globalFiles });

  if (fs.existsSync(GROUPS_DIR)) {
    for (const folder of fs.readdirSync(GROUPS_DIR).sort()) {
      if (folder === 'global') continue;
      const dir = path.join(GROUPS_DIR, folder);
      if (!fs.statSync(dir).isDirectory()) continue;
      const files = collectMdFiles(dir);
      if (files.length) result.push({ group: folder, label: folder, files });
    }
  }
  return result;
}

const RECURSE_DIRS = new Set(['memory', 'members', 'conversations']);

function collectMdFiles(dir: string): { name: string; path: string }[] {
  if (!fs.existsSync(dir)) return [];
  const files: { name: string; path: string }[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push({ name: entry.name, path: path.join(dir, entry.name) });
    } else if (entry.isDirectory() && RECURSE_DIRS.has(entry.name)) {
      const subDir = path.join(dir, entry.name);
      for (const f of fs.readdirSync(subDir, { withFileTypes: true })) {
        if (f.isFile() && f.name.endsWith('.md')) {
          files.push({
            name: `${entry.name}/${f.name}`,
            path: path.join(subDir, f.name),
          });
        }
      }
    }
  }
  return files;
}

function safePath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  return resolved.startsWith(path.resolve(GROUPS_DIR)) ? resolved : null;
}

function json(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url!, `http://localhost:${PORT}`);

  // Serve static UI files
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const filePath = path.join(UI_DIR, file);
    if (fs.existsSync(filePath) && filePath.startsWith(UI_DIR)) {
      const ext = path.extname(filePath);
      const types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'application/javascript',
        '.css': 'text/css',
      };
      res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
      res.end(fs.readFileSync(filePath));
      return;
    }
    res.writeHead(404);
    res.end();
    return;
  }

  // GET /api/files
  if (url.pathname === '/api/files' && req.method === 'GET') {
    json(res, listMemoryFiles());
    return;
  }

  // GET /api/file?path=...
  if (url.pathname === '/api/file' && req.method === 'GET') {
    const p = safePath(url.searchParams.get('path') || '');
    if (!p || !fs.existsSync(p)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const stat = fs.statSync(p);
    json(res, { content: fs.readFileSync(p, 'utf-8'), mtime: stat.mtime });
    return;
  }

  // GET /api/resolve?group=...&name=...
  if (url.pathname === '/api/resolve' && req.method === 'GET') {
    const group = url.searchParams.get('group') || '';
    const name = url.searchParams.get('name') || '';
    const filePath =
      group === 'global'
        ? path.join(GLOBAL_DIR, name)
        : path.join(GROUPS_DIR, group, 'memory', name);
    const safe = safePath(filePath);
    if (!safe) {
      res.writeHead(403);
      res.end();
      return;
    }
    json(res, { path: safe });
    return;
  }

  // POST /api/file
  if (url.pathname === '/api/file' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const { path: fp, content } = JSON.parse(body);
        const safe = safePath(fp);
        if (!safe) {
          res.writeHead(403);
          res.end();
          return;
        }
        fs.mkdirSync(path.dirname(safe), { recursive: true });
        fs.writeFileSync(safe, content, 'utf-8');
        json(res, { ok: true });
      } catch {
        res.writeHead(400);
        res.end();
      }
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🧠  Atlas Memory UI → http://localhost:${PORT}\n`);
});
