'use strict';
/**
 * Bridge Factory — seleciona o transporte do cérebro do kernel (Fusão API).
 *   LUNA_TRANSPORT=api|cdp|auto   (default: auto = API primeiro, CDP como última rede)
 *
 * Resolução do provider de API (primeiro que existir):
 *   1. LUNA_API_BASE_URL + LUNA_API_MODEL (+ LUNA_API_KEY) — config manual
 *   2. Checkbox "usar mesma config da luna agent" (LUNA_WEB_USE_AGENT_CONFIG=true,
 *      default) → lê config/providers.json do luna-agent (mesmo contrato do painel)
 *      e pega o primeiro provider openai habilitado, em ordem de priority (a roda)
 *   3. KIMI_BASE_URL + KIMI_MODEL (+ KIMI_API_KEY) — legado do .env do kernel
 */
const fs = require('fs');
const path = require('path');

const AGENT_CONFIG_CANDIDATES = [
  path.resolve(__dirname, '..', '..', '..', 'config', 'providers.json'),                                    // monorepo: …/luna-agent/config
  path.resolve(__dirname, '..', '..', '..', 'Luna cto', 'luna-agent', 'config', 'providers.json'),          // pasta original: Documents/…
  path.resolve(__dirname, '..', '..', '..', '..', 'Luna cto', 'luna-agent', 'config', 'providers.json'),     // original alt
  process.env.LUNA_AGENT_CONFIG_PATH || '',
].filter(Boolean);

function readAgentProvidersConfig() {
  const candidates = [
    process.env.LUNA_AGENT_CONFIG_PATH || '',
    path.resolve(__dirname, '..', '..', '..', 'Luna cto', 'luna-agent', 'config', 'providers.json'),  // pasta original do kernel
    path.resolve(__dirname, '..', '..', '..', 'config', 'providers.json'),                          // monorepo: kernel/ dentro do agent
    path.resolve(__dirname, '..', '..', '..', '..', 'Luna cto', 'luna-agent', 'config', 'providers.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      // só aceita o config do luna-agent — existem providers.json "decoy" por aí
      if (!p.replace(/\\/g, '/').includes('luna-agent')) continue;
      if (fs.existsSync(p)) return { config: JSON.parse(fs.readFileSync(p, 'utf8')), path: p };
    } catch (e) {
      console.warn(`[BRIDGE-FACTORY] providers.json ilegível em ${p}: ${e.message}`);
    }
  }
  return null;
}

// Injeta as keys do .env do luna-agent no processo (só *_API_KEY/*_TOKEN, só se
// ainda não existirem) — assim o kernel reutiliza o MESMO .env do agent.
let agentEnvLoaded = false;
function loadAgentEnv(configPath) {
  if (agentEnvLoaded || !configPath) return;
  const envPath = path.join(path.dirname(configPath), '..', '.env');
  try {
    if (!fs.existsSync(envPath)) return;
    let n = 0;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
      if (!m) continue;
      const [_, k, v] = m;
      if (!/(API_KEY|TOKEN)$/.test(k)) continue;
      if (process.env[k]) continue;
      process.env[k] = v.trim().replace(/^["']|["']$/g, '');
      n++;
    }
    agentEnvLoaded = true;
    console.log(`[BRIDGE-FACTORY] ${n} keys do .env do luna-agent injetadas no processo`);
  } catch (e) {
    console.warn(`[BRIDGE-FACTORY] falha ao ler .env do agent: ${e.message}`);
  }
}

function resolveApiProvider() {
  const roda = resolveApiRoda();
  return roda[0] || null;
}

/**
 * v7.2 — Resolução da RODA COMPLETA (todos os providers elegíveis, em ordem).
 * Era o trabalho do resolveApiProvider, mas ele só devolvia o primeiro —
 * quando o provider caía (429/quota), o turno morria sem failover.
 * Modo manual (LUNA_API_*) devolve roda de 1 elemento.
 */
function resolveApiRoda() {
  // 1. manual
  if (process.env.LUNA_API_BASE_URL && process.env.LUNA_API_MODEL) {
    return [{ baseUrl: process.env.LUNA_API_BASE_URL, model: process.env.LUNA_API_MODEL, apiKey: process.env.LUNA_API_KEY || null, label: 'manual' }];
  }
  // 2. mesma config da luna agent (checkbox)
  const useAgent = (process.env.LUNA_WEB_USE_AGENT_CONFIG ?? 'true') === 'true';
  if (useAgent) {
    const found = readAgentProvidersConfig();
    if (found) {
      loadAgentEnv(found.path);
      const roda = (found.config.providers || [])
        .filter((p) => p.enabled && p.transport === 'openai' && p.baseUrl && p.model)
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999))
        .map((p) => ({
          baseUrl: p.baseUrl,
          model: p.model,
          apiKey: p.apiKeyEnv ? process.env[p.apiKeyEnv] || null : null,
          label: `agent:${p.id}`,
          semKey: !!(p.apiKeyEnv && !process.env[p.apiKeyEnv]),
        }));
      const comKey = roda.filter((p) => !p.semKey);
      const elegiveis = comKey.length ? comKey : roda;
      if (elegiveis.length) {
        console.log(`[BRIDGE-FACTORY] roda da luna agent em ${found.path}: ${elegiveis.length} provider(s) — fila: ${elegiveis.map((p) => p.label).join(' → ')}`);
        return elegiveis;
      }
      console.warn('[BRIDGE-FACTORY] providers.json sem provider openai habilitado');
    } else {
      console.warn('[BRIDGE-FACTORY] config/providers.json do luna agent não encontrado perto do kernel');
    }
  }
  // 3. legado kernel .env
  if (process.env.KIMI_BASE_URL && process.env.KIMI_MODEL) {
    return [{ baseUrl: process.env.KIMI_BASE_URL, model: process.env.KIMI_MODEL, apiKey: process.env.KIMI_API_KEY || null, label: 'kernel-env' }];
  }
  return [];
}

