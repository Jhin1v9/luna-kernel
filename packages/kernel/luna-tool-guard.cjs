/**
 * luna-tool-guard.cjs — Resiliência, Segurança e Validação para Tool Calls
 *
 * Implementa 7 padrões identificados pelo Kimi Web:
 *   1. Retry com backoff (exponential jitter)
 *   2. Circuit breaker (detecta loop de mesma tool)
 *   3. Idempotency keys (evita duplicação)
 *   4. Schema validation (valida JSON de ações)
 *   5. Timeout nas tool calls
 *   6. Checksum de arquivo antes de editar (detecta drift)
 *   7. Checkpoint / Savepoint por step (git stash + apply)
 */

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

// ── Config ──
const RETRY_MAX = 3;
const RETRY_BASE_MS = 300;
const RETRY_MAX_MS = 5000;
const TOOL_TIMEOUT_MS = 30000;       // 30s para shell/read
const SHELL_TIMEOUT_MS = 120000;     // 2min para npm test/build
const CIRCUIT_WINDOW_MS = 60000;     // 1min janela para detectar loop
const CIRCUIT_THRESHOLD = 3;         // 3 calls iguais = loop

// ── 1. Retry com Backoff ──
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function jitter(baseMs, attempt) {
  const exp = Math.min(attempt, 5);
  const delay = Math.min(baseMs * Math.pow(2, exp), RETRY_MAX_MS);
  const jittered = delay * (0.5 + Math.random() * 0.5);
  return Math.floor(jittered);
}

async function withRetry(fn, options = {}) {
  const maxRetries = options.maxRetries || RETRY_MAX;
  const baseMs = options.baseMs || RETRY_BASE_MS;
  const label = options.label || 'tool call';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err.message?.includes('EAGAIN') ||
        err.message?.includes('EBUSY') ||
        err.message?.includes('EMFILE') ||
        err.message?.includes('ENFILE') ||
        err.message?.includes('EACCES') ||
        err.message?.includes('EPERM') ||
        err.message?.includes('lock') ||
        err.message?.includes('temporarily') ||
        err.message?.includes('timeout') ||
        err.code === 'EAGAIN' ||
        err.code === 'EBUSY';

      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }

      const delay = jitter(baseMs, attempt);
      console.log(`[tool-guard] Retry ${attempt + 1}/${maxRetries} for "${label}" in ${delay}ms: ${err.message}`);
      await sleep(delay);
    }
  }
}

// ── 2. Circuit Breaker ──
class CircuitBreaker {
  constructor() {
    this.history = new Map(); // toolSignature -> [{ timestamp, count }]
  }

  _signature(toolName, params) {
    // Normaliza params para comparação
    const normalized = JSON.stringify(params, Object.keys(params || {}).sort());
    return `${toolName}::${normalized}`;
  }

