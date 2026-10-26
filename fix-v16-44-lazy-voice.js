#!/usr/bin/env node
/* fix-v16-44-lazy-voice.js — whatsplay boot imune a key ausente.
 * FallbackAdapter vira LAZY (Proxy) quando nenhuma API key existe:
 * constroi so no 1o uso real. Com key/modo kimiwork, identico ao antes. */
const fs = require('fs'), path = require('path');
const HOME = process.env.HOME || process.env.USERPROFILE;
const f = path.join(HOME, 'Documents', 'Luna cto', 'luna-agent', 'apps', 'whatsplay', 'src', 'voice', 'call-executor.ts');
if (!fs.existsSync(f)) { console.error('[FAIL] nao achado: ' + f); process.exit(1); }
const src = fs.readFileSync(f, 'utf8');
if (src.includes('v16.44-lazy-voice')) { console.log('[OK] ja aplicado — idempotente'); process.exit(0); }
const crlf = src.includes('\r\n'); const N = crlf ? '\r\n' : '\n';
const bak = f + '.bak-lazyvoice-' + Date.now();
fs.copyFileSync(f, bak);
const lines = src.split(/\r?\n/);
// T1: ramo eager do ternario -> builder lazy
const ti = lines.findIndex(l => l.includes(': new FallbackAdapter('));
if (ti < 0) { console.error('[FAIL] anchor ": new FallbackAdapter(" nao achado'); process.exit(1); }
let end = -1;
for (let k = ti + 1; k < Math.min(ti + 45, lines.length); k++) { if (lines[k].trim() === ');') { end = k; break; } }
if (end < 0) { console.error('[FAIL] fechamento ); do FallbackAdapter nao achado'); process.exit(1); }
const indent = (lines[ti].match(/^\s*/) || [''])[0];
lines.splice(ti, end - ti + 1, indent + ': buildApiLiveAdapter(log),');
// T2: helper antes de createCallExecutor
const ci = lines.findIndex(l => l.includes('export async function createCallExecutor'));
if (ci < 0) { console.error('[FAIL] createCallExecutor nao achado'); process.exit(1); }
const helper = [
  '',
  '// v16.44-lazy-voice (decreto: modo CDP primario, API e so fallback): sem',
  '// nenhuma API key, construir o FallbackAdapter ANSiosamente derrubava o BOOT',
  '// inteiro (pipeline de texto morria junto). Proxy lazy: constroi no 1o uso',
  '// real — ai, sim, sem key = falha EXPLICITA na chamada (nunca no boot).',
  'function buildApiLiveAdapter(log: Logger): KimiLiveAdapter {',
  '  const hasAnyKey = Boolean(',
  '    process.env.LLM_API_KEY || process.env.KIMI_API_KEY ||',
  '    process.env.KIMI_API_KEY_2 || process.env.GEMINI_API_KEY,',
  '  );',
  '  const build = () =>',
  '    new FallbackAdapter(',
  '      {',
  "        mode: 'kimi-api',",
  '        apiKey: process.env.LLM_API_KEY,',
  '        apiBaseUrl: process.env.LLM_BASE_URL,',
  '        apiModel: process.env.LLM_MODEL,',
  '        fallbackApiKey: process.env.GEMINI_API_KEY,',
  '        fallbackBaseUrl: process.env.GEMINI_BASE_URL,',
  '        fallbackModel: process.env.GEMINI_MODEL,',
  '      },',
  '      undefined,',
  '      { onFallback: ({ from, to, reason }) => log.warn({ from, to, reason: reason.slice(0, 160) }, `voice.call: fallback ${from}→${to}`) },',
  '    );',
  '  if (hasAnyKey) return build();',
  "  log.warn('voice.call: nenhuma API key no .env (modo CDP) — FallbackAdapter LAZY: boot livre; chamada de voz sem key falha explicita (use KIMI_ADAPTER_MODE=kimiwork ou KIMIWEB_LOCAL_*)');",
  '  let real: ReturnType<typeof build> | null = null;',
  '  return new Proxy({} as KimiLiveAdapter, {',
  '    get(_t, prop) {',
  "      if (prop === 'then') return undefined; // nao virar thenable",
  '      return (...args: unknown[]) => {',
  '        real ??= build();',
  '        const r = real as unknown as Record<string | symbol, unknown>;',
  '        const v = r[prop];',
  "        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).apply(real, args) : v;",
  '      };',
  '    },',
  '  }) as KimiLiveAdapter;',
  '}',
  '',
];
lines.splice(ci, 0, ...helper);
fs.writeFileSync(f, lines.join(N));
const out = fs.readFileSync(f, 'utf8');
const open = (out.match(/{/g) || []).length, close = (out.match(/}/g) || []).length;
console.log('[CHECK] chaves ' + open + ' abertas vs ' + close + ' fechadas' + (open === close ? ' (ok)' : ' — DIVERGE, restaure o backup!'));
console.log('[OK] v16.44-lazy-voice aplicado (backup: ' + bak + ')');
console.log('[NEXT] limpe o cache tsx e suba: rm -rf "C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\node_modules\\.cache" "$TEMP/tsx" 2>/dev/null; pm2 restart luna-whatsplay');
