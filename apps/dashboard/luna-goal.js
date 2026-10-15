/**
 * luna-goal.js — Modo GOAL (decreto owner 2026-10-15)
 *
 * Problema que resolve: as APIs gratuitas da roda são STATELESS — "executam
 * e morrem". Uma tool por turno, sem memória de missão. O owner definiu a
 * arquitetura:
 *
 *   1. CLASSIFICADOR — toda mensagem nova passa primeiro por uma chamada
 *      barata que decide o GOAL: é só responder? é agir? qual o destino
 *      final ("checar solicitações", "avisar o Abner", "responder o grupo")?
 *   2. EXECUTOR (fast brain) — roda a ação tool a tool.
 *   3. LIVE BRAIN — enquanto o goal não for cumprido, re-prompta a API com a
 *      missão + progresso: "SUA MISSÃO É TAL, JÁ FEZ A/B, FALTA C — TERMINE".
 *      A API "dorme" só quando o goal fecha (marcador <goal_done/>) ou o teto
 *      de turnos é atingido.
 *
 * Implementação: módulo do lado de FORA do soul (luna-soul.cjs fica com a
 * Vênus). Cada iteração do loop é um turno normal de processMessageStream —
 * o progresso vai EMBARCADO no prompt da missão (é assim que a API stateless
 * "lembra": o contexto da missão inteira viaja em cada chamada), e as
 * respostas de cada turno entram no histórico da sessão (memória persistida).
 *
 * Uso:
 *   - modo 'goal' no POST /api/chat (session.mode = 'goal'), ou
 *   - comando local "/goal <pedido>" em qualquer modo.
 */

'use strict';

const GOAL_MAX_TURNS = Math.max(2, parseInt(process.env.LUNA_GOAL_MAX_TURNS || '8', 10));
const GOAL_DONE_MARKER = '<goal_done/>';
// Modelos das sessões auxiliares (classificador/veredito): a roda resolve.
const CLASSIFY_PROVIDER = process.env.LUNA_GOAL_CLASSIFY_PROVIDER || 'roda';

// ──────────────────────────────────────────────────────────────
// Prompts
// ──────────────────────────────────────────────────────────────

const CLASSIFY_SYSTEM = [
  'Você é o CLASSIFICADOR DE MISSÕES da Luna (Nexo Digital).',
  'Analise o pedido do usuário e responda APENAS um JSON válido, sem markdown, sem texto fora do JSON, com exatamente estas chaves:',
  '{"goal": "<objetivo final em uma frase — o que a Luna precisa ENTREGAR>", "type": "responder" | "agir", "done_criteria": "<critério objetivo e verificável de conclusão>", "resumo": "<para quem/onde é o destino da resposta>"}',
  '',
  'Regras:',
  '- type "responder": quando basta uma resposta de conversa (pergunta, opinião, boato, conversa).',
  '- type "agir": quando é preciso EXECUTAR algo (consultar dados, mandar mensagem, criar solicitação, checar painel, usar qualquer tool).',
  '- done_criteria deve ser verificável: cite o dado que precisa aparecer na resposta final ou a ação que precisa ter acontecido.',
  '- Seja conciso. PT-BR.',
].join('\n');

function buildMissionPrompt(classification, userMessage, progress, turn, maxTurns) {
  const done = progress.filter((p) => p.kind === 'done');
  const pend = progress.filter((p) => p.kind === 'pending');
  const lines = [
    '[MISSÃO ATIVA — MODO GOAL]',
    `SUA MISSÃO: ${classification.goal}`,
    `CRITÉRIO DE CONCLUSÃO: ${classification.done_criteria}`,
    `PEDIDO ORIGINAL DO USUÁRIO: "${userMessage}"`,
    '',
  ];
  if (done.length) {
    lines.push('JÁ FEITO:');
    for (const p of done.slice(-8)) lines.push(`  ✔ ${p.text}`);
    lines.push('');
  }
  if (pend.length) {
    lines.push('AINDA FALTA:');
    for (const p of pend.slice(-8)) lines.push(`  ☐ ${p.text}`);
    lines.push('');
  }
  lines.push(
    `REGRAS DE OURO (turno ${turn}/${maxTurns}):`,
    '- Execute o PRÓXIMO passo concreto da missão AGORA (use tools se precisar — você pode usar quantas forem necessárias neste turno).',
    '- Não repita passo que já está em JÁ FEITO.',
    '- Quando o CRITÉRIO DE CONCLUSÃO estiver satisfeito, escreva a RESPOSTA FINAL para o usuário e termine exatamente com ' + GOAL_DONE_MARKER,
    '- Se não souber como concluir um passo, diga explicitamente o que falta e o que tentou (isso também é progresso).',
  );
  return lines.join('\n');
}

