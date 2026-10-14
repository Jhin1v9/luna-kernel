/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Luna Tools API — Proxy para o Dashboard Backend real (v6.0)
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * v6.0: O "Dashboard PRO" da porta 3456 nunca existiu em produção. Os dados
 * reais (leads, tarefas, financeiro, votação) vivem no backend do painel
 * Nexo (container nexo_dashboard_backend :3500 no VPS), exposto pelo Caddy
 * em https://vps.nexo-digital.app/dashboard/api/* e autenticado por Bearer.
 *
 * Config via env (apps/dashboard/.env — vale no PC e no VPS):
 *   LUNA_DASHBOARD_URL   — default https://vps.nexo-digital.app/dashboard
 *   LUNA_DASHBOARD_TOKEN — Bearer token (INTERNAL_API_TOKEN do backend 3500)
 * ═══════════════════════════════════════════════════════════════════════════
 */
const express = require('express');
const http = require('http');
const https = require('https');
const NodeCache = require('node-cache');
const router = express.Router();

const DASHBOARD_BASE = (process.env.LUNA_DASHBOARD_URL || 'https://vps.nexo-digital.app/dashboard').replace(/\/+$/, '');
const DASHBOARD_TOKEN = process.env.LUNA_DASHBOARD_TOKEN || process.env.DASHBOARD_INTERNAL_TOKEN || '';
const CACHE_TTL = { stats: 30, leads: 30, tasks: 30, finance: 30, voting: 30 };

// In-memory cache for read-heavy endpoints
const cache = new NodeCache({ stdTTL: CACHE_TTL.stats, checkperiod: 60 });
const CACHE_KEYS = {
  leads: 'tools:leads',
  tasks: 'tools:tasks',
  finance: 'tools:finance',
  voting: 'tools:voting',
  stats: 'tools:stats',
};
function invalidateCache(...keys) {
  keys.forEach(k => cache.del(k));
}

function dashboardRequest(apiPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    if (!DASHBOARD_TOKEN) {
      const err = new Error('LUNA_DASHBOARD_TOKEN não configurado (apps/dashboard/.env)');
      err.code = 'NO_TOKEN';
      return reject(err);
    }
    const url = new URL(`${DASHBOARD_BASE}${apiPath}`);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Authorization': `Bearer ${DASHBOARD_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 12000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Timeout ao consultar Dashboard')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LEADS API → proxy to Dashboard PRO /api/leads
// ═══════════════════════════════════════════════════════════════════════════

