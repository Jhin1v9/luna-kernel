/**
 * Luna Web Catalog API v1.0 (2026-10-15)
 *
 * Decreto owner: "coloca no catalogo de skills da luna pra quando ela precisar
 * listar as tools mostrar o MESMO catalogo da luna web — editar projetos,
 * criar logins, tudo mais".
 *
 * Expõe por HTTP:
 *   GET  /api/luna-web-catalog          → TOOL INDEX idêntico ao da Luna Web
 *                                          + lista de tools executáveis
 *   POST /api/luna-web-catalog/execute  → { tool, params } executa uma tool
 *                                          business do kernel (mesma função
 *                                          que a luna-soul chama no loop)
 *
 * SEGURANÇA (guardrail explícito): só tools BUSINESS entram no execute —
 * dashboard*, workspace*, whatsapp*, brain*, callRespond.
 * Ferramentas de MÁQUINA (readFile, executeShell, git*, browser, self-update…)
 * NUNCA são expostas por HTTP: shell/pasta pela API do WhatsApp é vetado.
 * Auth: montado com requireSystemAuth no luna-server (INTERNAL_API_TOKEN/JWT).
 */
const express = require('express');
const path = require('path');
const { LUNA_KERNEL_DIR } = require('../lib/resolve-luna.cjs');

const lunaTools = require(path.join(LUNA_KERNEL_DIR, 'luna-tools.cjs'));
const { buildToolIndex } = require(path.join(LUNA_KERNEL_DIR, 'tool-catalog.cjs'));

const router = express.Router();

// ── Allowlist de execução (business only) ─────────────────────────────
const EXEC_PREFIXES = ['dashboard', 'workspace', 'whatsapp', 'brain'];
const EXEC_EXACT = new Set(['callRespond']);
const isExecutable = (n) => EXEC_EXACT.has(n) || EXEC_PREFIXES.some((p) => n.startsWith(p));

// listTools/toolInfo do kernel são meta-tools locais da soul (precisam de
// estado interno) — quem chama de fora usa o GET do catálogo; não expor.
const EXECUTABLE_NAMES = Object.keys(lunaTools).filter(isExecutable);

const EXEC_TIMEOUT_MS = 45_000;

/** Execução com timeout — tool travada não segura a resposta HTTP. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`tool ${label} estourou ${ms / 1000}s`)), ms),
    ),
  ]);
}

// GET /api/luna-web-catalog — o MESMO índice que a Luna Web manda no prompt
router.get('/', (req, res) => {
  try {
    res.json({
      ok: true,
      index: buildToolIndex(),
      executable: EXECUTABLE_NAMES,
      executableCount: EXECUTABLE_NAMES.length,
      hint: 'Execute qualquer tool executável via POST /api/luna-web-catalog/execute {tool, params}.',
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/luna-web-catalog/execute — { tool, params }
router.post('/execute', async (req, res) => {
  try {
    const { tool, params = {} } = req.body || {};
    if (!tool || typeof tool !== 'string') {
      return res.status(400).json({ ok: false, error: 'informe { tool, params }' });
    }
    const fn = lunaTools[tool];
    if (typeof fn !== 'function' || !isExecutable(tool)) {
      return res.status(403).json({
        ok: false,
        error: `tool não executável por esta API: ${tool}`,
        executableCount: EXECUTABLE_NAMES.length,
      });
    }
    const raw = await withTimeout(Promise.resolve(fn(params)), EXEC_TIMEOUT_MS, tool);
    // Contrato uniforme: { ok, result } — result já é { success, stdout|error, ... }
    const result = raw && typeof raw === 'object' ? raw : { success: true, stdout: String(raw) };
    res.json({ ok: result.success !== false, tool, result });
  } catch (e) {
    res.status(500).json({ ok: false, tool: req.body?.tool, error: e.message });
  }
});

module.exports = router;