const SYNTHESIS_SUFFIX = [
  '',
  'Agora escreva a RESPOSTA FINAL para o usuário: traga o resultado da missão',
  '(o que conseguiu, o que não conseguiu e o porquê), em linguagem natural,',
  'como a Luna fala. Termine exatamente com ' + GOAL_DONE_MARKER,
].join('\n');

// ──────────────────────────────────────────────────────────────
// Motor
// ──────────────────────────────────────────────────────────────

/** Consome um turno inteiro do soul e resume o que aconteceu. */
async function drainTurn(luna, prompt, opts) {
  const tools = [];
  let finalText = '';
  let sawDone = false;
  for await (const ev of luna.processMessageStream(prompt, opts)) {
    if (ev.type === 'action_start' && ev.tool) tools.push(String(ev.tool));
    if (ev.type === 'done') {
      sawDone = true;
      finalText = ev.result?.response || ev.response || ev.fullResponse || ev.text || finalText;
    }
    if (ev.type === 'assistant') {
      finalText = ev.response || ev.text || ev.fullResponse || finalText;
    }
  }
  return { tools, finalText: String(finalText || ''), sawDone };
}

/** Extrai JSON tolerante de texto de modelo. */
function extractJson(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function normalizeClassification(raw, userMessage) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const goal = String(c.goal || '').trim();
  return {
    goal: goal || `Atender o pedido: ${userMessage.slice(0, 160)}`,
    type: c.type === 'agir' ? 'agir' : 'responder',
    doneCriteria: String(c.done_criteria || 'o pedido do usuário respondido por completo').trim(),
    resumo: String(c.resumo || '').trim(),
  };
}

/**
 * Loop GOAL — async generator. Yield eventos no shape que o chat-routes já
 * renderiza ('system' para marcos do goal, 'done' no final). O chat-routes
 * itera isso exatamente como itera o stream do soul.
 *
 * @param luna      soul inicializado (getLunaSoul())
 * @param baseOpts  opções comuns do turno (sessionId, userId, persona, mode...)
 * @param session   sessão web (para gravar goalState de diagnóstico)
 * @param message   mensagem do usuário
 */
