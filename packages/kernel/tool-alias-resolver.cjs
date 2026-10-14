'use strict';
/**
 * Tool Alias Resolver — adapter de nomes de tools (2026-10-14).
 *
 * Problema que resolve: modelos de LLP inventam nomes de ferramentas
 * ("sendMessageWhatsApp", "read_file", "listTools" grafado de 10 jeitos).
 * Antes deste adapter, QUALQUER nome inventado caía no
 * "Ferramenta desconhecida" e a Luna ficava sem braços — mesmo a tool
 * real existindo (ex.: dashboardSendWhatsApp).
 *
 * Estratégia em camadas (conservadora, evita falso-positivo):
 *   1. Nome já é exportado em luna-tools.cjs → usa como está.
 *   2. Alias explícito (ALIAS_MAP, chaves normalizadas) → canônico.
 *   3. Match normalizado (lowercase + só alfanum) contra os exports.
 *   4. Contenção: nome é sufixo de exatamente UM export (ex.: "listTasks"
 *      → "dashboardListTasks") e tem ≥8 chars → aquele export.
 *      Ambíguo (0 ou 2+) → devolve o original (vira "desconhecida" como antes,
 *      mas o modelo recebe a dica de executar listTools).
 *
 * Retorna { tool, adaptedFrom } — adaptedFrom só preenchido quando houve
 * adaptação, para a Soul avisar o modelo ("tool X entendida como Y").
 */

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Alias explícitos (chaves JÁ normalizadas → nome canônico exportado).
const ALIAS_MAP = {
  // 💬 WhatsApp — o caso que motivou este adapter
  sendmessagewhatsapp: 'whatsappSendMessage',
  sendwhatsappmessage: 'whatsappSendMessage',
  sendmessagebywhatsapp: 'whatsappSendMessage',
  sendwhatsapmsg: 'whatsappSendMessage',
  sendzap: 'whatsappSendMessage',
  zapmessage: 'whatsappSendMessage',
  replywhatsapp: 'whatsappSendMessage',
  responderwhatsapp: 'whatsappSendMessage',
  enviarwhatsapp: 'whatsappSendMessage',
  enviarmensagem: 'whatsappSendMessage',
  enviarmsg: 'whatsappSendMessage',
  mandarmensagem: 'whatsappSendMessage',
  sendmessage: 'whatsappSendMessage',
  messagesendwhatsapp: 'whatsappSendMessage',
  sendwhatsappmsg: 'whatsappSendMessage',
  solicitacoes: 'workspaceListRequests',
  pedidos: 'workspaceListRequests',
  solicitacao: 'workspaceListRequests',
  sendmsg: 'whatsappSendMessage',
    // 🟢 diretório & onboarding (2026-10-14)
    listarcontatos: 'whatsappListContacts',
    contatos: 'whatsappListContacts',
    contatoswhatsapp: 'whatsappListContacts',
    listargrupos: 'whatsappListGroups',
    grupos: 'whatsappListGroups',
    gruposwhatsapp: 'whatsappListGroups',
    membrosgrupo: 'whatsappGroupMembers',
    addcontato: 'whatsappAllowContact',
    novocontato: 'whatsappAllowContact',
    cadastrarcontato: 'whatsappAllowContact',
    allowcontact: 'whatsappAllowContact',
  // 📧 Email
  sendemail: 'dashboardSendEmail',
  enviaremail: 'dashboardSendEmail',
  // 🧠 Brain
  searchbrain: 'brainSearch',
  procurarnobrain: 'brainSearch',
  readbrain: 'brainRead',
  saveoutcome: 'brainSaveOutcome',
  savelearning: 'brainSaveOutcome',
  // 🗂️ Meta-tools (modelos tentam de vários jeitos)
  listtools: 'listTools',
  showtools: 'listTools',
  mytools: 'listTools',
  availabletools: 'listTools',
  toolslist: 'listTools',
  gettools: 'listTools',
  verferramentas: 'listTools',
  listarferramentas: 'listTools',
  ferramentas: 'listTools',
  toolinfo: 'toolInfo',
  tooldetails: 'toolInfo',
  describetool: 'toolInfo',
  infotool: 'toolInfo',
  detalhesdatool: 'toolInfo',
  // 🖥️ Shell / execução
  shell: 'executeShell',
  runcommand: 'executeShell',
  runcmd: 'executeShell',
  terminal: 'executeShell',
  executarcomando: 'executeShell',
  executecmd: 'executeShell',
  // 🐍 Python (caso especial no dispatch da Soul — não é export de luna-tools)
  python: 'ipython',
  runpython: 'ipython',
  executepython: 'ipython',
  runpy: 'ipython',
  // 📁 Arquivos — variantes que o normalizador não pega
  createfile: 'writeFile',
  editfile: 'replaceInFile',
  updatefile: 'replaceInFile',
  replacefile: 'replaceInFile',
  strreplace: 'replaceInFile',
  ls: 'listFiles',
  listdir: 'viewDirectory',
  viewdir: 'viewDirectory',
  findfiles: 'searchFiles',
  findfile: 'searchFiles',
  filesearch: 'searchFiles',
  openurl: 'fetchURL',
  getpage: 'fetchURL',
  readmedia: 'readMediaFile',
  viewimage: 'readMediaFile',
  fsread: 'readFile',
  fswrite: 'writeFile',
  fslist: 'listFiles',
  fsgrep: 'grep',
  // 🌐 Web
  google: 'searchWeb',
  websearch: 'searchWeb',
  internetsearch: 'searchWeb',
  pesquisarweb: 'searchWeb',
  browse: 'fetchURL',
};