/**
 * v7.2 — RodaApiBridge: MESMA interface pública do ApiBridge/KimiBridge, mas
 * segurando a roda inteira. Quando o provider atual falha (HTTP 429/5xx,
 * timeout, resposta vazia), gira pro próximo da fila sozinho — "roda infinita".
 */
class RodaApiBridge {
  constructor(roda) {
    if (!roda || !roda.length) throw new Error('RodaApiBridge exige ao menos 1 provider');
    this.roda = roda;
    this.idx = 0;
    this.connected = false;
    this._abort = null;
    this._bridge = null;
    this._montar();
    console.log(`[RODA-BRIDGE] ativa — ${roda.length} provider(s); head: ${roda[0].label} (${roda[0].model})`);
  }

  _montar() {
    const { ApiBridge } = require('./api-bridge.cjs');
    const p = this.roda[this.idx];
    this._bridge = new ApiBridge(p);
    console.log(`[RODA-BRIDGE] pensando via ${p.label} @ ${p.model}`);
  }

  get currentLabel() { return this.roda[this.idx].label; }

  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; await this.cancelStream(); }
  async newChat() { /* stateless */ }
  async recoverSession() { /* noop ok por contrato */ }
  canSteer() { return false; }

  async cancelStream() {
    if (this._abort) { try { this._abort.abort(); } catch { /* já abortado */ } this._abort = null; }
    if (this._bridge) await this._bridge.cancelStream().catch(() => {});
  }

  /**
   * Delega pro bridge atual; em falha de provider (quota/HTTP/timeout),
   * gira a roda e tenta o próximo — até completar um ciclo inteiro.
   */
  async *sendMessageStream(userId, prompt, options = {}, provider) {
    const startIdx = this.idx;
    let lastErr = null;
    let promptAtual = prompt;
    for (let tentativa = 0; tentativa < this.roda.length; tentativa++) {
      let parcial = '';
      try {
        const resposta = [];
        for await (const ev of this._bridge.sendMessageStream(userId, promptAtual, options, provider)) {
          yield ev;
          if (ev.type === 'done') return;
          if (ev.type === 'response_delta') parcial += ev.text || '';
          resposta.push(ev);
        }
        // stream terminou sem 'done' — trata como vazio/falha pra girar
        const teveConteudo = resposta.some((e) => e.type === 'response_delta' || e.type === 'thinking_delta');
        if (teveConteudo) return;
        throw new Error('provider respondeu sem conteúdo e sem done');
      } catch (e) {
        lastErr = e;
        const msg = String(e.message || e);
        const falhaDeProvider = /HTTP (4\d\d|5\d\d)|quota|rate.?limit|timeout|abortado|vazio|abort|fetch failed|ECONNREFUSED|ENOTFOUND|ENETUNREACH|socket hangup|model not found/i.test(msg);
        this.idx = (this.idx + 1) % this.roda.length;
        if (this.idx === startIdx || !falhaDeProvider) {
          // ciclo completo ou erro não-transitório: desiste
          throw e;
        }
        console.warn(`[RODA-BRIDGE] ${msg.slice(0, 120)} — girando pra ${this.roda[this.idx].label}`);
        // Mecânica de contexto: se o provider anterior já tinha começado a
        // responder, leva o rascunho junto pra o próximo continuar de onde parou.
        if (parcial.trim()) {
          promptAtual = `${prompt}\n\n[CONTEXTO] O assistente anterior começou a responder mas falhou por instabilidade. Rascunho dele até agora:\n"""\n${parcial.trim().slice(0, 600)}\n"""\nContinue a tarefa a partir daí. Não repita o que já foi dito/dito acima; siga em frente e complete.`;
        }
        this._montar();
      }
    }
    throw lastErr || new Error('roda esgotada');
  }
}

function createBridge() {
  const { KimiBridge } = require('./kimi-bridge.cjs');
  const { ApiBridge } = require('./api-bridge.cjs');

  const transport = (process.env.LUNA_TRANSPORT || 'auto').toLowerCase();
  if (transport === 'cdp') {
    console.log('[BRIDGE-FACTORY] transporte CDP (forçado por LUNA_TRANSPORT=cdp)');
    return new KimiBridge();
  }

  const roda = resolveApiRoda();
  if (roda.length) {
    if (transport === 'api' || transport === 'auto') {
      try {
        // roda completa com failover automático (1 provider = comportamento antigo)
        return new RodaApiBridge(roda);
      } catch (e) {
        if (transport === 'api') throw new Error(`LUNA_TRANSPORT=api mas provider inválido: ${e.message}`);
        console.warn(`[BRIDGE-FACTORY] ApiBridge falhou (${e.message}); caindo pro CDP`);
      }
    }
  } else if (transport === 'api') {
    throw new Error('LUNA_TRANSPORT=api mas nenhum provider resolvido (configure LUNA_API_* ou o config/providers.json do agent)');
  }

  console.log('[BRIDGE-FACTORY] transporte CDP (Kimi Web)');
  return new KimiBridge();
}

module.exports = { createBridge, resolveApiProvider, resolveApiRoda, readAgentProvidersConfig, RodaApiBridge };