async function* runGoalStream(luna, baseOpts, session, message, abortRef) {
  const aborted = () => abortRef && abortRef.cancelled;
  const sys = (content, extra) => ({ type: 'system', message: content, ...(extra || {}), timestamp: new Date().toISOString() });
  const progress = [];
  const startedAt = Date.now();

  yield sys(`🎯 Modo GOAL ativo — classificando a missão…`);

  // 1) CLASSIFICADOR — 1 chamada barata define o objetivo
  let classification;
  try {
    const turn = await drainTurn(luna, CLASSIFY_SYSTEM + '\n\nPEDIDO: ' + message, {
      ...baseOpts,
      mode: 'instant',
      skipUserEventStorage: true,
      provider: CLASSIFY_PROVIDER,
    });
    classification = normalizeClassification(extractJson(turn.finalText), message);
  } catch (e) {
    // Classificador falhou: não trava o usuário — goal genérico de responder.
    classification = normalizeClassification(null, message);
    yield sys(`⚠️ classificador falhou (${String(e.message || e).slice(0, 120)}) — seguindo com goal genérico.`);
  }

  const goalState = {
    goal: classification.goal,
    type: classification.type,
    doneCriteria: classification.doneCriteria,
    turns: 0,
    startedAt,
    status: 'running',
  };
  session.goal = goalState; // diagnóstico (sobrevive no sessions.json local)

  yield sys(
    `🎯 Goal definido: ${classification.goal}` +
    (classification.type === 'agir' ? ` · concluir quando: ${classification.doneCriteria}` : '') +
    ` · até ${GOAL_MAX_TURNS} turnos.`,
  );

  // Goal trivial (só conversar): um turno normal já é a resposta.
  if (classification.type === 'responder') {
    goalState.status = 'trivial';
    const t = await drainTurn(luna, message, { ...baseOpts, mode: 'instant' });
    goalState.turns = 1;
    yield { type: 'done', result: { response: t.finalText }, timestamp: new Date().toISOString() };
    return;
  }

  // 2) LOOP DE MISSÃO — live brain re-contextualiza a API a cada turno
  let finalText = '';
  for (let turn = 1; turn <= GOAL_MAX_TURNS; turn++) {
    if (aborted()) { goalState.status = 'cancelled'; yield sys('🛑 goal cancelado pelo usuário.'); return; }
    goalState.turns = turn;
    const prompt = buildMissionPrompt(classification, message, progress, turn, GOAL_MAX_TURNS);
    let t;
    try {
      t = await drainTurn(luna, prompt, {
        ...baseOpts,
        mode: 'thinking',
        skipUserEventStorage: true,
      });
    } catch (e) {
      progress.push({ kind: 'pending', text: `turno ${turn} falhou: ${String(e.message || e).slice(0, 160)}` });
      yield sys(`⚠️ turno ${turn} falhou (${String(e.message || e).slice(0, 120)}) — reenviando com o erro no contexto…`);
      continue;
    }

    const text = t.finalText || '';
    const clipped = text.replace(GOAL_DONE_MARKER, '').trim();
    if (t.tools.length) {
      progress.push({ kind: 'done', text: `turno ${turn}: tools ${t.tools.join(', ')}` });
    }
    if (clipped) {
      progress.push({ kind: 'done', text: `turno ${turn}: ${clipped.slice(0, 300)}` });
    }
    if (!t.tools.length && !clipped) {
      progress.push({ kind: 'pending', text: `turno ${turn}: API respondeu vazio (stateless caiu?) — reenviando a missão` });
    }
    finalText = clipped || finalText;

    yield sys(`🎯 turno ${turn}/${GOAL_MAX_TURNS} — ${t.tools.length ? `tools: ${t.tools.join(', ')}` : 'sem tools'}${text.includes(GOAL_DONE_MARKER) ? ' · goal concluído ✔' : ''}`);

    if (text.includes(GOAL_DONE_MARKER)) {
      goalState.status = 'done';
      yield { type: 'done', result: { response: clipped }, timestamp: new Date().toISOString() };
      return;
    }
  }

  // 3) TETO ATINGIDO — live brain manda sintetizar o que tem
  goalState.status = 'timeout';
  yield sys(`⏱️ teto de ${GOAL_MAX_TURNS} turnos atingido — pedindo síntese do que foi feito.`);
  if (aborted()) { goalState.status = 'cancelled'; return; }
  try {
    const s = await drainTurn(
      luna,
      buildMissionPrompt(classification, message, progress, GOAL_MAX_TURNS, GOAL_MAX_TURNS) + SYNTHESIS_SUFFIX,
      { ...baseOpts, mode: 'thinking', skipUserEventStorage: true },
    );
    finalText = s.finalText.replace(GOAL_DONE_MARKER, '').trim() || finalText;
  } catch { /* mantém o último texto */ }

  yield {
    type: 'done',
    result: { response: finalText || 'Executei o que consegui, mas atingi o limite de turnos sem concluir a missão por completo.' },
    timestamp: new Date().toISOString(),
  };
}

/** "/goal <pedido>" ativa o modo goal para aquela mensagem. */
function parseGoalCommand(message) {
  const m = String(message || '').match(/^\s*\/goal\s+([\s\S]+)$/i);
  return m ? m[1].trim() : null;
}

module.exports = {
  runGoalStream,
  parseGoalCommand,
  GOAL_MAX_TURNS,
  GOAL_DONE_MARKER,
  // exposto para testes
  _internal: { buildMissionPrompt, normalizeClassification, extractJson },
};