// Ferramentas especiais que a Soul trata fora do switch de luna-tools
// (não são exports de luna-tools.cjs mas são válidas no dispatch).
const SPECIAL_TOOLS = new Set(['ipython', 'browser', 'computer', 'dashboardCommandRouter']);

let EXPORT_CACHE = null;
function exportedToolSet() {
  if (!EXPORT_CACHE) {
    try {
      EXPORT_CACHE = new Set(Object.keys(require('./luna-tools.cjs')));
    } catch (e) {
      console.warn('[ToolAlias] falha ao carregar luna-tools.cjs:', e.message);
      EXPORT_CACHE = new Set();
    }
  }
  return EXPORT_CACHE;
}

function resolveToolName(name) {
  const original = String(name || '').trim();
  if (!original) return { tool: original, adaptedFrom: null };

  const exportsSet = exportedToolSet();

  // 1) exato
  if (exportsSet.has(original) || SPECIAL_TOOLS.has(original)) {
    return { tool: original, adaptedFrom: null };
  }

  const n = norm(original);

  // 2) alias explícito
  if (ALIASES_HAS(n)) {
    const canonical = ALIAS_MAP[n];
    console.warn(`[ToolAlias] alias explícito: '${original}' → '${canonical}'`);
    return { tool: canonical, adaptedFrom: original };
  }

  // 3) match normalizado contra exports e speciais
  for (const e of exportsSet) {
    if (norm(e) === n) {
      console.warn(`[ToolAlias] match normalizado: '${original}' → '${e}'`);
      return { tool: e, adaptedFrom: original };
    }
  }
  for (const e of SPECIAL_TOOLS) {
    if (norm(e) === n) return { tool: e, adaptedFrom: original };
  }

  // 4) contenção: sufixo de exatamente um export (>=8 chars, sem ambiguidade)
  if (n.length >= 8) {
    const candidates = [];
    for (const e of exportsSet) {
      const ne = norm(e);
      if (ne.length >= 10 && (ne.includes(n) || n.includes(ne))) {
        candidates.push(e);
      }
    }
    if (candidates.length === 1) {
      console.warn(`[ToolAlias] contenção única: '${original}' → '${candidates[0]}'`);
      return { tool: candidates[0], adaptedFrom: original };
    }
    if (candidates.length > 1) {
      // desempata pelo mais curto; empate real = ambíguo, não adapta
      candidates.sort((a, b) => a.length - b.length);
      if (candidates[0].length < candidates[1].length) {
        console.warn(`[ToolAlias] contenção (desempate): '${original}' → '${candidates[0]}'`);
        return { tool: candidates[0], adaptedFrom: original };
      }
      console.warn(`[ToolAlias] ambíguo, sem adaptação: '${original}' (${candidates.length} candidatos)`);
    }
  }

  return { tool: original, adaptedFrom: null };
}

function ALIASES_HAS(n) {
  return Object.prototype.hasOwnProperty.call(ALIAS_MAP, n);
}

module.exports = { resolveToolName, norm };
