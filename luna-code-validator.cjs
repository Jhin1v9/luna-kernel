/**
 * luna-code-validator.cjs — Validação de código pós-escrita
 * Detecta erros comuns que a Kimi Web comete ao gerar código:
 *   1. Tags JSX não fechadas
 *   2. Arquivos truncados
 *   3. Imports faltando no App.jsx
 *   4. Build quebrado
 *   5. index.html sem título
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ═══════════════════════════════════════════════════════════════════════════
// 1. JSX BALANCE CHECKER
// ═══════════════════════════════════════════════════════════════════════════

function checkJsxBalanced(content) {
  const errors = [];
  let depth = 0;
  let inString = false;
  let stringChar = null;
  let escape = false;
  let line = 1;
  let col = 1;
  const tagStack = [];

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '\n') { line++; col = 1; } else { col++; }

    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }

    if (inString) {
      if (ch === stringChar) { inString = false; stringChar = null; }
      continue;
    }

    // JS template literal
    if (ch === '`') {
      inString = true; stringChar = '`'; continue;
    }
    // Single/double quotes
    if (ch === "'" || ch === '"') {
      inString = true; stringChar = ch; continue;
    }

    // Comments
    if (ch === '/' && content[i + 1] === '/') {
      // Skip to end of line
      while (i < content.length && content[i] !== '\n') i++;
      line++; col = 1;
      continue;
    }
    if (ch === '/' && content[i + 1] === '*') {
      // Skip to end of block comment
      i += 2;
      while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
        if (content[i] === '\n') line++;
        i++;
      }
      i++; // skip /
      continue;
    }

    // JSX Tags
    if (ch === '<') {
      // Check if it's a JSX expression start like `<div` or `</div>` or `<>`, not generic type annotation or comparison
      // Simple heuristic: next non-space char after < should be [a-zA-Z] or / or >
      const next = content.slice(i + 1).trimStart()[0];
      if (next && (/[a-zA-Z]/.test(next) || next === '/' || next === '>')) {
        // Check if it's a self-closing tag later
        const rest = content.slice(i + 1);
        const tagEnd = rest.indexOf('>');
        if (tagEnd === -1) {
          errors.push(`Tag JSX aberta mas não fechada na linha ${line}, col ${col}`);
          break;
        }
        const tagContent = rest.slice(0, tagEnd);
        const isClosing = tagContent.startsWith('/');
        const isSelfClosing = tagContent.trimEnd().endsWith('/');

        if (isClosing) {
          const tagName = tagContent.slice(1).trim().split(/\s/)[0];
          if (tagStack.length === 0) {
            errors.push(`Tag de fechamento </${tagName}> sem tag de abertura correspondente na linha ${line}`);
          } else {
            const last = tagStack[tagStack.length - 1];
            if (last.name !== tagName) {
              errors.push(`Tag mal aninhada: esperado </${last.name}> mas encontrado </${tagName}> na linha ${line}`);
            }
            tagStack.pop();
          }
          depth--;
        } else if (!isSelfClosing) {
          const tagName = tagContent.trim().split(/\s/)[0];
          tagStack.push({ name: tagName, line });
          depth++;
        }
        // skip to >
        i += tagEnd;
      }
    }
  }

  if (tagStack.length > 0) {
    for (const tag of tagStack) {
      errors.push(`Tag <${tag.name}> aberta na linha ${tag.line} mas nunca fechada`);
    }
  }

  return { balanced: errors.length === 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. TRUNCATION DETECTOR
// ═══════════════════════════════════════════════════════════════════════════

function checkFileTruncated(content, ext) {
  const trimmed = content.trimEnd();
  const errors = [];

  // Heuristic 1: file should not end mid-string
  let inString = false;
  let stringChar = null;
  let escape = false;
  let lastStringLine = 1;
  let line = 1;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\n') line++;
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }

    if (inString) {
      if (ch === stringChar) { inString = false; stringChar = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = true; stringChar = ch; lastStringLine = line;
    }
  }
  if (inString) {
    errors.push(`Arquivo termina com string ${stringChar} aberta na linha ${lastStringLine} (possivelmente truncado)`);
  }

  // Heuristic 2: JS/JSX/TS/TSX files should end with a closing brace, semicolon, or closing tag
  if (['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'].includes(ext)) {
    const lastChar = trimmed.slice(-1);
    const lastFew = trimmed.slice(-20);
    // If it ends with something that looks like it was cut mid-expression
    const badEndings = ['=', '+', '-', '*', '/', '?', ':', ',', '(', '[', '{', '<', '&', '|'];
    if (badEndings.includes(lastChar)) {
      errors.push(`Arquivo termina com caractere suspeito "${lastChar}" na posição final — possivelmente truncado`);
    }
    // If last non-whitespace is an opening brace without closing
    const openCount = (trimmed.match(/\{/g) || []).length;
    const closeCount = (trimmed.match(/\}/g) || []).length;
    if (openCount !== closeCount) {
      errors.push(`Chaves desbalanceadas: ${openCount} abertas, ${closeCount} fechadas`);
    }
    const parenOpen = (trimmed.match(/\(/g) || []).length;
    const parenClose = (trimmed.match(/\)/g) || []).length;
    if (parenOpen !== parenClose) {
      errors.push(`Parênteses desbalanceados: ${parenOpen} abertos, ${parenClose} fechados`);
    }
  }

  // Heuristic 3: CSS files should end with a closing brace
  if (ext === '.css' || ext === '.scss') {
    const lastChar = trimmed.slice(-1);
    if (lastChar !== '}') {
      errors.push(`Arquivo CSS termina com "${lastChar}" em vez de } — possivelmente truncado`);
    }
  }

  // Heuristic 4: HTML files should end with </html> or at least </body>
  if (ext === '.html') {
    const lower = trimmed.toLowerCase();
    if (!lower.endsWith('</html>') && !lower.endsWith('</body>')) {
      errors.push(`Arquivo HTML não termina com </html> ou </body> — possivelmente truncado`);
    }
  }

  // Heuristic 5: Config files (js/json) should be valid
  if (ext === '.json') {
    try { JSON.parse(content); } catch (e) {
      errors.push(`JSON inválido: ${e.message}`);
    }
  }

  return { truncated: errors.length > 0, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. APP.IMPORTS CHECKER
// ═══════════════════════════════════════════════════════════════════════════

function checkAppImports(projectPath) {
  const errors = [];
  const appPath = path.join(projectPath, 'src', 'App.jsx');
  const altAppPath = path.join(projectPath, 'src', 'App.tsx');
  const appFile = fs.existsSync(appPath) ? appPath : fs.existsSync(altAppPath) ? altAppPath : null;

  if (!appFile) {
    errors.push('App.jsx/App.tsx não encontrado');
    return { ok: false, errors };
  }

  const appContent = fs.readFileSync(appFile, 'utf8');
  const componentsDir = path.join(projectPath, 'src', 'components');
  if (!fs.existsSync(componentsDir)) {
    errors.push('Pasta src/components não existe');
    return { ok: false, errors };
  }

  const files = fs.readdirSync(componentsDir);
  const componentNames = files
    .filter(f => f.endsWith('.jsx') || f.endsWith('.tsx') || f.endsWith('.js'))
    .map(f => path.basename(f, path.extname(f)));

  for (const comp of componentNames) {
    if (!appContent.includes(comp)) {
      errors.push(`App.jsx não importa/renderiza o componente: ${comp}`);
    }
  }

  return { ok: errors.length === 0, errors, missing: errors.map(e => e.match(/: (.+)$/)?.[1]).filter(Boolean) };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. BUILD CHECKER
// ═══════════════════════════════════════════════════════════════════════════

function runBuildCheck(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { ok: false, errors: ['package.json não encontrado'], stdout: '', stderr: '' };
  }

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (e) {
    return { ok: false, errors: [`package.json inválido: ${e.message}`], stdout: '', stderr: '' };
  }

  if (!pkg.scripts?.build) {
    return { ok: false, errors: ['package.json não tem script "build"'], stdout: '', stderr: '' };
  }

  // Check node_modules
  if (!fs.existsSync(path.join(projectPath, 'node_modules'))) {
    return { ok: false, errors: ['node_modules não encontrado. Execute npm install primeiro.'], stdout: '', stderr: '' };
  }

  try {
    const stdout = execSync('npm run build', {
      cwd: projectPath,
      encoding: 'utf8',
      timeout: 180000,
      stdio: 'pipe',
    });
    return { ok: true, errors: [], stdout, stderr: '' };
  } catch (e) {
    const stderr = e.stderr || e.stdout || e.message || '';
    const stdout = e.stdout || '';
    // Extract concise error messages
    const lines = (stderr + '\n' + stdout).split('\n');
    const errorLines = lines.filter(l =>
      /error|Error|ERROR|SyntaxError|ReferenceError|TypeError|Cannot find|not found|failed/i.test(l)
    );
    return {
      ok: false,
      errors: errorLines.slice(0, 10),
      stdout,
      stderr: stderr.slice(0, 3000),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. INDEX.HTML CHECKER
// ═══════════════════════════════════════════════════════════════════════════

function checkIndexHtml(projectPath) {
  const htmlPath = path.join(projectPath, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return { ok: false, error: 'index.html não encontrado' };
  }
  const html = fs.readFileSync(htmlPath, 'utf8');
  const titleMatch = html.match(/<title>(.+?)<\/title>/i);
  if (!titleMatch) {
    return { ok: false, error: 'index.html não tem tag <title>' };
  }
  const title = titleMatch[1].trim();
  if (title === 'Vite App' || title === 'React App' || title.includes('portfolio-luna') || title.length < 3) {
    return { ok: false, error: `index.html tem título genérico: "${title}"` };
  }
  return { ok: true, title };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. FULL PROJECT VALIDATION (used by supervisor / health check)
// ═══════════════════════════════════════════════════════════════════════════

function validateProject(projectPath) {
  const report = {
    ok: true,
    projectPath,
    checks: {},
    errors: [],
    warnings: [],
  };

  // Check critical files
  const criticalFiles = [
    'package.json',
    'index.html',
    'src/main.jsx',
    'src/App.jsx',
  ];
  for (const f of criticalFiles) {
    if (!fs.existsSync(path.join(projectPath, f))) {
      report.errors.push(`Arquivo crítico faltando: ${f}`);
    }
  }

  // Validate all JSX/JS files for balance and truncation
  function findFiles(dir, exts) {
    const results = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fp = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
          results.push(...findFiles(fp, exts));
        } else if (entry.isFile() && exts.some(ext => entry.name.endsWith(ext))) {
          results.push(fp);
        }
      }
    } catch {}
    return results;
  }

  const codeFiles = findFiles(projectPath, ['.jsx', '.tsx', '.js', '.ts']);
  for (const file of codeFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const ext = path.extname(file);
    const rel = path.relative(projectPath, file);

    const trunc = checkFileTruncated(content, ext);
    if (trunc.truncated) {
      for (const e of trunc.errors) {
        report.errors.push(`[${rel}] ${e}`);
      }
    }

    if (ext === '.jsx' || ext === '.tsx') {
      const jsx = checkJsxBalanced(content);
      if (!jsx.balanced) {
        for (const e of jsx.errors) {
          report.errors.push(`[${rel}] ${e}`);
        }
      }
    }
  }

  // Check App imports
  const appCheck = checkAppImports(projectPath);
  if (!appCheck.ok) {
    report.errors.push(...appCheck.errors);
  }

  // Check index.html
  const htmlCheck = checkIndexHtml(projectPath);
  if (!htmlCheck.ok) {
    report.warnings.push(htmlCheck.error);
  }

  // Try build
  const buildCheck = runBuildCheck(projectPath);
  if (!buildCheck.ok) {
    report.errors.push(...buildCheck.errors.map(e => `[BUILD] ${e}`));
  }

  report.ok = report.errors.length === 0;
  return report;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  checkJsxBalanced,
  checkFileTruncated,
  checkAppImports,
  runBuildCheck,
  checkIndexHtml,
  validateProject,
};
