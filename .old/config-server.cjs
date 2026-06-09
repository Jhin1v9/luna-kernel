#!/usr/bin/env node
/**
 * Luna Kernel Config + Chat Server
 * Serves static files + REST API + SSE streaming
 * Integrates Luna Soul for AI processing
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// Load .env manually (no dotenv dependency) — MUST be before any luna-tools require
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  });
}

const PORT = process.env.LUNA_CONFIG_PORT || 3458;
const LUNA_DIR = path.dirname(__filename);
const ENV_PATH = path.join(LUNA_DIR, '.env');
const SOUL_PATH = path.join(LUNA_DIR, 'luna-soul.cjs');
const RUNTIME_PATH = path.join(LUNA_DIR, '.luna-runtime.json');
const USERS_FILE = path.join(__dirname, '..', 'NEXO_DASHBOARD_PRO', 'backend', 'data', 'users.json');
const JWT_SECRET = process.env.JWT_SECRET || 'nexo-test-secret-2026';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h';

// ============================================================
// Skill validation
// ============================================================
function validateSkillPath(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') {
    return { valid: false, error: 'Caminho do skill não fornecido' };
  }

  const home = os.homedir();
  let resolved;
  try {
    resolved = path.resolve(rawPath.startsWith('~') ? rawPath.replace(/^~/, home) : rawPath);
  } catch (e) {
    return { valid: false, error: `Caminho inválido: ${e.message}` };
  }

  if (!resolved.startsWith(home)) {
    return { valid: false, error: 'Caminho fora do diretório home do usuário' };
  }

  const skillFile = path.join(resolved, 'SKILL.md');
  if (!fs.existsSync(skillFile)) {
    return { valid: false, error: `SKILL.md não encontrado em ${resolved}` };
  }

  let content;
  try {
    content = fs.readFileSync(skillFile, 'utf8');
  } catch (e) {
    return { valid: false, error: `Erro ao ler SKILL.md: ${e.message}` };
  }

  const frontMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontMatch) {
    return { valid: false, error: 'Frontmatter YAML não encontrado em SKILL.md' };
  }

  const yaml = frontMatch[1];
  const meta = {};
  for (const line of yaml.split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) {
      const val = rest.join(':').trim();
      try { meta[key.trim()] = JSON.parse(val); } catch { meta[key.trim()] = val; }
    }
  }

  if (!meta.name || typeof meta.name !== 'string') {
    return { valid: false, error: 'Campo "name" é obrigatório no frontmatter' };
  }
  if (!meta.description || typeof meta.description !== 'string') {
    return { valid: false, error: 'Campo "description" é obrigatório no frontmatter' };
  }

  const body = content.slice(frontMatch[0].length).trim();
  if (!body) {
    return { valid: false, error: 'Corpo Markdown do skill não pode estar vazio' };
  }

  return {
    valid: true,
    path: resolved,
    skill: {
      name: meta.name,
      description: meta.description,
      triggers: Array.isArray(meta.triggers) ? meta.triggers : (meta.triggers ? [meta.triggers] : []),
      tier: meta.tier || 'user-global',
      version: meta.version || '',
      author: meta.author || '',
    },
  };
}

// Write runtime config so frontend dev server can discover our port
fs.writeFileSync(RUNTIME_PATH, JSON.stringify({ apiPort: PORT, apiUrl: `http://localhost:${PORT}` }));


// ============================================================
// Luna Soul lazy initialization
// ============================================================
let lunaSoul = null;
let lunaReady = false;

async function getLunaSoul() {
  if (lunaSoul && lunaReady) return lunaSoul;
  
  try {
    const { LunaSoul } = require('./luna-soul.cjs');
    lunaSoul = new LunaSoul({});
    await lunaSoul.init();
    lunaReady = true;
    console.log('🧠 Luna Soul inicializado para web chat');
    return lunaSoul;
  } catch (e) {
    console.error('❌ Erro ao inicializar Luna Soul:', e.message);
    throw e;
  }
}

// ============================================================
// Web Chat Sessions
// ============================================================
const webSessions = new Map(); // sessionId -> { id, title, messages, createdAt, updatedAt }
const activeStreams = new Map(); // sessionId -> { controller, cancelled }
const sseConnections = new Map(); // sessionId -> Set of {res, keepAlive, checkInterval}

function createWebSession(title = 'Nova conversa', mode = 'thinking') {
  const id = 'web-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  const session = {
    id,
    title,
    mode,
    messages: [],
    activeSkills: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  webSessions.set(id, session);
  return session;
}

function getWebSession(id) {
  return webSessions.get(id);
}

function deleteWebSession(id) {
  // Cancel any active stream
  const stream = activeStreams.get(id);
  if (stream) {
    stream.cancelled = true;
    activeStreams.delete(id);
  }
  return webSessions.delete(id);
}

function renameWebSession(id, title) {
  const session = webSessions.get(id);
  if (session) {
    session.title = title;
    session.updatedAt = new Date().toISOString();
    return true;
  }
  return false;
}

function addMessageToSession(sessionId, message) {
  const session = webSessions.get(sessionId);
  if (session) {
    session.messages.push(message);
    session.updatedAt = new Date().toISOString();
  }
}

// ============================================================
// CORS + JSON + SSE helpers
// ============================================================
function sendJSON(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJSON(res, status, { ok: false, error: message });
}

function parseBody(req, cb) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try { cb(JSON.parse(body)); }
    catch (e) { cb(null); }
  });
}

function sendSSE(res, event, data) {
  res.write(`event: message\n`);
  res.write(`data: ${JSON.stringify({ ...data, type: event })}\n\n`);
  if (res.flush) res.flush();
  if (res.socket && res.socket.setNoDelay) res.socket.setNoDelay(true);
}

// ============================================================
// .env I/O
// ============================================================
function readEnv() {
  const env = {};
  if (fs.existsSync(ENV_PATH)) {
    const content = fs.readFileSync(ENV_PATH, 'utf-8');
    content.split('\n').forEach(line => {
      const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (match) env[match[1]] = match[2];
    });
  }
  return env;
}

function writeEnv(env) {
  let content = '# Luna Kernel v4.0 — Environment Configuration\n';
  content += '# Generated by Luna Config Panel\n';
  content += '# NEXO DIGITAL S.L.\n\n';
  content += '# ── REQUIRED ──\n\n';
  const required = ['TELEGRAM_BOT_TOKEN', 'INTERNAL_API_TOKEN'];
  const optional = [
    'KIMI_TIMEOUT', 'KIMI_MAX_PAGES', 'KIMI_IDLE_TIMEOUT',
    'KIMI_COOLDOWN_MS', 'KIMI_MAX_TYPE_LENGTH', 'KIMI_LOG_MAX_MB',
    'LUNA_COMPACT_THRESHOLD', 'LUNA_COMPACT_TOKEN_THRESHOLD',
    'LUNA_CHROME_PATH', 'LUNA_DEBUG'
  ];

  required.forEach(key => {
    if (env[key]) content += `${key}=${env[key]}\n`;
  });

  content += '\n# ── OPTIONAL ──\n\n';
  optional.forEach(key => {
    if (env[key] !== undefined && env[key] !== '') {
      content += `${key}=${env[key]}\n`;
    }
  });

  fs.writeFileSync(ENV_PATH, content, 'utf-8');
  return true;
}

// ============================================================
// System Prompt I/O
// ============================================================
function readSystemPrompt() {
  if (!fs.existsSync(SOUL_PATH)) return { found: false, content: '' };
  const content = fs.readFileSync(SOUL_PATH, 'utf-8');
  const match = content.match(/function buildSystemPrompt\(opts = \{\}\) \{[\s\S]*?return `([\s\S]*?)`;\s*\}\s*\/\/\s*==+\s*\/\/\s*JSON PARSER/);
  if (match) {
    return { found: true, content: match[1] };
  }
  const match2 = content.match(/function buildSystemPrompt\([\s\S]*?return `([\s\S]*?)`;\s*\}\s*const/);
  if (match2) {
    return { found: true, content: match2[1] };
  }
  return { found: false, content: '' };
}

function writeSystemPrompt(newPrompt) {
  if (!fs.existsSync(SOUL_PATH)) return false;
  let content = fs.readFileSync(SOUL_PATH, 'utf-8');

  const pattern = /(function buildSystemPrompt\(opts = \{\}\) \{[\s\S]*?return `)[\s\S]*?(`;\s*\}\s*\/\/\s*==+\s*\/\/\s*JSON PARSER)/;
  if (pattern.test(content)) {
    content = content.replace(pattern, '$1' + newPrompt + '$2');
    fs.writeFileSync(SOUL_PATH, content, 'utf-8');
    return true;
  }

  const pattern2 = /(function buildSystemPrompt\([\s\S]*?return `)[\s\S]*?(`;\s*\}\s*const)/;
  if (pattern2.test(content)) {
    content = content.replace(pattern2, '$1' + newPrompt + '$2');
    fs.writeFileSync(SOUL_PATH, content, 'utf-8');
    return true;
  }

  return false;
}

// ============================================================
// Tests
// ============================================================
async function testTelegram(token) {
  try {
    const https = require('https');
    return new Promise((resolve) => {
      const req = https.get(
        `https://api.telegram.org/bot${token}/getMe`,
        { timeout: 10000 },
        (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.ok) {
                resolve({ ok: true, bot: json.result });
              } else {
                resolve({ ok: false, error: json.description });
              }
            } catch (e) {
              resolve({ ok: false, error: 'Resposta inválida da API' });
            }
          });
        }
      );
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Timeout' }); });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function testNode() {
  try {
    const version = execSync('node -v', { encoding: 'utf-8', timeout: 5000 }).trim();
    const major = parseInt(version.replace('v', '').split('.')[0]);
    return {
      ok: true,
      version,
      sufficient: major >= 20,
      message: major >= 20 ? `Node.js ${version} ✅` : `Node.js ${version} — precisa v20+`
    };
  } catch (e) {
    return { ok: false, error: 'Node.js não encontrado no PATH' };
  }
}

function testChrome() {
  const commands = ['google-chrome', 'chromium-browser', 'chromium', 'google-chrome-stable'];
  for (const cmd of commands) {
    try {
      const version = execSync(`${cmd} --version 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 }).trim();
      return { ok: true, command: cmd, version };
    } catch (e) { /* try next */ }
  }
  return { ok: false, error: 'Chrome/Chromium não encontrado. Instale: sudo apt-get install google-chrome-stable' };
}

