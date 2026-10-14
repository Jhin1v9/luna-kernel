'use strict';
/**
 * Workspace Nexo — solicitações do portal admin (/nexo) — 2026-10-14.
 *
 * Decreto owner: a Luna precisa VER e ATENDER as solicitações dos clientes
 * (Ona Dance/Jess, HDM, JR Reformas...) que vivem no Workspace Nexo
 * (https://vps.nexo-digital.app/nexo). Antes ela só sabia das tarefas do
 * painel Luna (:3101) — estas são o workspace admin de verdade.
 *
 * Auth: login admin (NEXO_API_USERNAME/NEXO_API_PASSWORD do .env do
 * luna-agent, mesmo padrão da skill solicitacoes-painel), cookie de sessão
 * cacheado em memória com re-login automático em 401/403.
 *
 * Contrato de retorno: { success, stdout } | { success:false, error } —
 * igual às dashboard* tools de luna-tools.cjs.
 */

const fs = require('fs');

const BASE = (process.env.NEXO_WS_BASE || 'https://vps.nexo-digital.app').replace(/\/+$/, '');

let _sessionCookie = null;
let _creds = null;

function ok(stdout) { return { success: true, stdout }; }
function err(error) { return { success: false, error: String(error) }; }

function loadCreds() {
  if (_creds) return _creds;
  const candidates = [
    process.env.LUNA_AGENT_ENV_PATH || '',
    '/home/nexo/luna-agent/.env',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const env = {};
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z_0-9]+)=(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      if (env.NEXO_API_USERNAME && env.NEXO_API_PASSWORD) {
        _creds = { email: env.NEXO_API_USERNAME, password: env.NEXO_API_PASSWORD };
        return _creds;
      }
    } catch { /* tenta o próximo candidato */ }
  }
  if (process.env.NEXO_API_USERNAME && process.env.NEXO_API_PASSWORD) {
    _creds = { email: process.env.NEXO_API_USERNAME, password: process.env.NEXO_API_PASSWORD };
  }
  return _creds;
}

async function adminLogin(force = false) {
  if (_sessionCookie && !force) return _sessionCookie;
  const creds = loadCreds();
  if (!creds) throw new Error('Credenciais NEXO_API_USERNAME/NEXO_API_PASSWORD não encontradas no .env do luna-agent');
  const c1 = await fetch(`${BASE}/nexo/api/auth/csrf`);
  const csrf = await c1.json();
  const jar = c1.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
  const res = await fetch(`${BASE}/nexo/api/auth/callback/credentials`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar },
    body: new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email: creds.email,
      password: creds.password,
      callbackUrl: `${BASE}/nexo/pt`,
    }).toString(),
    redirect: 'manual',
  });
  const token = res.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('nexo.session-token='));
  if (!token) throw new Error('Login admin no Workspace Nexo falhou (session-token não veio)');
  _sessionCookie = token;
  return _sessionCookie;
}

async function adminFetch(apiPath, options = {}, retried = false) {
  const cookie = await adminLogin(retried);
  const csrfRes = await fetch(`${BASE}/nexo/api/auth/csrf`);
  const csrfCookie = csrfRes.headers.getSetCookie().map(c => c.split(';')[0]).find(c => c.startsWith('nexo.csrf-token='));
  const res = await fetch(BASE + apiPath, {
    ...options,
    headers: {
      'content-type': 'application/json',
      cookie: [cookie, csrfCookie].filter(Boolean).join('; '),
      ...(options.headers || {}),
    },
  });
  if ((res.status === 401 || res.status === 403) && !retried) {
    return adminFetch(apiPath, options, true); // sessão expirada → re-login e repete
  }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? (data.error || data.message || JSON.stringify(data)) : String(text).slice(0, 200);
    throw new Error(`Workspace Nexo HTTP ${res.status}: ${msg}`);
  }
  return data;
}

function fmtRequest(r) {
  const id = (r.id || '').slice(-6);
  const status = r.status || '?';
  const org = r.organization?.name || r.organization?.slug || r.organizationId || '?';
  const proj = r.project?.name || r.projectId || '?';
  const content = String(r.content || '').replace(/\s+/g, ' ').slice(0, 120);
  const when = r.createdAt ? String(r.createdAt).slice(0, 10) : '';
  return `#${id} [${status}] ${org} / ${proj} — ${content}${when ? ` (${when})` : ''}`;
}

// ── TOOLS ──