  check(toolName, params) {
    const sig = this._signature(toolName, params);
    const now = Date.now();
    const windowStart = now - CIRCUIT_WINDOW_MS;

    // Limpar entradas antigas
    if (this.history.has(sig)) {
      const entries = this.history.get(sig).filter(e => e.timestamp > windowStart);
      this.history.set(sig, entries);

      if (entries.length >= CIRCUIT_THRESHOLD) {
        const err = new Error(`Circuit breaker: tool "${toolName}" chamada ${entries.length}x com os mesmos params em ${CIRCUIT_WINDOW_MS / 1000}s. Possível loop do LLM.`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }
  }

  record(toolName, params) {
    const sig = this._signature(toolName, params);
    if (!this.history.has(sig)) this.history.set(sig, []);
    this.history.get(sig).push({ timestamp: Date.now() });
  }

  reset(toolName, params) {
    const sig = this._signature(toolName, params);
    this.history.delete(sig);
  }
}

// ── 3. Idempotency Keys ──
class IdempotencyStore {
  constructor() {
    this.keys = new Set(); // idempotencyKey -> boolean
  }

  generateKey(toolName, params) {
    const hash = crypto.createHash('sha256')
      .update(`${toolName}::${JSON.stringify(params)}`)
      .digest('hex')
      .slice(0, 16);
    return hash;
  }

  isProcessed(key) {
    return this.keys.has(key);
  }

  markProcessed(key) {
    this.keys.add(key);
  }

  clear() {
    this.keys.clear();
  }
}

// ── 4. Schema Validation ──
const TOOL_SCHEMAS = {
  readFile: {
    required: ['path'],
    types: { path: 'string', line_offset: 'number', n_lines: 'number' },
    pathMustExist: true,
  },
  writeFile: {
    required: ['path', 'content'],
    types: { path: 'string', content: 'string' },
    pathMustBeAbsolute: true,
    pathMustNotContain: ['..', '~'],
  },
  replaceInFile: {
    required: ['path', 'old', 'new'],
    types: { path: 'string', old: 'string', new: 'string' },
    pathMustBeAbsolute: true,
  },
  appendFile: {
    required: ['path', 'content'],
    types: { path: 'string', content: 'string' },
  },
  deleteFile: {
    required: ['path'],
    types: { path: 'string' },
  },
  executeShell: {
    required: ['command'],
    types: { command: 'string' },
    forbiddenPatterns: [/^\s*rm\s+-rf\s+\//, /^\s*mkfs/, /^\s*dd\s+if=/, /^\s*:\(\)\{\s*:\|:\s*&\s*\};:/],
  },
  // v3.3: Kimi native tools — schema entries for guard validation
  ipython: {
    required: ['code'],
    types: { code: 'string' },
  },
  browser: {
    required: ['url'],
    types: { url: 'string' },
  },
  computer: {
    required: ['action'],
    types: { action: 'string', x: 'number', y: 'number', text: 'string' },
  },
  glob: {
    required: ['pattern'],
    types: { pattern: 'string' },
  },
  grep: {
    required: ['pattern'],
    types: { pattern: 'string', path: 'string', type: 'string' },
  },
  validateProject: {
    required: ['path'],
    types: { path: 'string' },
    pathMustBeAbsolute: true,
  },
};

function validateToolCall(toolName, params) {
  const schema = TOOL_SCHEMAS[toolName];
  if (!schema) {
    throw new Error(`Schema validation: tool "${toolName}" não existe no schema registry.`);
  }

  // Check required fields
  for (const field of schema.required || []) {
    if (params[field] === undefined || params[field] === null) {
      throw new Error(`Schema validation: campo obrigatório "${field}" faltando em "${toolName}".`);
    }
  }

  // Check types
  for (const [field, expectedType] of Object.entries(schema.types || {})) {
    if (params[field] !== undefined && typeof params[field] !== expectedType) {
      throw new Error(`Schema validation: campo "${field}" deve ser ${expectedType}, recebeu ${typeof params[field]} em "${toolName}".`);
    }
  }

  // Check path constraints
  if (schema.pathMustBeAbsolute && params.path && !path.isAbsolute(params.path)) {
    throw new Error(`Schema validation: path "${params.path}" deve ser absoluto em "${toolName}".`);
  }

  if (schema.pathMustNotContain) {
    for (const forbidden of schema.pathMustNotContain) {
      if (params.path && params.path.includes(forbidden)) {
        throw new Error(`Schema validation: path "${params.path}" contém padrão proibido "${forbidden}" em "${toolName}".`);
      }
    }
  }

  // Check forbidden patterns in shell commands
  if (schema.forbiddenPatterns) {
    for (const pattern of schema.forbiddenPatterns) {
      if (pattern.test(params.command)) {
        throw new Error(`Schema validation: comando proibido detectado em "${toolName}": ${params.command}`);
      }
    }
  }

  return true;
}

// ── 4b. Python Sandbox (AST-light import deny-list) ──
// v3.4: os/pathlib/sys are allowed — ipython runs on the user's REAL PC,
// and the prompt explicitly tells Kimi Web that os/pathlib are fine.
// v5.3: TRAVAS DE SEGURANÇA REMOVIDAS — DONO ABSOLUTO tem controle total.
// A Luna pode usar subprocess, os, shutil, socket, ctypes, eval, exec, etc.
// PYTHON_FORBIDDEN_IMPORTS = [];
// PYTHON_DANGEROUS_BUILTINS = [];

function validatePythonCode(code) {
  if (!code || typeof code !== 'string') return { ok: false, reason: 'código vazio' };
  // TODAS as restrições removidas — a Luna tem permissão total para executar qualquer código Python.
  return { ok: true };
}

// ── 4c. Destructive Operation Detection ──
const DESTRUCTIVE_PATTERNS = [
  { pattern: /^\s*rm\s+/, message: 'Remoção de arquivo/pasta (rm)' },
  { pattern: /^\s*chmod\s+/, message: 'Alteração de permissões (chmod)' },
  { pattern: /^\s*chown\s+/, message: 'Alteração de propriedade (chown)' },
  { pattern: /^\s*curl\s+.*-F[\s\"\'=]/i, message: 'Upload de arquivo (curl -F)' },
  { pattern: /~\/\.ssh/, message: 'Acesso a ~/.ssh' },
  { pattern: /^\s*mkfs/, message: 'Formatação de disco (mkfs)' },
  { pattern: /^\s*dd\s+if=/, message: 'Escrita de disco raw (dd)' },
  { pattern: /^\s*sudo\s+/, message: 'Escalada de privilégio (sudo)' },
];

function checkDestructivePattern(command) {
  if (!command || typeof command !== 'string') return null;
  for (const { pattern, message } of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) {
      return { destructive: true, message, pattern: pattern.toString() };
    }
  }
  return null;
}

// ── 5. Timeout Wrapper ──
function withTimeout(promise, ms, label = 'operation') {
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout: "${label}" excedeu ${ms}ms`));
    }, ms);
    // Clean up timer if promise resolves first
    promise.finally(() => clearTimeout(timer)).catch(() => {});
  });

  return Promise.race([promise, timeout]);
}

// ── 6. Checksum de Arquivo (Anti-Drift) ──
function computeChecksum(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

class FileChecksumCache {
  constructor() {
    this.cache = new Map(); // path -> { checksum, timestamp }
  }

  record(filePath) {
    const checksum = computeChecksum(filePath);
    if (checksum) {
      this.cache.set(filePath, { checksum, timestamp: Date.now() });
    }
    return checksum;
  }

  verify(filePath) {
    const entry = this.cache.get(filePath);
    if (!entry) return { ok: true, reason: 'no prior checksum' };

    const current = computeChecksum(filePath);
    if (!current) return { ok: false, reason: 'file deleted' };

    if (current !== entry.checksum) {
      return {
        ok: false,
        reason: `drift detectado: checksum mudou de ${entry.checksum} para ${current}`,
        oldChecksum: entry.checksum,
        newChecksum: current,
      };
    }

    return { ok: true, reason: 'checksum match' };
  }

  clear(filePath) {
    this.cache.delete(filePath);
  }
}

// ── 7. Checkpoint / Savepoint por Step ──
class StepCheckpoint {
  constructor(workspacePath) {
    this.workspacePath = workspacePath;
    this.checkpoints = []; // [{ stepIndex, stashRef, timestamp, description }]
  }

  async create(stepIndex, description = '') {
    const stashName = `luna-step-${stepIndex}-${Date.now()}`;
    try {
      const { execSync } = require('child_process');
      execSync(
        `cd "${this.workspacePath}" && git stash push -m "${stashName}" --include-untracked`,
        { encoding: 'utf8', timeout: 10000 }
      );
      this.checkpoints.push({
        stepIndex,
        stashRef: stashName,
        timestamp: Date.now(),
        description,
      });
      return { success: true, stashRef: stashName };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async rollbackTo(stepIndex) {
    const cp = this.checkpoints.find(c => c.stepIndex === stepIndex);
    if (!cp) {
      return { success: false, error: `Checkpoint do step ${stepIndex} não encontrado` };
    }

    try {
      const { execSync } = require('child_process');
      // Pop stash para restaurar estado
      execSync(
        `cd "${this.workspacePath}" && git stash pop stash@{${this.checkpoints.indexOf(cp)}}`,
        { encoding: 'utf8', timeout: 10000 }
      );
      return { success: true, restoredTo: stepIndex };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  async undoLast() {
    if (this.checkpoints.length === 0) {
      return { success: false, error: 'Nenhum checkpoint para desfazer' };
    }
    const last = this.checkpoints[this.checkpoints.length - 1];
    return this.rollbackTo(last.stepIndex);
  }

  list() {
    return this.checkpoints.map((c, i) => ({
      index: i,
      stepIndex: c.stepIndex,
      description: c.description,
      timestamp: new Date(c.timestamp).toISOString(),
    }));
  }
}

// ── Guard Wrapper — Combina TUDO ──
class ToolGuard {
  constructor(workspacePath) {
    this.circuit = new CircuitBreaker();
    this.idempotency = new IdempotencyStore();
    this.checksums = new FileChecksumCache();
    this.checkpoints = new StepCheckpoint(workspacePath);
    this.workspacePath = workspacePath;
  }

  async execute(toolName, params, toolFn, options = {}) {
    const label = `${toolName}(${JSON.stringify(params).slice(0, 80)})`;

    // 4. Schema validation
    validateToolCall(toolName, params);

    // 2. Circuit breaker check
    this.circuit.check(toolName, params);

    // 3. Idempotency check
    const idemKey = this.idempotency.generateKey(toolName, params);
    if (this.idempotency.isProcessed(idemKey) && options.idempotent !== false) {
      console.log(`[tool-guard] Idempotency: skipping duplicate ${label}`);
      return { skipped: true, reason: 'already processed', idempotencyKey: idemKey };
    }

    // 6. Checksum antes de editar
    if (['writeFile', 'replaceInFile', 'appendFile', 'deleteFile'].includes(toolName)) {
      const check = this.checksums.verify(params.path);
      if (!check.ok) {
        const err = new Error(`Drift detectado em "${params.path}": ${check.reason}. O arquivo foi modificado externamente. Abortando para evitar perda de dados.`);
        err.code = 'FILE_DRIFT';
        throw err;
      }
    }

    // 5. Timeout
    const timeoutMs = toolName === 'executeShell' && params.command?.includes('test')
      ? SHELL_TIMEOUT_MS
      : TOOL_TIMEOUT_MS;

    // 1. Retry + execute
    const result = await withRetry(
      () => withTimeout(toolFn(), timeoutMs, label),
      { label }
    );

    // 2. Record circuit
    this.circuit.record(toolName, params);

    // 3. Mark idempotency
    this.idempotency.markProcessed(idemKey);

    // 6. Update checksum após editar
    if (['writeFile', 'replaceInFile', 'appendFile'].includes(toolName)) {
      this.checksums.record(params.path);
    }

    return result;
  }

  recordChecksum(filePath) {
    return this.checksums.record(filePath);
  }

  async checkpoint(stepIndex, description) {
    return this.checkpoints.create(stepIndex, description);
  }

  async rollback(stepIndex) {
    return this.checkpoints.rollbackTo(stepIndex);
  }

  async undo() {
    return this.checkpoints.undoLast();
  }

  listCheckpoints() {
    return this.checkpoints.list();
  }

  reset() {
    this.idempotency.clear();
    this.circuit = new CircuitBreaker();
  }
}

module.exports = {
  ToolGuard,
  CircuitBreaker,
  IdempotencyStore,
  FileChecksumCache,
  StepCheckpoint,
  withRetry,
  withTimeout,
  validateToolCall,
  computeChecksum,
  TOOL_SCHEMAS,
  validatePythonCode,
  checkDestructivePattern,
};