// ============================================================
// HTTP Server
// ============================================================
const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    res.end();
    return;
  }

  // ============================================================
  // AUTH API
  // ============================================================
  async function validateCredentials(username, password) {
    try {
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      const user = data.users?.[username.toLowerCase()];
      if (!user) return null;
      const match = await bcrypt.compare(password, user.passwordHash || user.password);
      if (!match) return null;
      return { id: username.toLowerCase(), name: user.name || username, role: user.role || 'User', color: user.color };
    } catch (e) {
      console.error('Auth error:', e.message);
      return null;
    }
  }
  function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  }
  function requireAuth(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    try {
      const token = authHeader.slice(7);
      const decoded = jwt.verify(token, JWT_SECRET);
      const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
      const user = data.users?.[decoded.userId.toLowerCase()];
      if (!user) return null;
      return { id: decoded.userId, name: user.name || decoded.userId, role: user.role || 'User', color: user.color };
    } catch (e) {
      return null;
    }
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    parseBody(req, async (body) => {
      if (!body || !body.username || !body.password) {
        return sendError(res, 400, 'Username e senha obrigatórios');
      }
      const user = await validateCredentials(body.username, body.password);
      if (!user) return sendError(res, 401, 'Credenciais inválidas');
      const token = generateToken(user.id);
      sendJSON(res, 200, { ok: true, token, user });
    });
    return;
  }

  if (pathname === '/api/auth/me' && req.method === 'GET') {
    const user = requireAuth(req);
    if (!user) return sendError(res, 401, 'Não autorizado');
    sendJSON(res, 200, { ok: true, user });
    return;
  }

  // ============================================================
  // CHAT API
  // ============================================================

  // POST /api/chat — send message
  if (pathname === '/api/chat' && req.method === 'POST') {
    parseBody(req, async (body) => {
      if (!body) return sendError(res, 400, 'JSON inválido');
      const { message, sessionId, mode = 'thinking', files } = body;
      if (!message) return sendError(res, 400, 'message obrigatório');

      let session = sessionId ? getWebSession(sessionId) : null;
      if (!session) {
        session = createWebSession(message.slice(0, 40), mode);
      }

      // Check if plan mode is active and awaiting approval
      if (session.planMode === true && session.planStatus === 'awaiting_approval') {
        return sendJSON(res, 423, {
          ok: false,
          error: 'Há um plano aguardando aprovação. Aprove ou rejeite antes de continuar.',
          planStatus: session.planStatus,
          planPath: session.planPath,
        });
      }

      // If plan was approved, clear plan mode and proceed normally
      if (session.planMode === true && session.planStatus === 'approved') {
        session.planMode = false;
        session.planStatus = null;
        session.planContent = null;
        session.planPath = null;
      }

      // Persist mode on session
      session.mode = mode;

      // Add user message
      addMessageToSession(session.id, {
        id: 'msg-' + Date.now(),
        role: 'user',
        type: 'text',
        content: message,
        files: files || [],
        timestamp: new Date().toISOString(),
      });

      // Mark stream as active
      activeStreams.set(session.id, { cancelled: false });

      sendJSON(res, 200, { ok: true, sessionId: session.id, status: 'processing' });

      // Process in background (don't await) — let Luna Soul + Kimi Web AI handle everything
      try {
        const luna = await getLunaSoul();
        const stream = luna.processMessageStream(message, {
          sessionId: session.id,
          userId: 'web-' + session.id,
          mode: ['instant', 'thinking', 'agent', 'swarm'].includes(mode) ? mode : 'thinking',
          activeSkills: session.activeSkills || [],
        });

        for await (const ev of stream) {
          const streamMeta = activeStreams.get(session.id);
          if (!streamMeta || streamMeta.cancelled) break;

          // Store message events (including plan mode events)
          if (['response_delta', 'action_start', 'action_end', 'error', 'done', 'thinking_start', 'thinking_delta',
               'plan_start', 'plan_delta', 'plan_display', 'plan_awaiting_approval', 'plan_approved', 'plan_rejected', 'plan_revised'].includes(ev.type)) {
            // For 'done' events, capture the final parsed response from result
            const doneResponse = ev.type === 'done' ? (ev.result?.response || ev.response) : undefined;
            addMessageToSession(session.id, {
              id: 'ev-' + Date.now(),
              role: 'assistant',
              type: ev.type,
              content: doneResponse || ev.text || ev.fullResponse || ev.plan || ev.message || '',
              fullThinking: ev.fullThinking || undefined,
              plan: ev.plan || undefined,
              planPath: ev.planPath || undefined,
              tool: ev.tool,
              params: ev.params,
              result: ev.result,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (e) {
        console.error('[WEB] Erro no processamento:', e.message);
        addMessageToSession(session.id, {
          id: 'err-' + Date.now(),
          role: 'assistant',
          type: 'error',
          content: e.message,
          timestamp: new Date().toISOString(),
        });
      } finally {
        activeStreams.delete(session.id);
      }
    });
    return;
  }

  // ============================================================
  // PLAN MODE API
  // ============================================================

  // POST /api/plan — start plan mode investigation
  if (pathname === '/api/plan' && req.method === 'POST') {
    parseBody(req, async (body) => {
      if (!body) return sendError(res, 400, 'JSON inválido');
      const { message, sessionId, mode = 'thinking' } = body;
      if (!message) return sendError(res, 400, 'message obrigatório');

      let session = sessionId ? getWebSession(sessionId) : null;
      if (!session) {
        session = createWebSession(message.slice(0, 40), mode);
      }

      session.planMode = true;
      session.planStatus = 'investigating';
      session.mode = mode;

      // Add user message
      addMessageToSession(session.id, {
        id: 'msg-' + Date.now(),
        role: 'user',
        type: 'text',
        content: `[PLAN MODE] ${message}`,
        timestamp: new Date().toISOString(),
      });

      // Mark stream as active
      activeStreams.set(session.id, { cancelled: false });

      sendJSON(res, 200, { ok: true, sessionId: session.id, status: 'planning' });

      // Process plan mode in background
      try {
        const luna = await getLunaSoul();
        const stream = luna.processPlanModeStream(message, {
          sessionId: session.id,
          userId: 'web-' + session.id,
          mode: 'thinking',
        });

        for await (const ev of stream) {
          const streamMeta = activeStreams.get(session.id);
          if (!streamMeta || streamMeta.cancelled) break;

          // Store plan events
          if (['thinking_start', 'thinking_delta', 'plan_start', 'plan_delta', 'plan_display',
               'plan_awaiting_approval', 'error', 'action_start', 'action_end'].includes(ev.type)) {
            addMessageToSession(session.id, {
              id: 'ev-' + Date.now(),
              role: 'assistant',
              type: ev.type,
              content: ev.text || ev.message || ev.plan || '',
              fullThinking: ev.fullThinking || undefined,
              plan: ev.plan || undefined,
              planPath: ev.planPath || undefined,
              tool: ev.tool,
              params: ev.params,
              result: ev.result,
              timestamp: new Date().toISOString(),
            });
          }
        }
      } catch (e) {
        console.error('[WEB] Erro no plan mode:', e.message);
        session.planStatus = 'error';
        addMessageToSession(session.id, {
          id: 'err-' + Date.now(),
          role: 'assistant',
          type: 'error',
          content: e.message,
          timestamp: new Date().toISOString(),
        });
      } finally {
        activeStreams.delete(session.id);
      }
    });
    return;
  }

  // POST /api/plan/approve — approve the plan
  if (pathname === '/api/plan/approve' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body || !body.sessionId) return sendError(res, 400, 'sessionId obrigatório');
      const session = getWebSession(body.sessionId);
      if (!session) return sendError(res, 404, 'Sessão não encontrada');
      if (session.planStatus !== 'awaiting_approval') {
        return sendError(res, 400, 'Não há plano aguardando aprovação');
      }

      session.planStatus = 'approved';
      addMessageToSession(session.id, {
        id: 'plan-approved-' + Date.now(),
        role: 'assistant',
        type: 'plan_approved',
        content: 'Plano aprovado! Iniciando execução...',
        plan: session.planContent,
        planPath: session.planPath,
        timestamp: new Date().toISOString(),
      });

      sendJSON(res, 200, { ok: true, message: 'Plano aprovado', sessionId: session.id });
    });
    return;
  }

  // POST /api/plan/reject — reject the plan
  if (pathname === '/api/plan/reject' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body || !body.sessionId) return sendError(res, 400, 'sessionId obrigatório');
      const session = getWebSession(body.sessionId);
      if (!session) return sendError(res, 404, 'Sessão não encontrada');

      session.planMode = false;
      session.planStatus = 'rejected';
      addMessageToSession(session.id, {
        id: 'plan-rejected-' + Date.now(),
        role: 'assistant',
        type: 'plan_rejected',
        content: 'Plano rejeitado. Investigação encerrada.',
        timestamp: new Date().toISOString(),
      });

      sendJSON(res, 200, { ok: true, message: 'Plano rejeitado', sessionId: session.id });
    });
    return;
  }

  // POST /api/plan/revise — revise the plan
  if (pathname === '/api/plan/revise' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body || !body.sessionId || !body.revisedPlan) {
        return sendError(res, 400, 'sessionId e revisedPlan obrigatórios');
      }
      const session = getWebSession(body.sessionId);
      if (!session) return sendError(res, 404, 'Sessão não encontrada');

      session.planContent = body.revisedPlan;
      session.planStatus = 'awaiting_approval';

      // Save revised plan to file
      try {
        const fs = require('fs');
        const path = require('path');
        const planDir = path.join(process.env.HOME || '/home/jhin', '.luna-kernel', 'plans');
        fs.mkdirSync(planDir, { recursive: true });
        const planPath = path.join(planDir, `${session.id}.md`);
        fs.writeFileSync(planPath, body.revisedPlan, 'utf-8');
        session.planPath = planPath;
      } catch (e) {
        console.error('[WEB] Erro ao salvar plano revisado:', e.message);
      }

      addMessageToSession(session.id, {
        id: 'plan-revised-' + Date.now(),
        role: 'assistant',
        type: 'plan_revised',
        content: 'Plano revisado. Aguardando nova aprovação.',
        plan: body.revisedPlan,
        planPath: session.planPath,
        timestamp: new Date().toISOString(),
      });

      sendJSON(res, 200, { ok: true, message: 'Plano revisado', sessionId: session.id });
    });
    return;
  }

  // GET /api/chat/stream — SSE streaming
  if (pathname === '/api/chat/stream' && req.method === 'GET') {
    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('sessionId obrigatório');
      return;
    }

    // v4.1-fix: Close existing SSE connections for this session to prevent duplicates
    const existingConnections = sseConnections.get(sessionId);
    if (existingConnections) {
      console.log(`[SSE] Closing ${existingConnections.size} existing connection(s) for session ${sessionId}`);
      for (const conn of existingConnections) {
        clearInterval(conn.keepAlive);
        clearInterval(conn.checkInterval);
        try {
          conn.res.end();
        } catch (e) {
          // ignore
        }
      }
      sseConnections.delete(sessionId);
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no',
    });

    // Disable Nagle's algorithm for real-time streaming
    if (res.socket && res.socket.setNoDelay) {
      res.socket.setNoDelay(true);
    }

    // Send connection confirmation
    sendSSE(res, 'connected', { type: 'connected', sessionId });

    // Keep connection alive
    const keepAlive = setInterval(() => {
      res.write(':keepalive\n\n');
    }, 15000);

    // Watch for session messages and stream them
    const session = getWebSession(sessionId);
    let lastMsgIndex = session ? session.messages.length : 0; // v4.1-fix: Start from current position

    const checkInterval = setInterval(() => {
      const currentSession = getWebSession(sessionId);
      if (!currentSession) {
        sendSSE(res, 'error', { type: 'error', message: 'Sessão não encontrada', sessionId });
        clearInterval(checkInterval);
        clearInterval(keepAlive);
        res.end();
        return;
      }

      // Send only NEW messages (not historical) to avoid duplication
      const newMessages = currentSession.messages.slice(lastMsgIndex);
      for (const msg of newMessages) {
        // Convert stored message back to SSE event format
        const eventData = {
          id: msg.id,
          type: msg.type,
          role: msg.role,
          sessionId,
          timestamp: msg.timestamp,
        };
        if (msg.content) eventData.text = msg.content;
        if (msg.content) eventData.fullResponse = msg.content;
        if (msg.content) eventData.response = msg.content;
        if (msg.fullThinking) eventData.fullThinking = msg.fullThinking;
        if (msg.tool) eventData.tool = msg.tool;
        if (msg.params) eventData.params = msg.params;
        if (msg.result) eventData.result = msg.result;
        if (msg.plan) eventData.plan = msg.plan;
        if (msg.planPath) eventData.planPath = msg.planPath;
        if (msg.type === 'error') eventData.error = msg.content;
        // Include user message content for display
        if (msg.role === 'user') {
          eventData.content = msg.content;
          if (msg.files && msg.files.length > 0) eventData.files = msg.files;
        }

        sendSSE(res, msg.type, eventData);
      }
      lastMsgIndex = currentSession.messages.length;
    }, 100);

    // Track this connection
    let connSet = sseConnections.get(sessionId);
    if (!connSet) {
      connSet = new Set();
      sseConnections.set(sessionId, connSet);
    }
    const conn = { res, keepAlive, checkInterval };
    connSet.add(conn);

    req.on('close', () => {
      clearInterval(checkInterval);
      clearInterval(keepAlive);
      connSet.delete(conn);
      if (connSet.size === 0) {
        sseConnections.delete(sessionId);
      }
    });

    return;
  }

  // GET /api/chat/sessions
  if (pathname === '/api/chat/sessions' && req.method === 'GET') {
    const sessions = Array.from(webSessions.values())
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
      .map(s => ({
        id: s.id,
        title: s.title,
        mode: s.mode || 'thinking',
        planMode: s.planMode || false,
        planStatus: s.planStatus || null,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      }));
    sendJSON(res, 200, { ok: true, sessions });
    return;
  }

  // GET /api/chat/session/:id/messages — fetch full message history
  if (pathname.startsWith('/api/chat/session/') && pathname.endsWith('/messages') && req.method === 'GET') {
    const sid = pathname.split('/')[4];
    const session = getWebSession(sid);
    if (!session) {
      sendError(res, 404, 'Sessão não encontrada');
      return;
    }
    sendJSON(res, 200, { ok: true, messages: session.messages });
    return;
  }

  // POST /api/chat/session — create/rename/delete
  if (pathname === '/api/chat/session' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body) return sendError(res, 400, 'JSON inválido');
      const { action, sessionId, title } = body;

      switch (action) {
        case 'create': {
          const session = createWebSession(title || 'Nova conversa');
          sendJSON(res, 200, { ok: true, session: { id: session.id, title: session.title } });
          break;
        }
        case 'rename': {
          if (!sessionId || !title) return sendError(res, 400, 'sessionId e title obrigatórios');
          if (renameWebSession(sessionId, title)) {
            sendJSON(res, 200, { ok: true });
          } else {
            sendError(res, 404, 'Sessão não encontrada');
          }
          break;
        }
        case 'delete': {
          if (!sessionId) return sendError(res, 400, 'sessionId obrigatório');
          if (deleteWebSession(sessionId)) {
            sendJSON(res, 200, { ok: true });
          } else {
            sendError(res, 404, 'Sessão não encontrada');
          }
          break;
        }
        default:
          sendError(res, 400, 'Ação inválida. Use: create, rename, delete');
      }
    });
    return;
  }

  // POST /api/chat/cancel
  if (pathname === '/api/chat/cancel' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body || !body.sessionId) return sendError(res, 400, 'sessionId obrigatório');
      const stream = activeStreams.get(body.sessionId);
      if (stream) {
        stream.cancelled = true;
        activeStreams.delete(body.sessionId);
        sendJSON(res, 200, { ok: true, message: 'Stream cancelado' });
      } else {
        sendJSON(res, 200, { ok: true, message: 'Nenhum stream ativo' });
      }
    });
    return;
  }

  // ============================================================
  // SKILLS API
  // ============================================================

  // GET /api/skills — list all skills
  if (pathname === '/api/skills' && req.method === 'GET') {
    const skillsDir = path.join(os.homedir(), '.luna', 'skills');
    const skills = [];
    try {
      const dirs = fs.readdirSync(skillsDir);
      for (const dir of dirs) {
        const dirPath = path.join(skillsDir, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        const result = validateSkillPath(dirPath);
        if (result.valid) {
          skills.push({ ...result.skill, path: result.path });
        }
      }
    } catch (e) {
      // ignore read errors, return empty list
    }
    sendJSON(res, 200, { ok: true, skills });
    return;
  }

  // POST /api/skills/validate — validate a skill path
  if (pathname === '/api/skills/validate' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body || typeof body.path !== 'string') return sendError(res, 400, 'path obrigatório');
      const result = validateSkillPath(body.path);
      sendJSON(res, 200, result);
    });
    return;
  }

  // GET /api/chat/session/:id/skills — fetch session active skills
  if (pathname.startsWith('/api/chat/session/') && pathname.endsWith('/skills') && req.method === 'GET') {
    const sid = pathname.split('/')[4];
    const session = getWebSession(sid);
    if (!session) return sendError(res, 404, 'Sessão não encontrada');
    sendJSON(res, 200, { ok: true, activeSkills: session.activeSkills || [] });
    return;
  }

  // POST /api/chat/session/:id/skills — update session active skills
  if (pathname.startsWith('/api/chat/session/') && pathname.endsWith('/skills') && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body || !Array.isArray(body.activeSkills)) return sendError(res, 400, 'activeSkills (array) obrigatório');
      const sid = pathname.split('/')[4];
      const session = getWebSession(sid);
      if (!session) return sendError(res, 404, 'Sessão não encontrada');
      const validatedPaths = [];
      for (const rawPath of body.activeSkills) {
        const result = validateSkillPath(rawPath);
        if (result.valid) validatedPaths.push(result.path);
      }
      session.activeSkills = validatedPaths;
      session.updatedAt = new Date().toISOString();
      sendJSON(res, 200, { ok: true, activeSkills: validatedPaths });
    });
    return;
  }

  // ============================================================
  // CONFIG API (existente)
  // ============================================================

  if (pathname === '/api/config' && req.method === 'GET') {
    const env = readEnv();
    const promptResult = readSystemPrompt();
    sendJSON(res, 200, {
      ok: true,
      env,
      systemPrompt: promptResult.content,
      systemPromptFound: promptResult.found,
      paths: { env: ENV_PATH, soul: SOUL_PATH },
    });
    return;
  }

  if (pathname === '/api/config' && req.method === 'POST') {
    parseBody(req, (body) => {
      if (!body) return sendError(res, 400, 'JSON inválido');
      const results = [];
      if (body.env) {
        try { writeEnv(body.env); results.push('env'); }
        catch (e) { return sendError(res, 500, `Erro ao salvar .env: ${e.message}`); }
      }
      if (body.systemPrompt !== undefined) {
        try {
          if (writeSystemPrompt(body.systemPrompt)) results.push('systemPrompt');
          else return sendError(res, 500, 'Não foi possível atualizar o system prompt');
        } catch (e) { return sendError(res, 500, `Erro ao salvar system prompt: ${e.message}`); }
      }
      sendJSON(res, 200, { ok: true, saved: results });
    });
    return;
  }

  if (pathname === '/api/test/telegram' && req.method === 'POST') {
    parseBody(req, async (body) => {
      if (!body || !body.token) return sendError(res, 400, 'Token obrigatório');
      const result = await testTelegram(body.token);
      sendJSON(res, result.ok ? 200 : 400, result);
    });
    return;
  }

  if (pathname === '/api/test/node' && req.method === 'GET') {
    sendJSON(res, 200, testNode());
    return;
  }

  if (pathname === '/api/test/chrome' && req.method === 'GET') {
    sendJSON(res, 200, testChrome());
    return;
  }

  if (pathname === '/api/restart' && req.method === 'POST') {
    parseBody(req, (body) => {
      try {
        let output = '';
        try {
          output = execSync('pm2 restart luna-kernel 2>&1', { encoding: 'utf-8', timeout: 10000 });
        } catch (e) {
          output = 'PM2 não disponível. Reinicie manualmente: node telegram-luna-adapter.cjs';
        }
        sendJSON(res, 200, { ok: true, message: output });
      } catch (e) {
        sendError(res, 500, e.message);
      }
    });
    return;
  }

  // ============================================================
  // Static files — serve built luna-web dist/
  // ============================================================
  let filePath = pathname === '/' ? '/index.html' : pathname;
  
  // First try luna-web/dist/ (built frontend)
  let distPath = path.join(LUNA_DIR, 'luna-web', 'dist', filePath);
  if (!fs.existsSync(distPath)) {
    // Fallback to config.html (legacy)
    distPath = path.join(LUNA_DIR, filePath === '/index.html' ? 'config.html' : filePath);
  }

  // Security
  if (!distPath.startsWith(LUNA_DIR)) {
    return sendError(res, 403, 'Forbidden');
  }

  fs.readFile(distPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') return sendError(res, 404, 'Not found');
      return sendError(res, 500, err.message);
    }
    const ext = path.extname(distPath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`🌙 Luna Config + Chat Server rodando em http://localhost:${PORT}`);
  console.log(`   .env: ${ENV_PATH}`);
  console.log(`   soul: ${SOUL_PATH}`);
  console.log('');
  console.log('   Endpoints:');
  console.log(`   - Chat:    POST /api/chat | GET /api/chat/stream (SSE)`);
  console.log(`   - Sessions: GET /api/chat/sessions | POST /api/chat/session`);
  console.log(`   - Config:  GET/POST /api/config`);
  console.log(`   - Tests:   GET /api/test/* | POST /api/restart`);
  console.log('');
  console.log('   Frontend:');
  console.log(`   - Serves luna-web/dist/ (fallback: config.html)`);
  console.log('');
});
