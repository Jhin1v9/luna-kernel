/**
 * Slash Commands Registry for Luna Web
 * All commands starting with / are executed locally via luna-tools.cjs
 * without going through the Kimi Bridge.
 */

export const SLASH_COMMANDS = [
  // ── System ──
  { cmd: '/reiniciar',   desc: 'Reiniciar todos os servicos',        icon: '🔁', category: 'System', handler: 'systemRestart' },
  { cmd: '/status',      desc: 'Status dos servicos',                icon: '📊', category: 'System', handler: 'systemStatus' },
  { cmd: '/parar',       desc: 'Parar todos os servicos',            icon: '🛑', category: 'System', handler: 'systemStop' },
  { cmd: '/ligar',       desc: 'Iniciar todos os servicos',          icon: '▶️', category: 'System', handler: 'systemStart' },
  { cmd: '/health',      desc: 'Verificar saude do sistema',         icon: '💓', category: 'System', handler: 'systemHealth' },
  { cmd: '/logs',        desc: 'Ver ultimos logs',                   icon: '📜', category: 'System', handler: 'systemLogs' },
  { cmd: '/limpar',      desc: 'Limpar chat',                        icon: '🗑️', category: 'System', handler: 'clearChat' },
  { cmd: '/nova',        desc: 'Nova sessao',                        icon: '✨', category: 'System', handler: 'newSession' },
  { cmd: '/turnoff',     desc: 'Desligar agente (fecha Chrome)',     icon: '🌙', category: 'System', handler: 'turnOffAgent' },
  { cmd: '/ajuda',       desc: 'Mostrar ajuda',                      icon: '❓', category: 'System', handler: 'help' },
  { cmd: '/modo',        desc: 'Trocar modo (instant/thinking/agent/swarm)', icon: '⚡', category: 'System', handler: 'changeMode' },
  { cmd: '/refresh',     desc: 'Reconectar e limpar estado do agente', icon: '🔄', category: 'System', handler: 'refreshAgent' },
  { cmd: '/fullrefresh', desc: 'Refresh + continuar ultima acao',     icon: '🔁', category: 'System', handler: 'fullRefreshAgent' },

  // ── File Ops ──
  { cmd: '/read',        desc: 'Ler arquivo — /read path/to/file',   icon: '📖', category: 'File', handler: 'readFile' },
  { cmd: '/write',       desc: 'Escrever arquivo — /write path "conteudo"', icon: '✍️', category: 'File', handler: 'writeFile' },
  { cmd: '/append',      desc: 'Adicionar ao arquivo',               icon: '📎', category: 'File', handler: 'appendFile' },
  { cmd: '/replace',     desc: 'Substituir no arquivo',              icon: '🔧', category: 'File', handler: 'replaceInFile' },
  { cmd: '/delete',      desc: 'Deletar arquivo',                    icon: '🗑️', category: 'File', handler: 'deleteFile' },
  { cmd: '/move',        desc: 'Mover arquivo',                      icon: '📦', category: 'File', handler: 'moveFile' },
  { cmd: '/copy',        desc: 'Copiar arquivo',                     icon: '📋', category: 'File', handler: 'copyFile' },
  { cmd: '/ls',          desc: 'Listar diretorio',                   icon: '📂', category: 'File', handler: 'listFiles' },
  { cmd: '/mkdir',       desc: 'Criar diretorio',                    icon: '📁', category: 'File', handler: 'createDirectory' },
  { cmd: '/rmdir',       desc: 'Remover diretorio',                  icon: '🗑️', category: 'File', handler: 'removeDirectory' },
  { cmd: '/search',      desc: 'Buscar arquivos',                    icon: '🔍', category: 'File', handler: 'searchFiles' },
  { cmd: '/grep',        desc: 'Grep em arquivos',                   icon: '🔎', category: 'File', handler: 'grep' },

  // ── Shell ──
  { cmd: '/run',         desc: 'Executar comando shell',             icon: '💻', category: 'Shell', handler: 'executeShell' },
  { cmd: '/test',        desc: 'Rodar testes',                       icon: '🧪', category: 'Shell', handler: 'runTests' },
  { cmd: '/lint',        desc: 'Verificar sintaxe',                  icon: '🔍', category: 'Shell', handler: 'checkSyntax' },
  { cmd: '/install',     desc: 'Instalar pacotes',                   icon: '📦', category: 'Shell', handler: 'installPackages' },

  // ── Git ──
  { cmd: '/git-status',  desc: 'Git status',                         icon: '🌿', category: 'Git', handler: 'gitStatus' },
  { cmd: '/git-diff',    desc: 'Git diff',                           icon: '📊', category: 'Git', handler: 'gitDiff' },
  { cmd: '/git-log',     desc: 'Git log',                            icon: '📜', category: 'Git', handler: 'gitLog' },
  { cmd: '/git-commit',  desc: 'Git commit',                         icon: '💾', category: 'Git', handler: 'gitCommit' },

  // ── Web ──
  { cmd: '/web',         desc: 'Buscar na web',                      icon: '🌐', category: 'Web', handler: 'searchWeb' },
  { cmd: '/fetch',       desc: 'Fetch URL',                          icon: '📡', category: 'Web', handler: 'fetchURL' },
  { cmd: '/download',    desc: 'Download arquivo',                   icon: '⬇️', category: 'Web', handler: 'downloadFile' },

  // ── Dashboard — Tarefas ──
  { cmd: '/tarefa',      desc: 'Criar tarefa',                       icon: '📋', category: 'Dashboard', handler: 'dashboardCreateTask', modal: 'tasks' },
  { cmd: '/tarefas',     desc: 'Listar tarefas',                     icon: '📋', category: 'Dashboard', handler: 'dashboardListTasks', modal: 'tasks' },
  { cmd: '/tarefa-update', desc: 'Atualizar tarefa',                 icon: '✏️', category: 'Dashboard', handler: 'dashboardUpdateTask', modal: 'tasks' },
  { cmd: '/tarefa-done', desc: 'Completar tarefa',                   icon: '✅', category: 'Dashboard', handler: 'dashboardCompleteTask', modal: 'tasks' },

  // ── Dashboard — Leads ──
  { cmd: '/lead',        desc: 'Criar lead',                         icon: '👤', category: 'Dashboard', handler: 'dashboardCreateLead', modal: 'leads' },
  { cmd: '/leads',       desc: 'Listar leads',                       icon: '👥', category: 'Dashboard', handler: 'dashboardListLeads', modal: 'leads' },

  // ── Dashboard — Financeiro ──
  { cmd: '/caixa',       desc: 'Consultar caixa',                    icon: '💰', category: 'Dashboard', handler: 'dashboardGetCashBox', modal: 'finance' },
  { cmd: '/caixa-add',   desc: 'Adicionar entrada caixa',            icon: '💵', category: 'Dashboard', handler: 'dashboardAddCashEntry', modal: 'finance' },
  { cmd: '/caixa-hist',  desc: 'Historico caixa',                    icon: '📜', category: 'Dashboard', handler: 'dashboardListCashHistory', modal: 'finance' },
  { cmd: '/despesa',     desc: 'Criar despesa',                      icon: '💸', category: 'Dashboard', handler: 'dashboardCreateExpense', modal: 'finance' },
  { cmd: '/despesas',    desc: 'Listar despesas',                    icon: '📊', category: 'Dashboard', handler: 'dashboardListExpenses', modal: 'finance' },
  { cmd: '/pagamento',   desc: 'Criar pagamento',                    icon: '💳', category: 'Dashboard', handler: 'dashboardCreatePayment', modal: 'finance' },
  { cmd: '/pagamentos',  desc: 'Listar pagamentos',                  icon: '📋', category: 'Dashboard', handler: 'dashboardListPayments', modal: 'finance' },

  // ── Dashboard — Votacao ──
  { cmd: '/votacao',     desc: 'Listar votacoes',                    icon: '🗳️', category: 'Dashboard', handler: 'dashboardListVotingSessions', modal: 'voting' },
  { cmd: '/votacao-criar', desc: 'Criar votacao',                    icon: '➕', category: 'Dashboard', handler: 'dashboardCreateVotingSession', modal: 'voting' },

  // ── Dashboard — Ideias ──
  { cmd: '/ideia',       desc: 'Criar ideia',                        icon: '💡', category: 'Dashboard', handler: 'dashboardCreateIdea' },
  { cmd: '/ideias',      desc: 'Listar ideias',                      icon: '💡', category: 'Dashboard', handler: 'dashboardListIdeas' },

  // ── Dashboard — Links ──
  { cmd: '/link',        desc: 'Adicionar link',                     icon: '🔗', category: 'Dashboard', handler: 'dashboardAddLink' },
  { cmd: '/links',       desc: 'Listar links',                       icon: '🔗', category: 'Dashboard', handler: 'dashboardListLinks' },

  // ── Dashboard — Email ──
  { cmd: '/email',       desc: 'Enviar email',                       icon: '📧', category: 'Dashboard', handler: 'dashboardSendEmail' },
  { cmd: '/emails',      desc: 'Listar emails',                      icon: '📧', category: 'Dashboard', handler: 'dashboardListEmails' },

  // ── Dashboard — WhatsApp ──
  { cmd: '/whatsapp',    desc: 'Enviar WhatsApp',                    icon: '💬', category: 'Dashboard', handler: 'dashboardSendWhatsApp' },
  { cmd: '/whatsapp-status', desc: 'Status WhatsApp',                icon: '💬', category: 'Dashboard', handler: 'dashboardGetWhatsAppStatus' },

  // ── Dashboard — Sistema ──
  { cmd: '/notificacoes', desc: 'Listar notificacoes',               icon: '🔔', category: 'Dashboard', handler: 'dashboardListNotifications' },
  { cmd: '/usuarios',    desc: 'Listar usuarios',                    icon: '👥', category: 'Dashboard', handler: 'dashboardListUsers' },
  { cmd: '/projetos',    desc: 'Listar projetos',                    icon: '📁', category: 'Dashboard', handler: 'dashboardListProjects' },
  { cmd: '/clientes',    desc: 'Listar clientes',                    icon: '👤', category: 'Dashboard', handler: 'dashboardListClients' },
  { cmd: '/financeiro',  desc: 'Resumo financeiro',                  icon: '💹', category: 'Dashboard', handler: 'dashboardGetFinanceSummary', modal: 'finance' },
  { cmd: '/config',      desc: 'Configuracoes dashboard',            icon: '⚙️', category: 'Dashboard', handler: 'dashboardGetConfig' },

  // ── Agent Tools ──
  { cmd: '/plan',        desc: 'Modo Detetive — planejar antes de executar', icon: '🔍', category: 'Agent', handler: 'planMode' },
  { cmd: '/think',       desc: 'Modo raciocinio profundo',           icon: '🧠', category: 'Agent', handler: 'think' },
  { cmd: '/clipboard',   desc: 'Ler clipboard',                      icon: '📋', category: 'Agent', handler: 'clipboardRead' },
  { cmd: '/pwd',         desc: 'Diretorio atual',                    icon: '📁', category: 'Agent', handler: 'getCurrentDirectory' },
];

/**
 * Parse a slash command message into { command, args }
 * e.g. "/read /path/to/file" → { command: '/read', args: ['/path/to/file'] }
 * e.g. "/write file.txt hello world" → { command: '/write', args: ['file.txt', 'hello world'] }
 */
export function parseSlashCommand(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.split(/\s+/);
  const command = parts[0];
  const args = parts.slice(1);
  return { command, args, raw: trimmed };
}

/**
 * Check if text is a slash command
 */
export function isSlashCommand(text) {
  return typeof text === 'string' && text.trim().startsWith('/');
}
