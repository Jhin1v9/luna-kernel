'use strict';
/**
 * Dashboard Providers Tools — a Luna configura a roda de providers do painel
 * (:3101) via tool call (2026-10-14).
 *
 * Decreto owner: "cria apis de adicionar endpoints no painel da luna assim
 * posso enviar pra luna a key e ela ja põe direto lá o provider configura".
 * A API do painel (/api/config) já existia (save/set-key/add-provider/
 * remove-provider + presets) — esta tool é a PONTE: a Luna recebe uma key
 * ou um provider novo (por chat/WhatsApp) e configura sozinha.
 *
 * Auth: se o painel subir com LUNA_API_KEY no ambiente, o endpoint exige
 * o header Authorization: Bearer <token>. Sem a env, aceita (padrão atual,
 * painel bindado em 127.0.0.1). A tool envia o token quando consegue obtê-lo
 * (env LUNA_API_KEY / PAINEL_TOKEN do processo do kernel).
 *
 * Contrato: { success, stdout } | { success:false, error }.
 */

const PAINEL_BASE = () => (process.env.PAINEL_URL || 'http://127.0.0.1:3101').replace(/\/+$/, '');

function internalToken() {
  return process.env.LUNA_API_KEY || process.env.PAINEL_TOKEN || null;
}

async function painelFetch(apiPath, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const t = internalToken();
  if (t) headers.authorization = `Bearer ${t}`;
  const res = await fetch(PAINEL_BASE() + apiPath, {
    ...options,
    headers,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.error || `HTTP ${res.status}`;
    throw new Error(`Painel ${apiPath}: ${msg}`);
  }
  return data;
}

function ok(stdout) { return { success: true, stdout }; }
function err(error) { return { success: false, error: String(error) }; }

function fmtProvider(p) {
  const key = p.keyStatus ? ((p.keyStatus.configured ?? p.keyStatus.present) ? `🔑 ${p.keyStatus.preview || 'ok'}` : '⚠️ sem key') : '';
  return `- ${p.id} — ${p.label} · ${p.model} · prio ${p.priority ?? '-'} · ${p.enabled ? 'on' : 'off'} · ${p.role || 'ambos'} ${key}`;
}

// ── TOOLS ──

async function dashboardListProviders(params = {}) {
  try {
    const cfg = await painelFetch('/api/config', { method: 'GET' });
    const lines = (cfg.providers || []).map(fmtProvider);
    const filt = String(params.busca || '').toLowerCase();
    const shown = filt ? lines.filter((l) => l.toLowerCase().includes(filt)) : lines;
    const brains = `🧠 fastBrain: ${cfg.fastBrain} · liveBrain: ${cfg.liveBrain}`;
    return ok(`${brains}\n⚙️ ${shown.length} provider(s):\n${shown.join('\n')}\n\nPara adicionar: dashboardConfigProvider {"action": "add-preset", "presetId": "ID"} ou {"action": "add-custom", "provider": {...}}. Para key: {"action": "set-key", "env": "NOME_ENV", "value": "..."}`);
  } catch (e) { return err(e.message); }
}

async function dashboardSetProviderKey(params = {}) {
  try {
    const env = String(params.env || params.keyEnv || '').trim();
    const value = String(params.value || params.key || '').trim();
    if (!env || !value) return err('env e value são obrigatórios: dashboardSetProviderKey {"env": "OPENROUTER_API_KEY", "value": "sk-..."}');
    if (!/^[A-Z][A-Z0-9_]{2,}$/.test(env)) return err(`env '${env}' fora do padrão (MAIUSCULA_COM_UNDERLINE). Veja KEY_ALLOWLIST via dashboardConfigProvider {"action": "list"}.`);
    await painelFetch('/api/config', { method: 'POST', body: JSON.stringify({ action: 'set-key', env, value }) });
    return ok(`🔑 Key '${env}' salva no .env (via painel). Reinicie os processos pra aplicar: pm2 restart all --update-env`);
  } catch (e) { return err(e.message); }
}

async function dashboardAddProvider(params = {}) {
  try {
    if (params.presetId) {
      const r = await painelFetch('/api/config', { method: 'POST', body: JSON.stringify({ action: 'add-provider', presetId: String(params.presetId) }) });
      return ok(`✅ Provider preset '${params.presetId}' adicionado (id: ${r.id}). Lembre a key se o preset precisar.`);
    }
    const p = params.provider;
    if (!p || typeof p !== 'object') {
      return err('Informe presetId ou provider {id,label,baseUrl,apiKeyEnv,model,...}: dashboardConfigProvider {"action": "add-custom", "provider": {...}}');
    }
    const r = await painelFetch('/api/config', { method: 'POST', body: JSON.stringify({ action: 'add-provider', custom: p }) });
    return ok(`✅ Provider custom '${p.id || r.id}' adicionado (id: ${r.id}). Se precisar de key: dashboardSetProviderKey.`);
  } catch (e) { return err(e.message); }
}

async function dashboardRemoveProvider(params = {}) {
  try {
    const id = String(params.id || '').trim();
    if (!id) return err('Informe o id: dashboardConfigProvider {"action": "remove", "id": "openrouter-x"}');
    await painelFetch('/api/config', { method: 'POST', body: JSON.stringify({ action: 'remove-provider', id }) });
    return ok(`🗑️ Provider '${id}' removido.`);
  } catch (e) { return err(e.message); }
}

/** Router geral — a API unificada que o modelo pode chamar de vários jeitos. */
async function dashboardConfigProvider(params = {}) {
  const action = String(params.action || (params.presetId ? 'add-preset' : params.provider ? 'add-custom' : params.id && params.value === undefined ? 'remove' : 'list'));
  if (action === 'list') return dashboardListProviders(params);
  if (action === 'set-key') return dashboardSetProviderKey(params);
  if (action === 'add-preset' || action === 'add-custom' || action === 'add') return dashboardAddProvider(params);
  if (action === 'remove' || action === 'remove-provider') return dashboardRemoveProvider(params);
  return err(`action desconhecida: ${action}. Use list | set-key | add-preset | add-custom | remove.`);
}

module.exports = {
  dashboardConfigProvider,
  dashboardListProviders,
  dashboardSetProviderKey,
  dashboardAddProvider,
  dashboardRemoveProvider,
};
