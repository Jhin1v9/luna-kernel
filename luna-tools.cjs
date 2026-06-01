/**
 * Luna Tools v3.0 — Ferramentas nativas completas
 * Inspirado em: Kimi Code CLI, Claude Code, Gemini CLI, Codex CLI, Astra Agent, Qwen Agent
 *
 * Categorias:
 *   📖 File Ops     → readFile, writeFile, appendFile, replaceInFile, deleteFile, moveFile, copyFile, getFileInfo
 *   📂 Directory     → listFiles, viewDirectory, createDirectory, removeDirectory
 *   🔍 Search       → searchFiles, grep, glob, searchWeb, fetchURL
 *   🖥️ Shell         → executeShell, runTests, checkSyntax, installPackages
 *   🌿 Git           → gitStatus, gitDiff, gitLog, gitCommit
 *   🩹 Patch         → applyPatch
 *   🌐 Network       → downloadFile
 *   📋 Clipboard     → clipboardRead, clipboardWrite
 *   🖼️ Media         → readMediaFile
 *   🧠 Reasoning     → think
 *   ⚙️ System        → getCurrentDirectory
 */

const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const https = require('https');
const http = require('http');

// Load .env from NEXO_DASHBOARD_PRO backend
const ENV_PATH = path.join(require('os').homedir(), 'NEXO_DASHBOARD_PRO', 'backend', '.env');
if (fs.existsSync(ENV_PATH)) {
  fs.readFileSync(ENV_PATH, 'utf8').split('\n').forEach(line => {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function resolvePath(p) {
  if (!p) return process.cwd();
  if (p.startsWith('~/')) return path.join(require('os').homedir(), p.slice(2));
  return path.resolve(p);
}

function ok(result) {
  return { success: true, ...result };
}

function err(message, extra = {}) {
  return { success: false, error: message, ...extra };
}

function safeExec(cmd, opts = {}) {
  try {
    const output = execSync(cmd, {
      encoding: 'utf8',
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeout || 30000,
      maxBuffer: opts.maxBuffer || 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return { success: true, stdout: output, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      success: false,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
      error: e.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. FILE OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

function readFile(filePath, opts = {}) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return err(`Arquivo não encontrado: ${filePath}`);
  try {
    const content = fs.readFileSync(resolved, 'utf8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    let offset = (opts.offset || opts.line_offset || 1) - 1;
    let limit = opts.limit || opts.n_lines || 1000;

    // Support negative offset (read from end)
    if (offset < 0) {
      offset = Math.max(0, totalLines + offset);
    }
    limit = Math.min(limit, totalLines - offset);

    const numbered = lines
      .slice(offset, offset + limit)
      .map((line, i) => `${(offset + i + 1).toString().padStart(4, ' ')} │ ${line}`)
      .join('\n');

    return ok({
      path: resolved,
      content: numbered,
      totalLines,
      linesRead: Math.max(0, limit),
    });
  } catch (e) {
    return err(e.message);
  }
}

function writeFile(filePath, content, opts = {}) {
  const resolved = resolvePath(filePath);
  try {
    const dir = path.dirname(resolved);
    let createdDir = false;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDir = true;
    }
    fs.writeFileSync(resolved, content, 'utf8');
    return ok({
      path: resolved,
      operation: 'write',
      bytes: Buffer.byteLength(content, 'utf8'),
      createdDir: createdDir || undefined,
      message: createdDir ? `PASTA AINDA NAO CRIADA. CRIEI PRIMEIRO: ${dir}` : undefined,
    });
  } catch (e) {
    return err(e.message);
  }
}

function appendFile(filePath, content, opts = {}) {
  const resolved = resolvePath(filePath);
  try {
    const dir = path.dirname(resolved);
    let createdDir = false;
    let createdFile = false;
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      createdDir = true;
    }
    if (!fs.existsSync(resolved)) {
      fs.writeFileSync(resolved, '', 'utf8');
      createdFile = true;
    }
    fs.appendFileSync(resolved, content, 'utf8');
    return ok({
      path: resolved,
      operation: 'append',
      bytes: Buffer.byteLength(content, 'utf8'),
      createdDir: createdDir || undefined,
      createdFile: createdFile || undefined,
      message: createdDir
        ? `PASTA AINDA NAO CRIADA. CRIEI PRIMEIRO: ${dir}`
        : createdFile
          ? `ARQUIVO NAO CRIADO. CRIEI PRIMEIRO PRA DEPOIS ESCREVER: ${resolved}`
          : undefined,
    });
  } catch (e) {
    return err(e.message);
  }
}

function replaceInFile(filePath, oldStr, newStr, opts = {}) {
  const resolved = resolvePath(filePath);
  let createdFile = false;

  if (!fs.existsSync(resolved)) {
    // FALLBACK: arquivo não existe — cria primeiro
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, '', 'utf8');
    createdFile = true;
  }

  try {
    let content = fs.readFileSync(resolved, 'utf8');

    // Support array of edits
    const edits = opts.edit ? (Array.isArray(opts.edit) ? opts.edit : [opts.edit]) : [];
    if (edits.length > 0) {
      for (const edit of edits) {
        const oldS = edit.old || edit.oldStr;
        const newS = edit.new || edit.newStr;
        if (!oldS) continue;
        content = content.split(oldS).join(newS);
      }
      fs.writeFileSync(resolved, content, 'utf8');
      return ok({
        path: resolved,
        editsApplied: edits.length,
        createdFile: createdFile || undefined,
        message: createdFile ? `ARQUIVO NAO CRIADO. CRIEI PRIMEIRO PRA DEPOIS ESCREVER: ${resolved}` : undefined,
      });
    }

    // Single edit
    const target = oldStr || opts.old || opts.oldStr;
    const replacement = newStr || opts.new || opts.newStr;
    if (!target) return err('oldStr é obrigatório');

    const occurrences = content.split(target).length - 1;
    if (occurrences === 0) return err(`String não encontrada em ${filePath}`);
    if (!opts.replaceAll && occurrences > 1) {
      return err(`Múltiplas ocorrências (${occurrences}). Use replaceAll=true.`, { occurrences });
    }
    content = content.split(target).join(replacement);
    fs.writeFileSync(resolved, content, 'utf8');
    return ok({
      path: resolved,
      occurrences,
      createdFile: createdFile || undefined,
      message: createdFile ? `ARQUIVO NAO CRIADO. CRIEI PRIMEIRO PRA DEPOIS ESCREVER: ${resolved}` : undefined,
    });
  } catch (e) {
    return err(e.message);
  }
}

function executeScript(code, opts = {}) {
  if (!code || typeof code !== 'string') return err('Código do script é obrigatório');

  const language = opts.language || opts.lang || 'bash';
  const cwd = opts.cwd ? resolvePath(opts.cwd) : process.cwd();
  const timeout = opts.timeout || 120000;

  // Mapeia linguagem para extensão e executor
  const langMap = {
    bash: { ext: 'sh', executor: 'bash', shell: true },
    sh: { ext: 'sh', executor: 'bash', shell: true },
    shell: { ext: 'sh', executor: 'bash', shell: true },
    powershell: { ext: 'ps1', executor: 'pwsh', shell: true },
    ps1: { ext: 'ps1', executor: 'pwsh', shell: true },
    python: { ext: 'py', executor: 'python3', shell: true },
    py: { ext: 'py', executor: 'python3', shell: true },
    node: { ext: 'js', executor: 'node', shell: true },
    js: { ext: 'js', executor: 'node', shell: true },
    javascript: { ext: 'js', executor: 'node', shell: true },
  };

  const config = langMap[language.toLowerCase()];
  if (!config) return err(`Linguagem não suportada: ${language}. Use: bash, python, node, powershell`);

  const scriptPath = path.join('/tmp', `luna-script-${Date.now()}.${config.ext}`);

  try {
    fs.writeFileSync(scriptPath, code, 'utf8');
    fs.chmodSync(scriptPath, 0o755);

    // Executa o script
    const result = safeExec(`${config.executor} "${scriptPath}"`, { cwd, timeout });

    // Limpa arquivo temporário (não bloqueante)
    try { fs.unlinkSync(scriptPath); } catch {}

    return ok({
      language,
      scriptPath,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      exitCode: result.exitCode || 0,
      success: result.exitCode === 0,
      message: result.exitCode === 0
        ? `✅ Script ${language} executado com sucesso`
        : `❌ Script ${language} falhou (exit ${result.exitCode})`,
    });
  } catch (e) {
    try { fs.unlinkSync(scriptPath); } catch {}
    return err(`Falha ao executar script: ${e.message}`);
  }
}

function deleteFile(filePath) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return err(`Arquivo não encontrado: ${filePath}`);
  try {
    fs.unlinkSync(resolved);
    return ok({ path: resolved, operation: 'delete' });
  } catch (e) {
    return err(e.message);
  }
}

function moveFile(source, destination) {
  const src = resolvePath(source);
  const dst = resolvePath(destination);
  if (!fs.existsSync(src)) return err(`Origem não encontrada: ${source}`);
  try {
    const dir = path.dirname(dst);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.renameSync(src, dst);
    return ok({ source: src, destination: dst, operation: 'move' });
  } catch (e) {
    return err(e.message);
  }
}

function copyFile(source, destination) {
  const src = resolvePath(source);
  const dst = resolvePath(destination);
  if (!fs.existsSync(src)) return err(`Origem não encontrada: ${source}`);
  try {
    const dir = path.dirname(dst);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, dst);
    return ok({ source: src, destination: dst, operation: 'copy' });
  } catch (e) {
    return err(e.message);
  }
}

function getFileInfo(filePath) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return err(`Arquivo não encontrado: ${filePath}`);
  try {
    const stat = fs.statSync(resolved);
    return ok({
      path: resolved,
      size: stat.size,
      isDirectory: stat.isDirectory(),
      isFile: stat.isFile(),
      modified: stat.mtime.toISOString(),
      created: stat.birthtime.toISOString(),
      permissions: stat.mode.toString(8).slice(-3),
    });
  } catch (e) {
    return err(e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. DIRECTORY OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

function listFiles(pattern, opts = {}) {
  try {
    let files;
    const cwd = opts.cwd || process.cwd();
    const resolvedPattern = resolvePath(pattern) || '*';

    if (resolvedPattern.includes('*')) {
      // Use glob if pattern has wildcards
      try {
        const { globSync } = require('glob');
        files = globSync(resolvedPattern, {
          cwd,
          dot: opts.dot || false,
          ignore: opts.ignore || ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
          absolute: opts.absolute !== false,
        });
      } catch {
        // Fallback to fs.readdir
        const baseDir = path.dirname(resolvedPattern);
        const all = fs.readdirSync(baseDir).map(f => path.join(baseDir, f));
        files = all;
      }
    } else {
      const dir = fs.existsSync(resolvedPattern) && fs.statSync(resolvedPattern).isDirectory()
        ? resolvedPattern
        : cwd;
      files = fs.readdirSync(dir).map(f => path.join(dir, f));
    }

    const withStats = files.slice(0, opts.limit || 100).map(f => {
      try {
        const stat = fs.statSync(f);
        return { path: f, size: stat.size, isDir: stat.isDirectory(), modified: stat.mtime.toISOString() };
      } catch {
        return { path: f, error: 'Cannot stat' };
      }
    });

    return ok({ pattern: resolvedPattern, count: files.length, files: withStats, truncated: files.length > (opts.limit || 100) });
  } catch (e) {
    return err(e.message);
  }
}

function viewDirectory(dirPath, opts = {}) {
  const resolved = resolvePath(dirPath || '.');
  if (!fs.existsSync(resolved)) return err(`Diretório não encontrado: ${dirPath}`);
  try {
    const maxDepth = opts.depth || 3;
    function buildTree(dir, depth) {
      if (depth > maxDepth) return [];
      const items = fs.readdirSync(dir, { withFileTypes: true });
      return items.map(item => {
        const fullPath = path.join(dir, item.name);
        const prefix = '  '.repeat(depth);
        if (item.isDirectory()) {
          const children = depth < maxDepth ? buildTree(fullPath, depth + 1) : [];
          return { name: item.name, path: fullPath, type: 'dir', prefix: `${prefix}📁 `, children };
        }
        const stat = fs.statSync(fullPath);
        return { name: item.name, path: fullPath, type: 'file', size: stat.size, prefix: `${prefix}📄 ` };
      });
    }
    const tree = buildTree(resolved, 0);
    return ok({ path: resolved, entries: tree, total: fs.readdirSync(resolved).length });
  } catch (e) {
    return err(e.message);
  }
}

function createDirectory(dirPath) {
  const resolved = resolvePath(dirPath);
  try {
    fs.mkdirSync(resolved, { recursive: true });
    return ok({ path: resolved, operation: 'mkdir' });
  } catch (e) {
    return err(e.message);
  }
}

function removeDirectory(dirPath) {
  const resolved = resolvePath(dirPath);
  if (!fs.existsSync(resolved)) return err(`Diretório não encontrado: ${dirPath}`);
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return ok({ path: resolved, operation: 'rmdir' });
  } catch (e) {
    return err(e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. SEARCH
// ═══════════════════════════════════════════════════════════════════════════

function searchFiles(pattern, opts = {}) {
  try {
    const cwd = resolvePath(opts.cwd || opts.path || '.');
    // Prefer ripgrep if available
    const hasRg = (() => { try { execSync('which rg', { stdio: 'ignore' }); return true; } catch { return false; } })();
    let cmd;
    if (hasRg) {
      cmd = `rg -n --color=never -C ${opts.context || opts['-C'] || 2} --glob '!{node_modules/*,.git/*,dist/*,build/*,coverage/*,*.lock,*.log,*.min.*}' ${JSON.stringify(pattern)} ${JSON.stringify(cwd)}`;
    } else {
      cmd = `grep -rn --color=never -C ${opts.context || opts['-C'] || 2} --exclude-dir={node_modules,.git,dist,build,coverage,venv,.venv,__pycache__} --exclude={*.lock,*.log,*.min.*} ${JSON.stringify(pattern)} ${JSON.stringify(cwd)}`;
    }
    const result = safeExec(cmd, { timeout: opts.timeout || 30000 });
    if (!result.success) {
      if (result.exitCode === 1) return ok({ pattern, matches: 0, results: [] });
      return err(result.error || result.stderr);
    }
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    return ok({
      pattern,
      matches: lines.length,
      results: lines.slice(0, opts.limit || opts.head_limit || 100),
      truncated: lines.length > (opts.limit || 100),
    });
  } catch (e) {
    return err(e.message);
  }
}

function grep(pattern, opts = {}) {
  try {
    const cwd = resolvePath(opts.cwd || opts.path || '.');
    const hasRg = (() => { try { execSync('which rg', { stdio: 'ignore' }); return true; } catch { return false; } })();
    let cmd;
    const outputMode = opts.output_mode || 'content';
    const headLimit = opts.head_limit || 100;
    const includeGlob = opts.glob ? `--include=${JSON.stringify(opts.glob)}` : (opts.include ? `--include=${JSON.stringify(opts.include)}` : '');
    if (hasRg) {
      const rgGlob = opts.glob ? `-g ${JSON.stringify(opts.glob)}` : '';
      cmd = `rg -n --color=never ${rgGlob} -C ${opts['-C'] || opts.context || 2} ${JSON.stringify(pattern)} ${JSON.stringify(cwd)}`;
    } else {
      cmd = `grep -rn --color=never ${includeGlob} -C ${opts['-C'] || opts.context || 2} --exclude-dir={node_modules,.git,dist,build} ${JSON.stringify(pattern)} ${JSON.stringify(cwd)}`;
    }
    const result = safeExec(cmd, { timeout: opts.timeout || 30000 });
    if (!result.success) {
      if (result.exitCode === 1) return ok({ pattern, matches: 0, results: [] });
      return err(result.error || result.stderr);
    }
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    return ok({
      pattern,
      matches: lines.length,
      results: lines.slice(0, headLimit),
      truncated: lines.length > headLimit,
    });
  } catch (e) {
    return err(e.message);
  }
}

function glob(pattern, opts = {}) {
  try {
    const cwd = resolvePath(opts.cwd || '.');
    const { globSync } = require('glob');
    const files = globSync(pattern, {
      cwd,
      dot: opts.dot || false,
      ignore: opts.ignore || ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
      absolute: opts.absolute !== false,
    });
    return ok({ pattern, count: files.length, files: files.slice(0, opts.limit || 250) });
  } catch (e) {
    return err(e.message);
  }
}

function searchWeb(query, opts = {}) {
  // Stub — requires API key for real search
  return ok({
    query,
    note: 'SearchWeb requer configuração de API key em ~/.luna/config.json',
    results: [],
  });
}

function fetchURL(url, opts = {}) {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { timeout: opts.timeout || 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location, opts).then(resolve);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(ok({ url, status: res.statusCode, content: data.slice(0, opts.limit || 50000) })));
    });
    req.on('error', (e) => resolve(err(e.message)));
    req.on('timeout', () => { req.destroy(); resolve(err('Timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. SHELL
// ═══════════════════════════════════════════════════════════════════════════

function executeShell(command, opts = {}) {
  try {
    const output = execSync(command, {
      encoding: 'utf8',
      cwd: opts.cwd ? resolvePath(opts.cwd) : process.cwd(),
      timeout: (opts.timeout || 60) * 1000,
      maxBuffer: 1024 * 1024 * 5,
    });
    return ok({ command, stdout: output, stderr: '', exitCode: 0 });
  } catch (e) {
    return {
      success: false,
      command,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      exitCode: e.status || 1,
      error: e.message,
    };
  }
}

function runTests(opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  // User can override with explicit command
  if (opts.command) {
    const result = safeExec(opts.command, { cwd, timeout: (opts.timeout || 120) * 1000 });
    return ok({ framework: 'custom', command: opts.command, ...result });
  }
  // Detect test framework
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  const hasPytest = fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'setup.py')) || fs.existsSync(path.join(cwd, 'pyproject.toml'));
  const hasCargo = fs.existsSync(path.join(cwd, 'Cargo.toml'));
  const hasGo = fs.existsSync(path.join(cwd, 'go.mod'));
  const hasMaven = fs.existsSync(path.join(cwd, 'pom.xml'));
  const hasGradle = fs.existsSync(path.join(cwd, 'build.gradle'));

  let cmd;
  if (hasPackageJson) {
    // Check for yarn/pnpm
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) cmd = 'pnpm test';
    else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) cmd = 'yarn test';
    else cmd = 'npm test';
  }
  else if (hasPytest) cmd = 'pytest -v';
  else if (hasCargo) cmd = 'cargo test';
  else if (hasGo) cmd = 'go test ./...';
  else if (hasMaven) cmd = 'mvn test';
  else if (hasGradle) cmd = 'gradle test';
  else return err('Nenhum framework de teste detectado. Use opts.command para especificar um comando customizado.');

  const result = safeExec(cmd, { cwd, timeout: (opts.timeout || 120) * 1000 });
  return ok({
    framework: hasPackageJson ? (cmd.startsWith('pnpm') ? 'pnpm' : cmd.startsWith('yarn') ? 'yarn' : 'npm') : hasPytest ? 'pytest' : hasCargo ? 'cargo' : hasGo ? 'go' : hasMaven ? 'maven' : 'gradle',
    command: cmd,
    ...result,
  });
}

function checkSyntax(filePath, opts = {}) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return err(`Arquivo não encontrado: ${filePath}`);

  const ext = path.extname(resolved);
  let cmd;
  switch (ext) {
    case '.js': case '.mjs': case '.cjs':
      cmd = `node --check ${JSON.stringify(resolved)}`;
      break;
    case '.ts': case '.tsx':
      cmd = `npx tsc --noEmit ${JSON.stringify(resolved)} 2>/dev/null || echo "TypeScript checker not available"`;
      break;
    case '.py':
      cmd = `python3 -m py_compile ${JSON.stringify(resolved)}`;
      break;
    case '.sh':
      cmd = `bash -n ${JSON.stringify(resolved)}`;
      break;
    case '.json':
      cmd = `node -e "JSON.parse(require('fs').readFileSync(${JSON.stringify(resolved)}))"`;
      break;
    default:
      return ok({ path: resolved, note: `Nenhum checker disponível para extensão ${ext}`, valid: true });
  }

  const result = safeExec(cmd, { timeout: 15000 });
  return ok({
    path: resolved,
    language: ext.slice(1),
    valid: result.success && result.exitCode === 0,
    ...result,
  });
}

function installPackages(packages, opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  const hasRequirements = fs.existsSync(path.join(cwd, 'requirements.txt')) || fs.existsSync(path.join(cwd, 'setup.py'));
  const hasCargo = fs.existsSync(path.join(cwd, 'Cargo.toml'));

  let cmd;
  const pkgList = Array.isArray(packages) ? packages.join(' ') : packages;

  if (hasPackageJson) cmd = `npm install ${pkgList}`;
  else if (hasRequirements) cmd = `pip install ${pkgList}`;
  else if (hasCargo) cmd = `cargo add ${pkgList}`;
  else return err('Nenhum gerenciador de pacotes detectado (npm, pip, cargo)');

  const result = safeExec(cmd, { cwd, timeout: (opts.timeout || 300) * 1000 });
  return ok({ manager: hasPackageJson ? 'npm' : hasRequirements ? 'pip' : 'cargo', packages: pkgList, ...result });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. GIT
// ═══════════════════════════════════════════════════════════════════════════

function gitStatus(opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  const result = safeExec('git status -s', { cwd });
  if (!result.success) return err(result.error || 'Não é um repositório git');
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return ok({
    cwd,
    modified: lines.filter(l => l.startsWith(' M') || l.startsWith('M ')).length,
    untracked: lines.filter(l => l.startsWith('??')).length,
    added: lines.filter(l => l.startsWith('A ')).length,
    deleted: lines.filter(l => l.startsWith(' D') || l.startsWith('D ')).length,
    files: lines,
  });
}

function gitDiff(opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  const cmd = opts.staged ? 'git diff --cached' : 'git diff';
  const result = safeExec(cmd, { cwd });
  if (!result.success) return err(result.error);
  return ok({ cwd, staged: !!opts.staged, diff: result.stdout });
}

function gitLog(opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  const n = opts.n || opts.limit || 10;
  const result = safeExec(`git log --oneline -${n}`, { cwd });
  if (!result.success) return err(result.error);
  const lines = result.stdout.trim().split('\n').filter(Boolean);
  return ok({ cwd, commits: lines.map(l => {
    const hash = l.split(' ')[0];
    const msg = l.slice(hash.length + 1);
    return { hash, message: msg };
  }) });
}

function gitCommit(message, opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  const result = safeExec(`git add -A && git commit -m ${JSON.stringify(message)}`, { cwd });
  return ok({ cwd, message, ...result });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. PATCH / DIFF
// ═══════════════════════════════════════════════════════════════════════════

function applyPatch(patchContent, opts = {}) {
  const cwd = resolvePath(opts.cwd || '.');
  const tmpFile = path.join(require('os').tmpdir(), `luna-patch-${Date.now()}.patch`);
  try {
    fs.writeFileSync(tmpFile, patchContent, 'utf8');

    // Try git apply first
    const gitResult = safeExec(`git apply --check ${JSON.stringify(tmpFile)}`, { cwd });
    if (gitResult.success) {
      const applyResult = safeExec(`git apply ${JSON.stringify(tmpFile)}`, { cwd });
      fs.unlinkSync(tmpFile);
      if (applyResult.success) return ok({ cwd, applied: true, method: 'git apply' });
      return err(applyResult.stderr || 'git apply falhou');
    }

    // Fallback to patch command
    const patchResult = safeExec(`patch -p1 < ${JSON.stringify(tmpFile)}`, { cwd });
    fs.unlinkSync(tmpFile);
    if (patchResult.success) return ok({ cwd, applied: true, method: 'patch' });

    return err(patchResult.stderr || gitResult.stderr || 'Falha ao aplicar patch — verifique se o patch é válido e se está no diretório correto');
  } catch (e) {
    try { fs.unlinkSync(tmpFile); } catch {}
    return err(e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. NETWORK
// ═══════════════════════════════════════════════════════════════════════════

function downloadFile(url, destination, opts = {}) {
  const dst = resolvePath(destination);
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const file = fs.createWriteStream(dst);
    const req = client.get(url, { timeout: opts.timeout || 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        return downloadFile(res.headers.location, destination, opts).then(resolve);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dst);
        return resolve(err(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const stats = fs.statSync(dst);
        resolve(ok({ url, destination: dst, bytes: stats.size }));
      });
    });
    req.on('error', (e) => { file.close(); fs.unlinkSync(dst); resolve(err(e.message)); });
    req.on('timeout', () => { req.destroy(); file.close(); fs.unlinkSync(dst); resolve(err('Timeout')); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. CLIPBOARD
// ═══════════════════════════════════════════════════════════════════════════

function clipboardRead() {
  try {
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
    const text = execSync('xclip -o -selection clipboard 2>/dev/null || xsel -ob 2>/dev/null || wl-paste 2>/dev/null', {
      encoding: 'utf8',
      timeout: 8000,
      stdio: ['pipe', 'pipe', 'ignore'],
      env,
    });
    return ok({ text: text.trim() });
  } catch (e) {
    return err('Clipboard vazio ou ferramenta não disponível (instale xclip/xsel/wl-clipboard)');
  }
}

function clipboardWrite(text) {
  try {
    const env = { ...process.env, DISPLAY: process.env.DISPLAY || ':0' };
    // Try each clipboard tool separately
    // v3.3-fix: xclip without -loops 1 + spawn detached so it persists in clipboard
    const tools = [
      () => {
        const { spawn } = require('child_process');
        const proc = spawn('xclip', ['-selection', 'clipboard'], { env, detached: true });
        proc.stdin.write(text);
        proc.stdin.end();
        proc.unref();
        // Give it a moment to register
        try { execSync('sleep 0.2', { timeout: 1000 }); } catch {}
        return true;
      },
      () => execSync(`printf '%s' ${JSON.stringify(text)} | xsel --clipboard --input`, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], env }),
      () => execSync(`printf '%s' ${JSON.stringify(text)} | wl-copy`, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], env }),
    ];
    for (const tool of tools) {
      try { tool(); return ok({ bytes: Buffer.byteLength(text, 'utf8') }); } catch { continue; }
    }
    return err('Falha ao escrever no clipboard (instale xclip/xsel/wl-clipboard e verifique DISPLAY)');
  } catch (e) {
    return err('Falha ao escrever no clipboard: ' + e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. MEDIA
// ═══════════════════════════════════════════════════════════════════════════

function readMediaFile(filePath) {
  const resolved = resolvePath(filePath);
  if (!fs.existsSync(resolved)) return err(`Arquivo não encontrado: ${filePath}`);
  try {
    const stat = fs.statSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.svg'];
    const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
    const type = imageExts.includes(ext) ? 'image' : videoExts.includes(ext) ? 'video' : 'unknown';
    return ok({
      path: resolved,
      type,
      size: stat.size,
      extension: ext,
      note: type === 'image' ? 'Use ReadFile para descrição textual ou ferramentas de visão' : 'Arquivo de mídia detectado',
    });
  } catch (e) {
    return err(e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. SYSTEM
// ═══════════════════════════════════════════════════════════════════════════

function getCurrentDirectory() {
  return ok({ cwd: process.cwd() });
}

function think(thought) {
  return ok({ thought, note: 'Reasoning recorded. Use this to think step-by-step before taking action.' });
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. DASHBOARD TOOLS (API REST localhost:3456)
// ═══════════════════════════════════════════════════════════════════════════

const DASHBOARD_BASE = 'http://localhost:3456/api';
function getInternalApiToken() {
  return process.env.INTERNAL_API_TOKEN || '';
}

async function dashboardApi(path, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  const token = getInternalApiToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${DASHBOARD_BASE}${path}`, opts);
  if (!res.ok) throw new Error(`Dashboard API ${path}: ${res.status} ${res.statusText}`);
  return res.json();
}

async function dashboardCreateTask(params) {
  const task = await dashboardApi('/tasks', 'POST', {
    title: params.title || 'Sem título',
    description: params.description || '',
    status: params.status || 'pending',
    priority: params.priority || 'medium',
    assignedTo: params.assignee || params.assignedTo || null,
    dueDate: params.dueDate || null,
    source: 'luna-agent'
  });
  return ok({ stdout: `✅ Tarefa criada: ${task.title} (ID: ${task.id})` });
}

async function dashboardListTasks(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.assignee) query.set('assignedTo', params.assignee);
  if (params.priority) query.set('priority', params.priority);
  const data = await dashboardApi(`/tasks?${query.toString()}`);
  const tasks = Array.isArray(data) ? data : (data.tasks || []);
  const lines = tasks.map(t => `- [${t.status}] ${t.title} (P: ${t.priority})`).join('\n');
  return ok({ stdout: `📋 ${tasks.length} tarefa(s):\n${lines || 'Nenhuma tarefa encontrada.'}` });
}

async function dashboardCreateLead(params) {
  const data = await dashboardApi('/internal/leads', 'POST', {
    displayName: params.name || params.displayName || 'Sem nome',
    email: params.email || '',
    phone: params.phone || '',
    source: params.source || 'luna-agent',
    estimatedValue: params.estimatedValue || 0,
    notes: params.notes || '',
    assignedTo: params.assignedTo || null,
    tags: params.tags || []
  });
  const lead = data.lead || data;
  return ok({ stdout: `✅ Lead criado: ${lead.displayName || lead.name} (ID: ${lead.id})` });
}

async function dashboardListLeads(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.assignedTo) query.set('assignedTo', params.assignedTo);
  if (params.search) query.set('search', params.search);
  const data = await dashboardApi(`/leads?${query.toString()}`);
  const leads = data.leads || [];
  const lines = leads.map(l => `- [${l.pipelineStatus || 'new'}] ${l.displayName || l.name} (${l.email || 'sem email'})`).join('\n');
  return ok({ stdout: `📋 ${leads.length} lead(s):\n${lines || 'Nenhum lead encontrado.'}` });
}

async function dashboardGetFinanceSummary(params) {
  const data = await dashboardApi('/finance/summary');
  return ok({ stdout: `💰 Finance Summary:\n- Expected: ${data.totalExpected || 0}\n- Received: ${data.totalReceived || 0}\n- Pending: ${data.totalPending || 0}\n- Overdue: ${data.overduePayments || 0}` });
}

async function dashboardCreateIdea(params) {
  const body = {
    title: params.title || 'Sem título',
    type: params.type || 'brainstorm',
    priority: params.priority || 'media',
    status: params.status || 'rascunho',
    tags: params.tags || [],
    createdBy: 'luna-web',
    createdByName: 'Luna Web'
  };
  if (params.description || params.content) {
    body.content = { blocks: [{ type: 'paragraph', content: params.description || params.content || '' }] };
  }
  const data = await dashboardApi('/ideas', 'POST', body);
  const idea = data.data || data;
  return ok({ stdout: `💡 Ideia criada: "${idea.title || params.title}" (ID: ${idea.id || 'n/a'})` });
}

async function dashboardListIdeas(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.type) query.set('type', params.type);
  if (params.priority) query.set('priority', params.priority);
  if (params.search) query.set('search', params.search);
  if (params.limit) query.set('limit', String(params.limit));
  const data = await dashboardApi(`/ideas?${query.toString()}`);
  const ideas = data.data?.ideas || data.ideas || [];
  const lines = ideas.map(i => `- [${i.status}] ${i.title} (tipo: ${i.type}, prio: ${i.priority})`).join('\n');
  return ok({ stdout: `💡 ${ideas.length} ideia(s):\n${lines || 'Nenhuma ideia encontrada.'}` });
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD TOOLS EXPANSÃO v2.0
// ═══════════════════════════════════════════════════════════════════════════

// ── TAREFAS ──

async function dashboardUpdateTask(params) {
  const id = params.id || params.taskId;
  if (!id) return { error: 'ID da tarefa obrigatório' };
  const body = {};
  if (params.title !== undefined) body.title = params.title;
  if (params.description !== undefined) body.description = params.description;
  if (params.status !== undefined) body.status = params.status;
  if (params.priority !== undefined) body.priority = params.priority;
  if (params.assignedTo !== undefined) body.assignedTo = params.assignedTo;
  if (params.dueDate !== undefined) body.dueDate = params.dueDate;
  await dashboardApi(`/tasks/${id}`, 'PUT', body);
  return ok({ stdout: `✏️ Tarefa ${id} atualizada.` });
}

async function dashboardDeleteTask(params) {
  const id = params.id || params.taskId;
  if (!id) return { error: 'ID da tarefa obrigatório' };
  await dashboardApi(`/tasks/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Tarefa ${id} excluída.` });
}

async function dashboardCompleteTask(params) {
  const id = params.id || params.taskId;
  if (!id) return { error: 'ID da tarefa obrigatório' };
  await dashboardApi(`/tasks/${id}`, 'PUT', { status: 'completed' });
  return ok({ stdout: `✅ Tarefa ${id} marcada como concluída.` });
}

async function dashboardAddComment(params) {
  const id = params.id || params.taskId;
  if (!id) return { error: 'ID da tarefa obrigatório' };
  if (!params.comment && !params.text) return { error: 'Comentário obrigatório' };
  await dashboardApi(`/tasks/${id}/comments`, 'POST', { text: params.comment || params.text });
  return ok({ stdout: `💬 Comentário adicionado à tarefa ${id}.` });
}

// ── LEADS ──

async function dashboardUpdateLead(params) {
  const id = params.id || params.leadId;
  if (!id) return { error: 'ID do lead obrigatório' };
  const body = {};
  if (params.name !== undefined) body.displayName = params.name;
  if (params.email !== undefined) body.email = params.email;
  if (params.phone !== undefined) body.phone = params.phone;
  if (params.status !== undefined) body.pipelineStatus = params.status;
  if (params.estimatedValue !== undefined) body.estimatedValue = params.estimatedValue;
  if (params.assignedTo !== undefined) body.assignedTo = params.assignedTo;
  if (params.notes !== undefined) body.notes = params.notes;
  await dashboardApi(`/leads/${id}`, 'PUT', body);
  return ok({ stdout: `✏️ Lead ${id} atualizado.` });
}

async function dashboardConvertLead(params) {
  const id = params.id || params.leadId;
  if (!id) return { error: 'ID do lead obrigatório' };
  await dashboardApi(`/leads/${id}/convert`, 'POST', {});
  return ok({ stdout: `🔄 Lead ${id} convertido em cliente.` });
}

async function dashboardDeleteLead(params) {
  const id = params.id || params.leadId;
  if (!id) return { error: 'ID do lead obrigatório' };
  await dashboardApi(`/leads/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Lead ${id} excluído.` });
}

// ── FINANCEIRO — RECEITAS / PAGAMENTOS ──

async function dashboardCreatePayment(params) {
  const body = {
    amount: parseFloat(params.amount || params.valor || 0),
    description: params.description || params.descricao || '',
    from: params.from || params.de || params.cliente || '',
    date: params.date || new Date().toISOString().split('T')[0],
    status: params.status || 'pending',
  };
  const data = await dashboardApi('/payments', 'POST', body);
  return ok({ stdout: `💰 Pagamento registrado: €${body.amount} — ${body.description}` });
}

async function dashboardListPayments(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.from) query.set('from', params.from);
  const data = await dashboardApi(`/payments?${query.toString()}`);
  const items = data.payments || data || [];
  const lines = items.map(p => `- ${p.status === 'received' ? '✅' : '⏳'} €${p.amount} — ${p.description} (${p.from || '?'})`).join('\n');
  return ok({ stdout: `💰 ${items.length} pagamento(s):\n${lines || 'Nenhum pagamento.'}` });
}

async function dashboardUpdatePayment(params) {
  const id = params.id || params.paymentId;
  if (!id) return { error: 'ID do pagamento obrigatório' };
  const body = {};
  if (params.amount !== undefined) body.amount = parseFloat(params.amount);
  if (params.description !== undefined) body.description = params.description;
  if (params.status !== undefined) body.status = params.status;
  await dashboardApi(`/payments/${id}`, 'PUT', body);
  return ok({ stdout: `✏️ Pagamento ${id} atualizado.` });
}

async function dashboardDeletePayment(params) {
  const id = params.id || params.paymentId;
  if (!id) return { error: 'ID do pagamento obrigatório' };
  await dashboardApi(`/payments/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Pagamento ${id} excluído.` });
}

async function dashboardReceiveSplit(params) {
  const id = params.id || params.paymentId;
  const personId = params.personId || params.person;
  if (!id || !personId) return { error: 'paymentId e personId obrigatórios' };
  await dashboardApi(`/payments/${id}/split/${personId}/receive`, 'POST', {});
  return ok({ stdout: `💰 Split recebido para ${personId} no pagamento ${id}.` });
}

// ── FINANCEIRO — DESPESAS ──

async function dashboardCreateExpense(params) {
  const body = {
    amount: parseFloat(params.amount || params.valor || 0),
    description: params.description || params.descricao || '',
    category: params.category || params.categoria || 'other',
    to: params.to || params.para || '',
    date: params.date || new Date().toISOString().split('T')[0],
    status: params.status || 'pending',
  };
  if (params.splitAmong) body.splitAmong = params.splitAmong;
  const data = await dashboardApi('/expenses', 'POST', body);
  return ok({ stdout: `📤 Despesa registrada: €${body.amount} — ${body.description}` });
}

async function dashboardListExpenses(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.category) query.set('category', params.category);
  const data = await dashboardApi(`/expenses?${query.toString()}`);
  const items = data.expenses || data || [];
  const lines = items.map(e => `- ${e.status === 'paid' ? '✅' : '⏳'} €${e.amount} — ${e.description} (${e.category || '?'})`).join('\n');
  return ok({ stdout: `📤 ${items.length} despesa(s):\n${lines || 'Nenhuma despesa.'}` });
}

async function dashboardUpdateExpense(params) {
  const id = params.id || params.expenseId;
  if (!id) return { error: 'ID da despesa obrigatório' };
  const body = {};
  if (params.amount !== undefined) body.amount = parseFloat(params.amount);
  if (params.description !== undefined) body.description = params.description;
  if (params.status !== undefined) body.status = params.status;
  if (params.category !== undefined) body.category = params.category;
  await dashboardApi(`/expenses/${id}`, 'PUT', body);
  return ok({ stdout: `✏️ Despesa ${id} atualizada.` });
}

async function dashboardDeleteExpense(params) {
  const id = params.id || params.expenseId;
  if (!id) return { error: 'ID da despesa obrigatório' };
  await dashboardApi(`/expenses/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Despesa ${id} excluída.` });
}

async function dashboardPayExpense(params) {
  const id = params.id || params.expenseId;
  if (!id) return { error: 'ID da despesa obrigatório' };
  await dashboardApi(`/expenses/${id}/pay`, 'POST', {});
  return ok({ stdout: `✅ Despesa ${id} marcada como paga.` });
}

async function dashboardCreateExpenseTemplate(params) {
  const body = {
    name: params.name || params.nome || 'Template',
    amount: parseFloat(params.amount || 0),
    description: params.description || '',
    category: params.category || 'other',
  };
  await dashboardApi('/expenses/templates', 'POST', body);
  return ok({ stdout: `📋 Template de despesa "${body.name}" criado.` });
}

async function dashboardQuickExpense(params) {
  const body = {
    amount: parseFloat(params.amount || params.valor || 0),
    description: params.description || params.descricao || '',
    category: params.category || 'other',
  };
  await dashboardApi('/expenses/quick', 'POST', body);
  return ok({ stdout: `⚡ Despesa rápida: €${body.amount} — ${body.description}` });
}

// ── FINANCEIRO — CAIXA ──

async function dashboardGetCashBox(params) {
  const data = await dashboardApi('/cash-box');
  return ok({ stdout: `💵 Caixa: €${data.balance?.value || data.balance || 0}\nÚltima atualização: ${data.lastUpdate || 'N/A'}` });
}

async function dashboardAddCashEntry(params) {
  const body = {
    type: params.type || params.tipo || 'income',
    amount: parseFloat(params.amount || params.valor || 0),
    description: params.description || params.descricao || '',
    category: params.category || 'general',
    date: params.date || new Date().toISOString().split('T')[0],
  };
  await dashboardApi('/cash-box/entries', 'POST', body);
  return ok({ stdout: `💵 Entrada de caixa: €${body.amount} (${body.type}) — ${body.description}` });
}

async function dashboardListCashHistory(params) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  const data = await dashboardApi(`/cash-box/history?${query.toString()}`);
  const items = data.history || data.entries || data || [];
  const lines = items.map(h => `- ${h.type === 'income' ? '📥' : '📤'} €${h.amount} — ${h.description}`).join('\n');
  return ok({ stdout: `💵 Histórico do caixa (${items.length} itens):\n${lines || 'Vazio.'}` });
}

async function dashboardReconcileCashBox(params) {
  const body = { actualBalance: parseFloat(params.actualBalance || params.balance || 0) };
  await dashboardApi('/cash-box/reconcile', 'POST', body);
  return ok({ stdout: `🔍 Caixa reconciliado com saldo real: €${body.actualBalance}` });
}

async function dashboardAdjustCashBox(params) {
  const body = {
    amount: parseFloat(params.amount || params.valor || 0),
    reason: params.reason || params.motivo || 'Ajuste manual',
  };
  await dashboardApi('/cash-box/adjust', 'POST', body);
  return ok({ stdout: `⚖️ Caixa ajustado em €${body.amount}: ${body.reason}` });
}

async function dashboardGetCashBoxProjection(params) {
  const data = await dashboardApi('/cash-box/projection');
  return ok({ stdout: `📈 Projeção do caixa: €${data.projectedBalance || data.balance || 'N/A'}` });
}

async function dashboardCreateCashPayment(params) {
  const body = {
    amount: parseFloat(params.amount || params.valor || 0),
    description: params.description || params.descricao || '',
    from: params.from || params.de || '',
  };
  await dashboardApi('/cash-box/payments', 'POST', body);
  return ok({ stdout: `💰 Pagamento no caixa: €${body.amount} — ${body.description}` });
}

// ── ORÇAMENTOS ──

async function dashboardCreateQuote(params) {
  const body = {
    clientName: params.clientName || params.client || 'Cliente',
    projectName: params.projectName || params.project || 'Projeto',
    totalAmount: parseFloat(params.totalAmount || params.value || params.valor || 0),
    description: params.description || params.descricao || '',
    status: params.status || 'draft',
  };
  await dashboardApi('/quotes', 'POST', body);
  return ok({ stdout: `📄 Orçamento criado: "${body.projectName}" — €${body.totalAmount}` });
}

async function dashboardListQuotes(params) {
  const data = await dashboardApi('/quotes');
  const items = data.quotes || data || [];
  const lines = items.map(q => `- [${q.status}] ${q.projectName || q.clientName} — €${q.totalAmount}`).join('\n');
  return ok({ stdout: `📄 ${items.length} orçamento(s):\n${lines || 'Nenhum orçamento.'}` });
}

async function dashboardUpdateQuote(params) {
  const id = params.id || params.quoteId;
  if (!id) return { error: 'ID do orçamento obrigatório' };
  const body = {};
  if (params.totalAmount !== undefined) body.totalAmount = parseFloat(params.totalAmount);
  if (params.status !== undefined) body.status = params.status;
  if (params.description !== undefined) body.description = params.description;
  await dashboardApi(`/quotes/${id}`, 'PUT', body);
  return ok({ stdout: `✏️ Orçamento ${id} atualizado.` });
}

async function dashboardDeleteQuote(params) {
  const id = params.id || params.quoteId;
  if (!id) return { error: 'ID do orçamento obrigatório' };
  await dashboardApi(`/quotes/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Orçamento ${id} excluído.` });
}

// ── PROJETOS ──

async function dashboardListProjects(params) {
  const data = await dashboardApi('/projects');
  const items = data.projects || data || [];
  const lines = items.map(p => `- ${p.name || p.title} (${p.status || '?'})`).join('\n');
  return ok({ stdout: `📁 ${items.length} projeto(s):\n${lines || 'Nenhum projeto.'}` });
}

// ── CLIENTES ──

async function dashboardListClients(params) {
  const data = await dashboardApi('/schema/clients');
  const items = data.clients || data || [];
  const lines = items.map(c => `- ${c.displayName || c.name || c.id}`).join('\n');
  return ok({ stdout: `👥 ${items.length} cliente(s):\n${lines || 'Nenhum cliente.'}` });
}

// ── LINKS ──

async function dashboardAddLink(params) {
  const body = {
    url: params.url || params.link || '',
    title: params.title || '',
    description: params.description || params.contexto || '',
    tags: params.tags || [],
  };
  if (!body.url) return { error: 'URL obrigatória' };
  await dashboardApi('/links', 'POST', body);
  return ok({ stdout: `🔗 Link adicionado: ${body.url}` });
}

async function dashboardListLinks(params) {
  const query = new URLSearchParams();
  if (params.platform) query.set('platform', params.platform);
  if (params.search) query.set('search', params.search);
  const data = await dashboardApi(`/links?${query.toString()}`);
  const items = data.links || data || [];
  const lines = items.map(l => `- ${l.title || l.url} (${l.platform || 'link'})`).join('\n');
  return ok({ stdout: `🔗 ${items.length} link(s):\n${lines || 'Nenhum link.'}` });
}

async function dashboardDeleteLink(params) {
  const id = params.id || params.linkId;
  if (!id) return { error: 'ID do link obrigatório' };
  await dashboardApi(`/links/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Link ${id} excluído.` });
}

async function dashboardEnrichLink(params) {
  const id = params.id || params.linkId;
  if (!id) return { error: 'ID do link obrigatório' };
  await dashboardApi('/links/enrich', 'POST', { id });
  return ok({ stdout: `✨ Link ${id} enriquecido.` });
}

async function dashboardSyncLinks(params) {
  await dashboardApi('/links/sync', 'POST', {});
  return ok({ stdout: `🔄 Links sincronizados.` });
}

async function dashboardGetLinksStats(params) {
  const data = await dashboardApi('/links/stats');
  return ok({ stdout: `🔗 Stats: ${data.total || 0} total, ${data.broken || 0} quebrados.` });
}

// ── EMAIL ──

async function dashboardSendEmail(params) {
  const body = {
    to: params.to || params.para || '',
    subject: params.subject || params.assunto || '',
    body: params.body || params.text || params.mensagem || '',
    cc: params.cc || '',
    bcc: params.bcc || '',
  };
  if (!body.to || !body.subject) return { error: 'Destinatário e assunto obrigatórios' };
  await dashboardApi('/emails/send', 'POST', body);
  return ok({ stdout: `📧 Email enviado para ${body.to}: "${body.subject}"` });
}

async function dashboardListEmails(params) {
  const query = new URLSearchParams();
  if (params.folder) query.set('folder', params.folder);
  if (params.limit) query.set('limit', String(params.limit));
  const data = await dashboardApi(`/emails?${query.toString()}`);
  const items = data.emails || data.messages || data || [];
  const lines = items.map(e => `- ${e.read ? '✓' : '○'} ${e.subject} (${e.from || '?'})`).join('\n');
  return ok({ stdout: `📧 ${items.length} email(s):\n${lines || 'Nenhum email.'}` });
}

async function dashboardSyncEmails(params) {
  await dashboardApi('/emails/sync', 'POST', {});
  return ok({ stdout: `🔄 Emails sincronizados.` });
}

// ── WHATSAPP ──

async function dashboardSendWhatsApp(params) {
  const body = {
    phone: params.phone || params.number || params.numero || '',
    message: params.message || params.text || params.mensagem || '',
  };
  if (!body.phone || !body.message) return { error: 'Número e mensagem obrigatórios' };
  await dashboardApi('/whatsapp/send', 'POST', body);
  return ok({ stdout: `💬 WhatsApp enviado para ${body.phone}.` });
}

async function dashboardGetWhatsAppHistory(params) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit || 10));
  if (params.chatId) query.set('chatId', params.chatId);
  const data = await dashboardApi(`/whatsapp/history?${query.toString()}`);
  const items = data.history || data.messages || data || [];
  const lines = items.slice(0, 10).map(m => `- [${m.author || '?'}]: ${(m.body || m.text || '(mídia)').slice(0, 80)}`).join('\n');
  return ok({ stdout: `💬 ${items.length} mensagem(s):\n${lines || 'Vazio.'}` });
}

async function dashboardScanWhatsApp(params) {
  await dashboardApi('/whatsapp-agent/refresh', 'POST', {});
  return ok({ stdout: `🔍 Scan do WhatsApp iniciado.` });
}

async function dashboardGetWhatsAppStatus(params) {
  const data = await dashboardApi('/whatsapp-agent/status');
  return ok({ stdout: `📱 WhatsApp: ${data.status || data.state || 'N/A'} | ${data.totalMessages || data.total || 0} msgs` });
}

async function dashboardGetWhatsAppClassifications(params) {
  const data = await dashboardApi('/classifications/stats');
  return ok({ stdout: `🏷️ Classificações: ${JSON.stringify(data, null, 2).slice(0, 400)}` });
}

// ── SISTEMA ──

async function dashboardGetSystemStatus(params) {
  const data = await dashboardApi('/system/status');
  return ok({ stdout: `🖥️ Sistema: ${data.status || 'OK'} | Backend: ${data.backend || '?'} | Frontend: ${data.frontend || '?'}` });
}

async function dashboardGetSystemLogs(params) {
  const query = new URLSearchParams();
  if (params.service) query.set('service', params.service);
  if (params.lines) query.set('lines', String(params.lines));
  const data = await dashboardApi(`/system/logs?${query.toString()}`);
  const lines = (data.logs || data || []).slice(-20).join('\n');
  return ok({ stdout: `📝 Logs:\n${lines || 'Nenhum log.'}` });
}

async function dashboardControlService(params) {
  const body = {
    service: params.service || 'backend',
    action: params.action || params.command || 'status',
  };
  await dashboardApi('/system/control', 'POST', body);
  return ok({ stdout: `⚙️ ${body.service}: ${body.action}` });
}

// ── NOTIFICAÇÕES ──

async function dashboardListNotifications(params) {
  const data = await dashboardApi('/notifications');
  const items = data.notifications || data || [];
  const lines = items.map(n => `- ${n.read ? '✓' : '○'} ${n.title || n.message || 'Notificação'}`).join('\n');
  return ok({ stdout: `🔔 ${items.length} notificação(ões):\n${lines || 'Nenhuma.'}` });
}

async function dashboardMarkNotificationRead(params) {
  const id = params.id || params.notificationId;
  if (!id) return { error: 'ID obrigatório' };
  await dashboardApi(`/notifications/${id}/read`, 'POST', {});
  return ok({ stdout: `✅ Notificação ${id} lida.` });
}

async function dashboardMarkAllNotificationsRead(params) {
  await dashboardApi('/notifications/read-all', 'POST', {});
  return ok({ stdout: `✅ Todas lidas.` });
}

// ── USUÁRIOS / MEMBROS ──

async function dashboardListUsers(params) {
  const data = await dashboardApi('/users');
  const items = data.users || data || [];
  const lines = items.map(u => `- ${u.name || u.username || u.id} (${u.role || 'user'})`).join('\n');
  return ok({ stdout: `👤 ${items.length} usuário(s):\n${lines || 'Nenhum.'}` });
}

async function dashboardListMembers(params) {
  const data = await dashboardApi('/members');
  const items = data.members || data || [];
  const lines = items.map(m => `- ${m.name || m.displayName || m.id} (${m.role || '?'})`).join('\n');
  return ok({ stdout: `👥 ${items.length} membro(s):\n${lines || 'Nenhum.'}` });
}

// ── BUG DETECTOR ──

async function dashboardListBugReports(params) {
  const data = await dashboardApi('/bugdetector/reports');
  const items = data.reports || data || [];
  const lines = items.map(r => `- ${r.filename || r.id}: ${r.summary || r.title || 'Relatório'}`).join('\n');
  return ok({ stdout: `🐛 ${items.length} relatório(s):\n${lines || 'Nenhum.'}` });
}

async function dashboardDeleteBugReport(params) {
  const filename = params.filename || params.id;
  if (!filename) return { error: 'Filename obrigatório' };
  await dashboardApi(`/bugdetector/reports/${filename}`, 'DELETE');
  return ok({ stdout: `🗑️ Relatório ${filename} excluído.` });
}

// ── GITHUB / VERCEL ──

async function dashboardListGitHubRepos(params) {
  const data = await dashboardApi('/github-repos');
  const items = data.repos || data || [];
  const lines = items.map(r => `- ${r.name || r.full_name || r.repo} (${r.language || '?'})`).join('\n');
  return ok({ stdout: `🐙 ${items.length} repo(s):\n${lines || 'Nenhum.'}` });
}

async function dashboardListVercelProjects(params) {
  const data = await dashboardApi('/vercel-projects');
  const items = data.projects || data || [];
  const lines = items.map(p => `- ${p.name || p.project} (${p.framework || '?'})`).join('\n');
  return ok({ stdout: `▲ ${items.length} projeto(s):\n${lines || 'Nenhum.'}` });
}

// ── OPERAÇÕES ──

async function dashboardListOpsAlerts(params) {
  const data = await dashboardApi('/ops');
  const items = data.alerts || data || [];
  const lines = items.map(a => `- [${a.severity || '?'}] ${a.title || a.message || 'Alerta'}`).join('\n');
  return ok({ stdout: `⚠️ ${items.length} alerta(s):\n${lines || 'Nenhum.'}` });
}

async function dashboardCreateOpsAlert(params) {
  const body = {
    title: params.title || 'Novo alerta',
    message: params.message || params.descricao || '',
    severity: params.severity || 'medium',
  };
  await dashboardApi('/ops/alerts', 'POST', body);
  return ok({ stdout: `⚠️ Alerta: "${body.title}"` });
}

async function dashboardDeleteOpsAlert(params) {
  const id = params.id || params.alertId;
  if (!id) return { error: 'ID obrigatório' };
  await dashboardApi(`/ops/alerts/${id}`, 'DELETE');
  return ok({ stdout: `🗑️ Alerta ${id} excluído.` });
}

// ── TRANSAÇÕES / CONFIG / NEXO STATE ──

async function dashboardListTransactions(params) {
  const query = new URLSearchParams();
  if (params.limit) query.set('limit', String(params.limit));
  const data = await dashboardApi(`/transactions?${query.toString()}`);
  const items = data.transactions || data || [];
  const lines = items.map(t => `- ${t.type || '?'} €${t.amount} — ${t.description || ''}`).join('\n');
  return ok({ stdout: `💳 ${items.length} transação(ões):\n${lines || 'Nenhuma.'}` });
}

async function dashboardGetNexoState(params) {
  const data = await dashboardApi('/nexo-state');
  return ok({ stdout: `🌐 NEXO State:\n${JSON.stringify(data, null, 2).slice(0, 500)}` });
}

async function dashboardGetConfig(params) {
  const data = await dashboardApi('/config/dashboard');
  return ok({ stdout: `⚙️ Config:\n${JSON.stringify(data, null, 2).slice(0, 500)}` });
}

// ═══════════════════════════════════════════════════════════════════════════
// VOTING TOOLS
// ═══════════════════════════════════════════════════════════════════════════

async function dashboardListVotingSessions(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.page) query.set('page', String(params.page));
  if (params.limit) query.set('limit', String(params.limit));
  const data = await dashboardApi(`/voting/sessions?${query.toString()}`);
  const sessions = data.sessions || [];
  const lines = sessions.map(s => `- [${s.status}] ${s.title} (tipo: ${s.type}, quorum: ${s.quorumRequired})`).join('\n');
  return ok({ stdout: `🗳️ ${data.pagination?.total || sessions.length} sessão(ões) de votação:\n${lines || 'Nenhuma sessão encontrada.'}` });
}

async function dashboardGetVotingSession(params) {
  const data = await dashboardApi(`/voting/sessions/${params.id}`);
  const votes = data.votes || {};
  const voteLines = Object.entries(votes).map(([k, v]) => `  ${k}: ${v ? v.vote : 'não votou'}`).join('\n');
  return ok({ stdout: `🗳️ Sessão "${data.title}" [${data.status}]\n${data.description || ''}\nVotos:\n${voteLines}` });
}

async function dashboardCreateVotingSession(params) {
  const body = {
    title: params.title,
    description: params.description || '',
    type: params.type || 'generic',
    quorumRequired: params.quorumRequired || 3
  };
  if (params.type === 'tool_action') {
    body.toolName = params.toolName;
    body.toolParams = params.toolParams || {};
  }
  const data = await dashboardApi('/voting/sessions', 'POST', body);
  return ok({ stdout: `🗳️ Sessão de votação criada: "${data.title}" (ID: ${data.id}, quorum: ${data.quorumRequired})` });
}

async function dashboardVoteInSession(params) {
  const data = await dashboardApi(`/voting/sessions/${params.id}/vote`, 'POST', {
    vote: params.vote,
    comment: params.comment || ''
  });
  return ok({ stdout: `🗳️ Voto registrado em "${data.session?.title}": ${params.vote}\nContagem: ${data.tally?.yes || 0} sim, ${data.tally?.no || 0} não` });
}

async function dashboardDeleteVotingSession(params) {
  await dashboardApi(`/voting/sessions/${params.id}`, 'DELETE');
  return ok({ stdout: `🗑️ Sessão de votação deletada (ID: ${params.id})` });
}

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD TOOLS — ROADMAPS & METAS
// ═══════════════════════════════════════════════════════════════════════════

async function dashboardListRoadmaps(params) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.client_id) query.set('client_id', params.client_id);
  if (params.project_type) query.set('project_type', params.project_type);
  const data = await dashboardApi(`/roadmaps?${query.toString()}`);
  const roadmaps = data.roadmaps || [];
  const lines = roadmaps.map(r => {
    const phases = r.phases || [];
    const progress = phases.length ? Math.round((phases.filter(p => p.status === 'completed').length / phases.length) * 100) : 0;
    return `- [${r.status}] ${r.title} (${r.project_type}, ${progress}%) — €${r.total_value || 0}`;
  }).join('\n');
  return ok({ stdout: `🎯 ${roadmaps.length} projeto(s):\n${lines || 'Nenhum projeto encontrado.'}` });
}

async function dashboardGetRoadmap(params) {
  const data = await dashboardApi(`/roadmaps/${params.id}`);
  const phases = data.phases || [];
  const current = data.current_phase_index || 0;
  const phaseLines = phases.map((p, i) => `  ${i + 1}. [${p.status}] ${p.title}${i === current ? ' ← ATUAL' : ''}`).join('\n');
  return ok({ stdout: `🎯 ${data.title} [${data.status}]\nTipo: ${data.project_type}\nValor: €${data.total_value || 0}\nFase atual: ${current + 1}/${phases.length}\n\nFases:\n${phaseLines}` });
}

async function dashboardCreateRoadmap(params) {
  const body = {
    title: params.title,
    client_id: params.clientId || params.client_id || null,
    lead_id: params.leadId || params.lead_id || null,
    project_type: params.projectType || params.project_type || 'website',
    total_value: params.totalValue || params.total_value || 0,
    currency: params.currency || 'EUR',
    start_date: params.startDate || params.start_date || new Date().toISOString().split('T')[0],
    github_repo: params.githubRepo || params.github_repo || null,
    subdomain: params.subdomain || null,
    onboarding_answers: params.onboardingAnswers || params.onboarding_answers || {}
  };
  const data = await dashboardApi('/roadmaps', 'POST', body);
  return ok({ stdout: `🎯 Projeto criado: "${data.title}" (ID: ${data.id}, tipo: ${data.project_type})` });
}

async function dashboardAdvanceRoadmapPhase(params) {
  const data = await dashboardApi(`/roadmaps/${params.id}/advance`, 'POST', { reason: params.reason || 'Avanço de fase' });
  return ok({ stdout: `➡️ Fase avançada! Agora na fase ${data.current_phase_index + 1}` });
}

async function dashboardListProjectTypes(params) {
  const data = await dashboardApi('/roadmaps/project-templates');
  const templates = data.templates || [];
  const lines = templates.map(t => `- ${t.project_type}: ${t.name} (${(t.default_phases || []).length} fases padrão)`).join('\n');
  return ok({ stdout: `📋 ${templates.length} tipo(s) de projeto:\n${lines || 'Nenhum template encontrado.'}` });
}

async function dashboardJoinTimeline(params) {
  const data = await dashboardApi(`/roadmaps/timelines/${params.timelineId}/join`, 'POST');
  return ok({ stdout: `👤 Entrou na timeline. Colaboradores ativos: ${data.collaborators?.length || 0}` });
}

async function dashboardAdvanceTimelineStep(params) {
  const data = await dashboardApi(`/roadmaps/timelines/${params.timelineId}/advance-step`, 'POST');
  return ok({ stdout: `➡️ Step avançado! Timeline: ${data.timeline?.title || params.timelineId}` });
}

async function dashboardCreateReviewVote(params) {
  const body = {
    title: params.title || `Revisão: ${params.phaseTitle || 'Fase'}`,
    description: params.description || '',
    type: 'review',
    quorumRequired: params.quorumRequired || 3,
    linkedTimelineId: params.linkedTimelineId || null,
    linkedRoadmapId: params.linkedRoadmapId || null,
    reviewMeetingAt: params.reviewMeetingAt || null
  };
  const data = await dashboardApi('/voting/sessions', 'POST', body);
  return ok({ stdout: `🗳️ Votação de revisão criada: "${data.title}" (ID: ${data.id})` });
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // File Ops
  readFile,
  writeFile,
  appendFile,
  replaceInFile,
  deleteFile,
  moveFile,
  copyFile,
  getFileInfo,
  // Directory
  listFiles,
  viewDirectory,
  createDirectory,
  removeDirectory,
  // Search
  searchFiles,
  grep,
  glob,
  searchWeb,
  fetchURL,
  // Shell
  executeShell,
  executeScript,
  runTests,
  checkSyntax,
  installPackages,
  // Git
  gitStatus,
  gitDiff,
  gitLog,
  gitCommit,
  // Patch
  applyPatch,
  // Network
  downloadFile,
  // Clipboard
  clipboardRead,
  clipboardWrite,
  // Media
  readMediaFile,
  // Reasoning
  think,
  // Dashboard — Tarefas
  dashboardCreateTask,
  dashboardListTasks,
  dashboardUpdateTask,
  dashboardDeleteTask,
  dashboardCompleteTask,
  dashboardAddComment,
  // Dashboard — Leads
  dashboardCreateLead,
  dashboardListLeads,
  dashboardUpdateLead,
  dashboardConvertLead,
  dashboardDeleteLead,
  // Dashboard — Financeiro Receitas
  dashboardCreatePayment,
  dashboardListPayments,
  dashboardUpdatePayment,
  dashboardDeletePayment,
  dashboardReceiveSplit,
  // Dashboard — Financeiro Despesas
  dashboardCreateExpense,
  dashboardListExpenses,
  dashboardUpdateExpense,
  dashboardDeleteExpense,
  dashboardPayExpense,
  dashboardCreateExpenseTemplate,
  dashboardQuickExpense,
  // Dashboard — Financeiro Caixa
  dashboardGetCashBox,
  dashboardAddCashEntry,
  dashboardListCashHistory,
  dashboardReconcileCashBox,
  dashboardAdjustCashBox,
  dashboardGetCashBoxProjection,
  dashboardCreateCashPayment,
  // Dashboard — Orçamentos
  dashboardCreateQuote,
  dashboardListQuotes,
  dashboardUpdateQuote,
  dashboardDeleteQuote,
  // Dashboard — Projetos
  dashboardListProjects,
  // Dashboard — Clientes
  dashboardListClients,
  // Dashboard — Ideias
  dashboardCreateIdea,
  dashboardListIdeas,
  // Dashboard — Links
  dashboardAddLink,
  dashboardListLinks,
  dashboardDeleteLink,
  dashboardEnrichLink,
  dashboardSyncLinks,
  dashboardGetLinksStats,
  // Dashboard — Email
  dashboardSendEmail,
  dashboardListEmails,
  dashboardSyncEmails,
  // Dashboard — WhatsApp
  dashboardSendWhatsApp,
  dashboardGetWhatsAppHistory,
  dashboardScanWhatsApp,
  dashboardGetWhatsAppStatus,
  dashboardGetWhatsAppClassifications,
  // Dashboard — Sistema
  dashboardGetSystemStatus,
  dashboardGetSystemLogs,
  dashboardControlService,
  // Dashboard — Notificações
  dashboardListNotifications,
  dashboardMarkNotificationRead,
  dashboardMarkAllNotificationsRead,
  // Dashboard — Usuários
  dashboardListUsers,
  dashboardListMembers,
  // Dashboard — BugDetector
  dashboardListBugReports,
  dashboardDeleteBugReport,
  // Dashboard — GitHub/Vercel
  dashboardListGitHubRepos,
  dashboardListVercelProjects,
  // Dashboard — Operações
  dashboardListOpsAlerts,
  dashboardCreateOpsAlert,
  dashboardDeleteOpsAlert,
  // Dashboard — Transações/Config
  dashboardListTransactions,
  dashboardGetNexoState,
  dashboardGetConfig,
  // Dashboard — Finance Summary
  dashboardGetFinanceSummary,
  // Dashboard — Voting
  dashboardListVotingSessions,
  dashboardGetVotingSession,
  dashboardCreateVotingSession,
  dashboardVoteInSession,
  dashboardDeleteVotingSession,
  // Dashboard — Roadmaps & Metas
  dashboardListRoadmaps,
  dashboardGetRoadmap,
  dashboardCreateRoadmap,
  dashboardAdvanceRoadmapPhase,
  dashboardListProjectTypes,
  dashboardJoinTimeline,
  dashboardAdvanceTimelineStep,
  dashboardCreateReviewVote,
  // System
  getCurrentDirectory,
  // Project Validation
  validateProject: (projectPath) => {
    const { validateProject } = require('./luna-code-validator.cjs');
    return validateProject(projectPath);
  },
};