router.get('/api/tools/leads', async (req, res) => {
  try {
    const cached = cache.get(CACHE_KEYS.leads);
    if (cached) {
      return res.json(cached);
    }
    const result = await dashboardRequest('/api/leads');
    if (result.status !== 200 || !result.body.success) {
      return res.status(502).json({ ok: false, error: 'Dashboard indisponível' });
    }
    const leads = result.body.leads || [];

    // Compute stats in Luna Web format
    const stats = {
      total: leads.length,
      totalValue: leads.reduce((s, l) => s + (l.estimatedValue || l.value || 0), 0),
      byStatus: {},
      bySource: {},
      recent: leads.filter(l => {
        const d = new Date(l.createdAt);
        return (Date.now() - d.getTime()) < 7 * 24 * 60 * 60 * 1000;
      }).length,
    };
    leads.forEach(l => {
      const st = l.pipelineStatus || l.status || 'novo';
      stats.byStatus[st] = (stats.byStatus[st] || 0) + 1;
      stats.bySource[l.source || 'outro'] = (stats.bySource[l.source || 'outro'] || 0) + 1;
    });

    const response = { ok: true, leads, stats };
    cache.set(CACHE_KEYS.leads, response, CACHE_TTL.leads);
    res.json(response);
  } catch (e) {
    console.error('[LunaTools] leads GET error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.post('/api/tools/leads', async (req, res) => {
  try {
    const { name, email, phone, source, status, value, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ ok: false, error: 'Nome obrigatório' });
    invalidateCache(CACHE_KEYS.leads, CACHE_KEYS.stats);

    const result = await dashboardRequest('/api/leads', 'POST', {
      displayName: name.trim(),
      name: name.trim(),
      email: email || '',
      phone: phone || '',
      source: source || 'luna-web',
      estimatedValue: value ? parseFloat(value) : 0,
      notes: notes || '',
      assignedTo: 'abner'
    });

    if (result.status !== 200 || !result.body.success) {
      return res.status(502).json({ ok: false, error: result.body.error || 'Erro ao criar lead no Dashboard' });
    }
    res.json({ ok: true, lead: result.body.lead });
  } catch (e) {
    console.error('[LunaTools] leads POST error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TASKS API → proxy to Dashboard PRO /api/tasks
// ═══════════════════════════════════════════════════════════════════════════

router.get('/api/tools/tasks', async (req, res) => {
  try {
    const cached = cache.get(CACHE_KEYS.tasks);
    if (cached) {
      return res.json(cached);
    }
    const result = await dashboardRequest('/api/tasks');
    if (result.status !== 200 || !Array.isArray(result.body)) {
      return res.status(502).json({ ok: false, error: 'Dashboard indisponível' });
    }
    const tasks = result.body;

    const stats = {
      total: tasks.length,
      byStatus: {},
      byPriority: {},
      overdue: 0,
      highPriority: 0,
    };
    const now = new Date();
    tasks.forEach(t => {
      stats.byStatus[t.status] = (stats.byStatus[t.status] || 0) + 1;
      stats.byPriority[t.priority] = (stats.byPriority[t.priority] || 0) + 1;
      if (t.priority === 'high' || t.priority === 'Alta') stats.highPriority++;
      if (t.dueDate && new Date(t.dueDate) < now && t.status !== 'completed') {
        stats.overdue++;
      }
    });

    const response = { ok: true, tasks, stats };
    cache.set(CACHE_KEYS.tasks, response, CACHE_TTL.tasks);
    res.json(response);
  } catch (e) {
    console.error('[LunaTools] tasks GET error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

router.post('/api/tools/tasks', async (req, res) => {
  try {
    const { title, description, priority, taskType, dueDate, assignedTo } = req.body;
    if (!title?.trim()) return res.status(400).json({ ok: false, error: 'Título obrigatório' });
    invalidateCache(CACHE_KEYS.tasks, CACHE_KEYS.stats);

    const result = await dashboardRequest('/api/tasks', 'POST', {
      title: title.trim(),
      description: description || '',
      priority: priority === 'Alta' ? 'high' : (priority === 'Baixa' ? 'low' : 'high'),
      taskType: taskType || 'one_time',
      dueDate: dueDate || null,
      assignedTo: assignedTo || 'abner'
    });

    if (result.status !== 200 || !result.body.id) {
      return res.status(502).json({ ok: false, error: 'Erro ao criar tarefa no Dashboard' });
    }
    res.json({ ok: true, task: result.body });
  } catch (e) {
    console.error('[LunaTools] tasks POST error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FINANCE API → proxy to Dashboard PRO
// ═══════════════════════════════════════════════════════════════════════════

router.get('/api/tools/finance', async (req, res) => {
  try {
    const cached = cache.get(CACHE_KEYS.finance);
    if (cached) {
      return res.json(cached);
    }
    const result = await dashboardRequest('/api/finance/summary');
    if (result.status !== 200) {
      return res.status(502).json({ ok: false, error: 'Dashboard indisponível' });
    }
    const data = result.body;
    const response = {
      ok: true,
      finance: {
        balance: data.cashBoxBalance || data.balance?.value || 0,
        monthlyIncome: data.monthlyIncome || data.totalIncome?.value || 0,
        monthlyExpenses: data.monthlyExpenses || data.totalExpense?.value || 0,
        totalExpected: data.totalExpected || 0,
        totalReceived: data.totalReceived || 0,
        totalPending: data.totalPending || 0,
        activeClients: data.activeClients || 0,
        overduePayments: data.overduePayments || 0,
        currency: data.balance?.currency || 'EUR'
      }
    };
    cache.set(CACHE_KEYS.finance, response, CACHE_TTL.finance);
    res.json(response);
  } catch (e) {
    console.error('[LunaTools] finance error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// VOTING API → proxy to Dashboard PRO
// ═══════════════════════════════════════════════════════════════════════════

router.get('/api/tools/voting', async (req, res) => {
  try {
    const cached = cache.get(CACHE_KEYS.voting);
    if (cached) {
      return res.json(cached);
    }
    const result = await dashboardRequest('/api/voting/sessions');
    if (result.status !== 200 || !result.body.sessions) {
      return res.status(502).json({ ok: false, error: 'Dashboard indisponível' });
    }
    const sessions = result.body.sessions || [];
    const open = sessions.filter(s => s.status === 'open');
    const closed = sessions.filter(s => s.status === 'closed');
    const withVotes = sessions.filter(s => {
      const votes = s.votes || {};
      return Object.values(votes).some(v => v !== null);
    });

    const response = {
      ok: true,
      voting: {
        total: sessions.length,
        open: open.length,
        closed: closed.length,
        voted: withVotes.length,
        sessions: sessions.slice(0, 20)
      }
    };
    cache.set(CACHE_KEYS.voting, response, CACHE_TTL.voting);
    res.json(response);
  } catch (e) {
    console.error('[LunaTools] voting error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// DASHBOARD STATS API → aggregate from Dashboard PRO
// ═══════════════════════════════════════════════════════════════════════════

router.get('/api/tools/stats', async (req, res) => {
  try {
    const cached = cache.get(CACHE_KEYS.stats);
    if (cached) {
      return res.json(cached);
    }
    const [leadsRes, tasksRes, financeRes, votingRes] = await Promise.all([
      dashboardRequest('/api/leads'),
      dashboardRequest('/api/tasks'),
      dashboardRequest('/api/finance/summary'),
      dashboardRequest('/api/voting/sessions')
    ]);

    const leads = (leadsRes.status === 200 && leadsRes.body.success) ? (leadsRes.body.leads || []) : [];
    const tasks = (tasksRes.status === 200 && Array.isArray(tasksRes.body)) ? tasksRes.body : [];
    const finance = (financeRes.status === 200) ? financeRes.body : {};
    const votingSessions = (votingRes.status === 200 && votingRes.body.sessions) ? votingRes.body.sessions : [];

    const response = {
      ok: true,
      stats: {
        leads: {
          total: leads.length,
          value: leads.reduce((s, l) => s + (l.estimatedValue || l.value || 0), 0),
          recent: leads.filter(l => {
            const d = new Date(l.createdAt);
            return (Date.now() - d.getTime()) < 7 * 24 * 60 * 60 * 1000;
          }).length,
        },
        tasks: {
          total: tasks.length,
          pending: tasks.filter(t => t.status === 'pending').length,
          inProgress: tasks.filter(t => t.status === 'in_progress').length,
          completed: tasks.filter(t => t.status === 'completed').length,
          highPriority: tasks.filter(t => t.priority === 'Alta' || t.priority === 'high').length,
        },
        finance: {
          balance: finance.cashBoxBalance || finance.balance?.value || 0,
          monthlyIncome: finance.monthlyIncome || 0,
          monthlyExpenses: finance.monthlyExpenses || 0,
          activeClients: finance.activeClients || 0,
          overduePayments: finance.overduePayments || 0,
        },
        voting: {
          total: votingSessions.length,
          open: votingSessions.filter(s => s.status === 'open').length,
        }
      }
    };
    cache.set(CACHE_KEYS.stats, response, CACHE_TTL.stats);
    res.json(response);
  } catch (e) {
    console.error('[LunaTools] stats error:', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

module.exports = router;