async function workspaceListRequests(params = {}) {
  try {
    const q = new URLSearchParams();
    for (const k of ['status', 'projectId', 'organizationId', 'search']) {
      if (params[k]) q.set(k, String(params[k]));
    }
    q.set('limit', String(params.limit || 25));
    const data = await adminFetch(`/nexo/api/admin/requests?${q.toString()}`, { method: 'GET' });
    const list = Array.isArray(data) ? data : (data.requests || data.items || data.data || []);
    if (!list.length) return ok('📋 Nenhuma solicitação encontrada com esses filtros.');
    const lines = list.map(fmtRequest);
    return ok(`📋 ${list.length} solicitação(ões):\n${lines.join('\n')}`);
  } catch (e) { return err(e.message); }
}

async function workspaceGetRequest(params = {}) {
  try {
    if (!params.id) return err('id obrigatório');
    const r = await adminFetch(`/nexo/api/admin/requests/${params.id}`, { method: 'GET' });
    const content = String(r.content || '').slice(0, 1500);
    const events = Array.isArray(r.events) ? r.events.length : (r._count?.events || 0);
    return ok(`📄 Solicitação ${r.id}\nStatus: ${r.status} · Urgência: ${r.urgencyHint || '-'}\nOrg: ${r.organization?.name || r.organizationId} · Projeto: ${r.project?.name || r.projectId}\nEventos: ${events}\n\n${content}`);
  } catch (e) { return err(e.message); }
}

async function workspaceCreateRequest(params = {}) {
  try {
    const { organizationId, projectId, content } = params;
    if (!organizationId || !projectId || !content) return err('organizationId, projectId e content são obrigatórios');
    const body = { organizationId, projectId, content: String(content).slice(0, 4000) };
    if (params.status) body.status = params.status;
    if (params.urgencyHint) body.urgencyHint = params.urgencyHint;
    const r = await adminFetch('/nexo/api/admin/requests', { method: 'POST', body: JSON.stringify(body) });
    return ok(`✅ Solicitação criada: ${fmtRequest(r.request || r)}`);
  } catch (e) { return err(e.message); }
}

async function workspaceUpdateRequest(params = {}) {
  try {
    if (!params.id) return err('id obrigatório');
    const body = {};
    if (params.status) body.status = params.status;
    if (params.urgencyHint) body.urgencyHint = params.urgencyHint;
    if (!Object.keys(body).length) return err('Informe status e/ou urgencyHint');
    const r = await adminFetch(`/nexo/api/admin/requests/${params.id}`, { method: 'PUT', body: JSON.stringify(body) });
    return ok(`✏️ Solicitação atualizada: ${fmtRequest(r.request || r)}`);
  } catch (e) { return err(e.message); }
}

async function workspaceAddComment(params = {}) {
  try {
    if (!params.id || !params.content) return err('id e content obrigatórios');
    const body = { content: String(params.content).slice(0, 2000), visibility: params.visibility || 'SHARED' };
    await adminFetch(`/nexo/api/admin/requests/${params.id}/comments`, { method: 'POST', body: JSON.stringify(body) });
    return ok(`💬 Comentário adicionado na solicitação ${params.id}`);
  } catch (e) { return err(e.message); }
}

async function workspaceListProjects(params = {}) {
  try {
    const data = await adminFetch('/nexo/api/admin/projects', { method: 'GET' });
    const list = Array.isArray(data) ? data : (data.projects || data.data || []);
    const lines = list.map(p => `- ${p.name} (id: ${p.id}) — org: ${p.organization?.name || p.organizationId || '?'}`);
    return ok(`🗂️ ${list.length} projeto(s):\n${lines.join('\n')}`);
  } catch (e) { return err(e.message); }
}

async function workspaceListOrganizations(params = {}) {
  try {
    const data = await adminFetch('/nexo/api/admin/organizations', { method: 'GET' });
    const list = Array.isArray(data) ? data : (data.organizations || data.data || []);
    const lines = list.map(o => `- ${o.name || o.slug} (id: ${o.id})`);
    return ok(`🏢 ${list.length} organização(ões):\n${lines.join('\n')}`);
  } catch (e) { return err(e.message); }
}

async function workspaceListClients(params = {}) {
  try {
    const data = await adminFetch('/nexo/api/admin/clients', { method: 'GET' });
    const list = Array.isArray(data) ? data : (data.clients || data.data || []);
    const lines = list.map(c => `- ${c.name || c.email} (${c.email || 'sem email'}) — org: ${c.organization?.name || c.organizationId || '?'}`);
    return ok(`👥 ${list.length} cliente(s):\n${lines.join('\n')}`);
  } catch (e) { return err(e.message); }
}

module.exports = {
  workspaceListRequests,
  workspaceGetRequest,
  workspaceCreateRequest,
  workspaceUpdateRequest,
  workspaceAddComment,
  workspaceListProjects,
  workspaceListOrganizations,
  workspaceListClients,
};
