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
  // Dashboard
  dashboardCreateTask,
  dashboardListTasks,
  dashboardCreateLead,
  dashboardListLeads,
  dashboardGetFinanceSummary,
  dashboardCreateIdea,
  dashboardListIdeas,
  // System
  getCurrentDirectory,
  // Project Validation
  validateProject: (projectPath) => {
    const { validateProject } = require('./luna-code-validator.cjs');
    return validateProject(projectPath);
  },
};
