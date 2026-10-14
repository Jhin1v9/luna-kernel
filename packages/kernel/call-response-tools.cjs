'use strict';
/**
 * Call Respond Tool — a Luna Web responde DENTRO da chamada via tool call
 * (2026-10-14, arquitetura aprovada pelo owner + veredito de arquitetura).
 *
 * Fluxo: chamada ao vivo → captions → whatsplay relay → sessão Luna Web
 * ("conductor", priming: "Abner está em chamada, mando as transcrições, anota
 * no brain, cada pedido: executa e responde via call.respond") → a sessão
 * investiga com as tools que precisar e "fala" com call.respond(texto) →
 * NOTIFY call_responses → whatsplay escuta → operator.sendText no ChatGPT →
 * a VOZ da chamada fala. Resposta via tool > parsing de JSON em texto.
 *
 * Contrato: { success, stdout } | { success:false, error }.
 */

function getPool() {
  // Mesmo padrão do luna-tools.cjs (pool lazy + loader de pg com candidatos —
  // o kernel não tem deps próprias fixas; pg vem do node_modules do dashboard).
  const g = globalThis;
  if (g.__lunaCallDbPool) return g.__lunaCallDbPool;
  const url = process.env.DATABASE_URL || process.env.LUNA_DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL não configurado no kernel (call.respond indisponível)');
  const candidates = [
    process.env.LUNA_KERNEL_PG_PATH,
    require('path').join(__dirname, '..', '..', 'apps', 'dashboard', 'node_modules', 'pg'),
    '/home/nexo/luna-kernel/apps/dashboard/node_modules/pg',
  ].filter(Boolean);
  let pg = null;
  for (const c of candidates) { try { pg = require(c); break; } catch { /* tenta o próximo */ } }
  if (!pg) throw new Error('módulo pg não encontrado nos caminhos candidatos');
  g.__lunaCallDbPool = new pg.Pool({ connectionString: url });
  return g.__lunaCallDbPool;
}

/**
 * call.respond — entrega um texto da Luna pro operador da chamada ativa.
 * args: { texto (obrigatório), origem (opcional, ex.: nome da sessão) }
 */
async function callRespond(params = {}) {
  try {
    const texto = String(params.texto || params.text || params.mensagem || '').trim();
    if (!texto) {
      return {
        success: false,
        error: 'call.respond: arg "texto" é obrigatório — callRespond {"texto": "resposta pra falar na chamada"}',
      };
    }
    const pool = getPool();
    const payload = JSON.stringify({
      texto,
      origem: String(params.origem || 'luna-web').slice(0, 80),
      at: new Date().toISOString(),
    });
    await pool.query('SELECT pg_notify($1, $2)', ['call_responses', payload]);
    return {
      success: true,
      stdout:
        `📞 call.respond: "${texto.slice(0, 120)}" enviado pro operador da chamada (NOTIFY call_responses). ` +
        'Continue: se o pedido do owner estiver completo, responda em texto normal; ' +
        'se precisar agir mais, use as tools e fale de novo via call.respond.',
    };
  } catch (e) {
    return { success: false, error: `call.respond: ${e.message}` };
  }
}

module.exports = { callRespond };
