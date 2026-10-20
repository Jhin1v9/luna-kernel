#!/usr/bin/env node
/**
 * fix-classify-readlive.js — v16.11 (decreto owner 20/10 23:35)
 * Classify novo formato: o MODELO LE o chat ao vivo via
 * dashboardGetWhatsAppHistory e classifica pelo que leu. A transcrição
 * embutida vira so uma AMOSTRA minima (ultimas 8 msgs, ordem cronologica)
 * de cinto-e-suspensorio caso a tool falhe. Antes: 40 msgs MAIS ANTIGAS
 * embutidas = classificava o passado pra sempre.
 * Tolerante: funciona do estado original ou do v16.10. Idempotente.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const FILE = 'C:\\Users\\Abner\\Documents\\Luna cto\\luna-agent\\apps\\worker\\src\\jobs\\classify.ts';
function ok(m) { console.log('[OK] ' + m); }
function warn(m) { console.log('[AVISO] ' + m); }
function fail(m) { console.log('[FAIL] ' + m); process.exit(1); }
function bak(f) {
  const b = f + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  fs.copyFileSync(f, b);
  return b;
}

(async function main() {
  if (!fs.existsSync(FILE)) fail('nao achei ' + FILE);
  let src = fs.readFileSync(FILE, 'utf8');
  if (src.includes('v16.11-fix')) { ok('ja aplicado'); process.exit(0); }
  const NL = src.includes('\r\n') ? '\r\n' : '\n';
  let changed = false;

  /* ---- 1) query: ultimas 8 (aceita original ou v16.10) ---- */
  const qOrig = 'WHERE conversation_id = $1 ORDER BY created_at ASC LIMIT 40`,';
  const qV1610 = 'WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,';
  const qNew = 'WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 8`,';
  if (src.includes(qNew)) {
    ok('query ja em DESC LIMIT 8');
  } else if (src.includes(qOrig) || src.includes(qV1610)) {
    src = src.replace(src.includes(qOrig) ? qOrig : qV1610, qNew);
    ok('query: ultimas 8 msgs (DESC)');
    changed = true;
  } else {
    fail('query anchor nao reconhecido (nem ASC40 nem DESC20)');
  }

  /* ---- 2) build do transcript -> instrucao + amostra ---- */
  const buildOrig = [
    '    const transcript = msgs.rows',
    '      .map((m) => `${m.author_name ?? (m.direction === \'inbound\' ? \'cliente\' : \'Luna\')}: ${m.body}`)',
    "      .join('\\n');",
  ].join(NL);
  const buildV1610 = [
    '    // v16.10-fix (owner 20/10): so a troca RECENTE (20 ultimas, ordem',
    '    // cronologica via reverse) — antes classificava as 40 mais antigas.',
    '    const transcript = msgs.rows.slice().reverse()',
    '      .map((m) => `${m.author_name ?? (m.direction === \'inbound\' ? \'cliente\' : \'Luna\')}: ${m.body}`)',
    "      .join('\\n');",
  ].join(NL);
  const buildNew = [
    '    // v16.11-fix (owner 20/10): o modelo LE o chat ao vivo via',
    '    // dashboardGetWhatsAppHistory e classifica pelo que leu. A amostra',
    '    // (ultimas 8, ordem cronologica) e so cinto-e-suspensorio.',
    '    const recentSample = msgs.rows.slice().reverse()',
    '      .map((m) => `${m.author_name ?? (m.direction === \'inbound\' ? \'cliente\' : \'Luna\')}: ${m.body}`)',
    "      .join('\\n');",
    "    const transcript = 'INSTRUCAO: antes de classificar, LEIA as mensagens recentes deste chat ao vivo usando a tool dashboardGetWhatsAppHistory (parametro chat = o nome desta conversa). Classifique com base no que voce LEU. Amostra minima das ultimas 8 mensagens (use so se a tool falhar):\\n' + recentSample;",
  ].join(NL);
  if (src.includes(buildOrig)) {
    src = src.replace(buildOrig, buildNew);
    ok('build: instrucao de leitura ao vivo + amostra');
    changed = true;
  } else if (src.includes(buildV1610)) {
    src = src.replace(buildV1610, buildNew);
    ok('build: v16.10 -> v16.11 (leitura ao vivo)');
    changed = true;
  } else {
    fail('build anchor nao reconhecido');
  }

  /* ---- 3) rotulo do bloco no template ---- */
  const t1 = "    'Transcrição (Quem: mensagem):',";
  if (src.includes(t1)) {
    src = src.replace(t1, "    'Contexto (leia ao vivo pela tool; amostra minima abaixo):',");
    ok('rotulo do bloco atualizado');
    changed = true;
  }

  if (!changed) { ok('nada a alterar'); process.exit(0); }
  const o = src.split('{').length - src.split('}').length;
  const p = src.split('(').length - src.split(')').length;
  if (o !== 0 || p !== 0) fail('desbalanceamento ({ ' + o + ', ( ' + p + ') — abortado');
  const b = bak(FILE);
  fs.writeFileSync(FILE, src, 'utf8');
  ok('v16.11 aplicado | backup: ' + path.basename(b));
  spawn('cmd.exe', ['/c', 'pm2 restart luna-worker'], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  ok('luna-worker reiniciado');
  console.log('=== PRA LIGAR: LUNA_CLASSIFY_ENABLED=1 no .env do luna-agent + pm2 restart luna-orchestrator ===');
  console.log('=== FIM ===');
})().catch((e) => { console.error('[FAIL] fatal: ' + (e && e.message || e)); process.exit(1); });
