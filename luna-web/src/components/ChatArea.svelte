<script>
  import { onMount, onDestroy, tick } from 'svelte';
  import { isStreaming, currentMode, messages, sessions, currentSessionId, planModeState, mascotState, mascotMessage } from '../stores.js';
  import { sendMessage, cancelStream, SSEManager, fetchSessionMessages, sessionAction, startPlanMode, approvePlan, rejectPlan, submitRevision, systemRestart, systemStop, systemStart, systemStatus, systemHealth, systemLogs, executeLunaTool } from '../api.js';
  import { SLASH_COMMANDS, isSlashCommand } from '../lib/slashCommands.js';
  import { playSound } from '../sound.js';
  import ChatHeader from './ChatHeader.svelte';
  import MessagesList from './MessagesList.svelte';
  import ChatInput from './ChatInput.svelte';

  export let sessionId = null;

  let sseManager = new SSEManager();
  let currentAssistantId = null;
  let thinkingId = null;
  let lastConnectedSessionId = null;
  let toolStartTimes = new Map(); // toolName -> startTimestamp
  let processedEventIds = new Set(); // v4.2: Track processed SSE event IDs to prevent duplicates

  function removeAllThinking(msgs) {
    return msgs.filter(m => m.type !== 'thinking');
  }

  function getEventHash(event) {
    // v4.2: Create a unique hash for an event based on its properties
    const type = event.type || '';
    const text = event.text || event.content || event.fullResponse || '';
    const tool = event.tool || '';
    const id = event.id || '';
    // Use first 100 chars of text + type + tool to create a simple hash
    const raw = `${type}:${tool}:${id}:${text.slice(0, 100)}`;
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return String(hash);
  }

  function handleEvent(event) {
    if (!event) return;
    if (event.sessionId && event.sessionId !== sessionId) return;

    // v4.2-fix: Deduplicate by event hash — prevents duplicate rendering on reconnects
    const eventHash = getEventHash(event);
    if (processedEventIds.has(eventHash)) {
      return;
    }
    processedEventIds.add(eventHash);
    // Limit set size to prevent memory leaks
    if (processedEventIds.size > 1000) {
      const iter = processedEventIds.values();
      processedEventIds.delete(iter.next().value);
    }

    // v4.0-debug: Log every SSE event for debugging
    console.log('[SSE]', event.type, event.text ? event.text.substring(0, 80) : '', event.tool || '');

    // v3.6-fix: Also deduplicate by backend event ID
    if (event.id) {
      const exists = $messages.some(m => m.id === event.id);
      if (exists) return;
    }

    const { type } = event;

    switch (type) {
      case 'user': {
        // v3.6-fix: Handle user messages from SSE history sync
        messages.update(msgs => {
          // Avoid duplicates by ID
          if (msgs.some(m => m.id === event.id)) return msgs;
          // Avoid duplicates by content (same message sent locally + via SSE)
          const content = event.content || event.text || '';
          const recentDuplicate = msgs.some(m =>
            m.type === 'user' &&
            m.content === content &&
            Date.now() - new Date(m.timestamp).getTime() < 5000
          );
          if (recentDuplicate) return msgs;
          return [...msgs, {
            id: event.id || 'user-' + Date.now(),
            type: 'user',
            content: content,
            files: event.files || [],
            timestamp: event.timestamp || new Date().toISOString()
          }];
        });
        break;
      }
      case 'thinking_start': {
        playSound('thinkingStart');
        mascotState.set('thinking');
        mascotMessage.set('Hmm... deixa eu pensar...');
        messages.update(msgs => {
          // v4.0-fix: If there's already an active thinking bubble, reuse it
          const existingThink = msgs.find(m => m.type === 'thinking');
          if (existingThink) {
            thinkingId = existingThink.id;
            return msgs;
          }
          const cleaned = removeAllThinking(msgs);
          const newId = 'think-' + Date.now();
          thinkingId = newId;
          return [...cleaned, {
            id: newId,
            type: 'thinking',
            content: '',
            timestamp: new Date().toISOString()
          }];
        });
        break;
      }
      case 'thinking_delta': {
        if (thinkingId) {
          messages.update(msgs =>
            msgs.map(m => {
              if (m.id !== thinkingId) return m;
              const newText = event.text || '';
              const current = m.content || '';
              // v4.2-fix: If delta looks like full replacement (larger than current + 50%),
              // replace instead of append to avoid repetition on DOM shrink
              if (newText.length > current.length * 1.5 && newText.includes(current.slice(0, 20))) {
                return { ...m, content: newText };
              }
              return { ...m, content: current + newText };
            })
          );
        }
        break;
      }
      case 'response_delta': {
        playSound('messageReceived');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;

        if (!currentAssistantId) {
          currentAssistantId = 'resp-' + Date.now();
          messages.update(msgs => [...msgs, {
            id: currentAssistantId,
            type: 'assistant',
            content: event.text || '',
            timestamp: new Date().toISOString()
          }]);
        } else {
          messages.update(msgs =>
            msgs.map(m => m.id === currentAssistantId ? { ...m, content: m.content + (event.text || '') } : m)
          );
        }
        break;
      }
      case 'action_start': {
        mascotState.set('working');
        mascotMessage.set(event.tool ? `Usando ${event.tool}...` : 'Trabalhando...');
        const toolId = 'tool-' + Date.now();
        toolStartTimes.set(event.tool, Date.now());
        messages.update(msgs => [...msgs, {
          id: toolId,
          type: 'tool',
          tool: event.tool,
          params: event.params || {},
          result: null,
          duration: 0,
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'action_end': {
        playSound('toolComplete');
        mascotState.set('idle');
        mascotMessage.set('Prontinho!');
        // Calculate duration locally if backend doesn't send it
        const startTime = toolStartTimes.get(event.tool);
        let duration = event.duration;
        if (!duration && startTime) {
          duration = (Date.now() - startTime) / 1000; // seconds
        }
        toolStartTimes.delete(event.tool);
        messages.update(msgs => {
          const toolMsgs = msgs.filter(m => m.type === 'tool' && m.tool === event.tool && !m.result);
          const lastTool = toolMsgs[toolMsgs.length - 1];
          if (lastTool) {
            return msgs.map(m =>
              m.id === lastTool.id
                ? { ...m, result: event.result, duration: duration || 0 }
                : m
            );
          }
          return msgs;
        });
        break;
      }
      case 'response_done': {
        if (currentAssistantId && event.response) {
          messages.update(msgs =>
            msgs.map(m => m.id === currentAssistantId ? { ...m, content: event.response } : m)
          );
        }
        currentAssistantId = null;
        break;
      }
      case 'done': {
        mascotState.set('idle');
        mascotMessage.set('O que mais posso fazer?');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        const finalResponse = event.result?.response || event.response || event.text;
        console.log('[done] finalResponse length:', finalResponse?.length, 'content:', finalResponse?.substring(0, 100));
        if (finalResponse && !currentAssistantId) {
          messages.update(msgs => [...msgs, {
            id: 'resp-' + Date.now(),
            type: 'assistant',
            content: finalResponse,
            timestamp: new Date().toISOString()
          }]);
        } else if (finalResponse && currentAssistantId) {
          messages.update(msgs =>
            msgs.map(m => m.id === currentAssistantId ? { ...m, content: finalResponse } : m)
          );
        }
        isStreaming.set(false);
        currentAssistantId = null;
        break;
      }
      case 'login_required': {
        playSound('error');
        mascotState.set('idle');
        mascotMessage.set('Precisa fazer login primeiro!');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        messages.update(msgs => [...msgs, {
          id: 'login-' + Date.now(),
          type: 'login_required',
          content: event.message || '🔐 Você precisa logar primeiro no Kimi Web.',
          timestamp: new Date().toISOString()
        }]);
        isStreaming.set(false);
        break;
      }
      case 'error': {
        playSound('error');
        mascotState.set('idle');
        mascotMessage.set('Ops, algo deu errado...');
        messages.update(msgs => removeAllThinking(msgs));
        thinkingId = null;
        messages.update(msgs => [...msgs, {
          id: 'err-' + Date.now(),
          type: 'error',
          content: event.error || event.message || event.text || 'Erro desconhecido',
          timestamp: new Date().toISOString()
        }]);
        isStreaming.set(false);
        break;
      }
      case 'warning':
      case 'system': {
        messages.update(msgs => [...msgs, {
          id: (type === 'warning' ? 'warn-' : 'sys-') + Date.now(),
          type: 'system',
          content: event.message || '',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'mode_detected': {
        if (event.mode) currentMode.set(event.mode);
        break;
      }
      case 'compact_start':
      case 'compact_end':
      case 'plan_error':
      case 'plan_complete': {
        messages.update(msgs => [...msgs, {
          id: 'plan-' + Date.now(),
          type: 'system',
          content: event.message || `${type}`,
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_start': {
        planModeState.update(s => ({ ...s, active: true, status: 'investigating', sessionId }));
        messages.update(msgs => [...msgs, {
          id: 'plan-start-' + Date.now(),
          type: 'system',
          content: event.message || 'Modo Detetive ativado',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_delta': {
        // Plan text streaming — update or create plan message
        planModeState.update(s => ({ ...s, active: true, status: 'investigating' }));
        messages.update(msgs => {
          const lastPlan = msgs.findLast(m => m.type === 'plan');
          if (lastPlan && !lastPlan.isComplete) {
            return msgs.map(m => m.id === lastPlan.id ? { ...m, content: (m.content || '') + (event.text || '') } : m);
          }
          return [...msgs, {
            id: 'plan-delta-' + Date.now(),
            type: 'plan',
            content: event.text || '',
            isComplete: false,
            timestamp: new Date().toISOString()
          }];
        });
        break;
      }
      case 'plan_display':
      case 'plan_awaiting_approval': {
        planModeState.update(s => ({ ...s, active: true, status: 'awaiting_approval', plan: event.plan, planPath: event.planPath, sessionId }));
        messages.update(msgs => {
          // Remove incomplete plan deltas
          const cleaned = msgs.filter(m => !(m.type === 'plan' && !m.isComplete));
          return [...cleaned, {
            id: 'plan-' + Date.now(),
            type: 'plan',
            content: event.plan || '',
            planPath: event.planPath,
            isComplete: true,
            status: 'awaiting_approval',
            timestamp: new Date().toISOString()
          }];
        });
        break;
      }
      case 'plan_approved': {
        planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null, planPath: null }));
        messages.update(msgs => [...msgs, {
          id: 'plan-approved-' + Date.now(),
          type: 'system',
          content: 'Plano aprovado! Iniciando execução...',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_rejected': {
        planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null, planPath: null }));
        messages.update(msgs => [...msgs, {
          id: 'plan-rejected-' + Date.now(),
          type: 'system',
          content: 'Plano rejeitado. Investigação encerrada.',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
      case 'plan_revised': {
        planModeState.update(s => ({ ...s, active: true, status: 'awaiting_approval', plan: event.plan, planPath: event.planPath }));
        messages.update(msgs => [...msgs, {
          id: 'plan-revised-' + Date.now(),
          type: 'plan',
          content: event.plan || '',
          planPath: event.planPath,
          isComplete: true,
          status: 'awaiting_approval',
          timestamp: new Date().toISOString()
        }]);
        break;
      }
    }
  }

  async function connectSSE() {
    if (!sessionId) return;
    // NAO reconecta se ja esta conectado na mesma sessao
    if (lastConnectedSessionId === sessionId && sseManager.eventSource) return;

    // v4.0-fix: Do NOT reload history while streaming is active — prevents overwriting current state
    if ($isStreaming) {
      console.log('[connectSSE] Skipping history reload while streaming is active');
      return;
    }

    currentAssistantId = null;
    thinkingId = null;
    processedEventIds.clear(); // v4.2: Clear dedup set on reconnect
    sseManager.disconnect();
    sseManager = new SSEManager();

    // v3.6-fix: Load full message history from backend instead of clearing
    try {
      const history = await fetchSessionMessages(sessionId);
      if (history.ok && history.messages) {
        const loaded = [];
        let currentAssistantContent = '';
        let currentThinkingContent = '';
        let currentThinkingId = null;
        for (const msg of history.messages) {
          if (msg.role === 'user') {
            loaded.push({
              id: msg.id || 'msg-' + Math.random().toString(36).slice(2),
              type: 'user',
              content: msg.content || '',
              files: msg.files || [],
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'thinking_start') {
            currentThinkingContent = '';
            currentThinkingId = 'think-' + Math.random().toString(36).slice(2);
            loaded.push({
              id: currentThinkingId,
              type: 'thinking',
              content: '',
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'thinking_delta') {
            currentThinkingContent = msg.fullThinking || msg.text || currentThinkingContent;
            if (currentThinkingId) {
              const thinkMsg = loaded.find(m => m.id === currentThinkingId);
              if (thinkMsg) thinkMsg.content = currentThinkingContent;
            }
          } else if (msg.type === 'response_delta' && msg.content) {
            // Remove thinking when response starts
            if (currentThinkingId) {
              const idx = loaded.findIndex(m => m.id === currentThinkingId);
              if (idx !== -1) loaded.splice(idx, 1);
              currentThinkingId = null;
            }
            currentAssistantContent = msg.content;
          } else if (msg.type === 'done') {
            // Remove any leftover thinking
            if (currentThinkingId) {
              const idx = loaded.findIndex(m => m.id === currentThinkingId);
              if (idx !== -1) loaded.splice(idx, 1);
              currentThinkingId = null;
            }
            const finalText = msg.result?.response || msg.content || currentAssistantContent || '';
            if (finalText) {
              loaded.push({
                id: msg.id || 'resp-' + Math.random().toString(36).slice(2),
                type: 'assistant',
                content: finalText,
                timestamp: msg.timestamp || new Date().toISOString(),
              });
            }
            currentAssistantContent = '';
            currentThinkingContent = '';
          } else if (msg.type === 'error') {
            loaded.push({
              id: msg.id || 'err-' + Math.random().toString(36).slice(2),
              type: 'error',
              content: msg.content || 'Erro desconhecido',
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'action_start' && msg.tool) {
            loaded.push({
              id: msg.id || 'tool-' + Math.random().toString(36).slice(2),
              type: 'tool',
              tool: msg.tool,
              params: msg.params || {},
              result: null,
              timestamp: msg.timestamp || new Date().toISOString(),
            });
          } else if (msg.type === 'action_end' && msg.result) {
            const lastTool = loaded.slice().reverse().find(m => m.type === 'tool' && !m.result);
            if (lastTool) {
              lastTool.result = msg.result;
            }
          }
        }
        // v4.0-fix: Sort by timestamp to ensure chronological order
        loaded.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        messages.set(loaded);
      } else {
        messages.set([]);
      }
    } catch (e) {
      console.error('Failed to load session history:', e);
      messages.set([]);
    }

    sseManager.connect(sessionId, handleEvent);
    lastConnectedSessionId = sessionId;
  }

  $: if (sessionId && sessionId !== lastConnectedSessionId) {
    connectSSE();
  }

  onMount(() => {
    if (sessionId && sessionId !== lastConnectedSessionId) {
      connectSSE();
    }
  });

  async function handleSend(msg, files) {
    if (!msg.trim()) return;

    // v4.2-fix: Reset dedup tracking for new message
    processedEventIds.clear();

    // v3.7-fix: Auto-create session if none exists
    let activeSessionId = sessionId;
    if (!activeSessionId) {
      try {
        const res = await sessionAction('create', null, msg.slice(0, 40));
        if (res.ok && res.session) {
          activeSessionId = res.session.id;
          // v3.7-fix: Update stores so the session appears in sidebar immediately
          const newSession = { ...res.session, updatedAt: new Date().toISOString() };
          sessions.update(s => [newSession, ...s]);
          currentSessionId.set(res.session.id);
        } else {
          messages.update(msgs => [...msgs, {
            id: 'err-' + Date.now(),
            type: 'error',
            content: 'Falha ao criar sessão',
            timestamp: new Date().toISOString()
          }]);
          return;
        }
      } catch (e) {
        console.error('Create session error:', e);
        messages.update(msgs => [...msgs, {
          id: 'err-' + Date.now(),
          type: 'error',
          content: 'Falha ao criar sessão: ' + e.message,
          timestamp: new Date().toISOString()
        }]);
        return;
      }
    }

    // v3.6-fix: Reset assistant tracking before sending new message
    currentAssistantId = null;
    thinkingId = null;

    // v4.0-fix: Remove all previous thinking bubbles when sending a new message
    messages.update(msgs => removeAllThinking(msgs));

    const userMsg = {
      id: 'user-' + Date.now(),
      type: 'user',
      content: msg,
      files: files || [],
      timestamp: new Date().toISOString()
    };
    messages.update(msgs => [...msgs, userMsg]);
    isStreaming.set(true);

    try {
      playSound('messageSent');

      // v5.0: Slash commands — ALL messages starting with / go to Luna directly, NOT Kimi
      if (isSlashCommand(msg)) {
        const cmd = msg.split(' ')[0];
        const args = msg.split(' ').slice(1);
        const slashDef = SLASH_COMMANDS.find(c => c.cmd === cmd);

        if (!slashDef) {
          isStreaming.set(false);
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: `❌ Comando desconhecido: ${cmd}. Digite / para ver os comandos disponiveis.`,
            timestamp: new Date().toISOString()
          }]);
          return;
        }

        let result = null;

        // System handlers (frontend APIs)
        if (['systemRestart', 'systemStatus', 'systemStop', 'systemStart', 'systemHealth', 'systemLogs'].includes(slashDef.handler)) {
          switch (slashDef.handler) {
            case 'systemRestart': result = await systemRestart(); break;
            case 'systemStatus': result = await systemStatus(); break;
            case 'systemStop': result = await systemStop(); break;
            case 'systemStart': result = await systemStart(); break;
            case 'systemHealth': result = await systemHealth(); break;
            case 'systemLogs': result = await systemLogs(); break;
          }
        }
        // Frontend-only handlers
        else if (slashDef.handler === 'clearChat') {
          messages.set([]);
          isStreaming.set(false);
          return;
        }
        else if (slashDef.handler === 'newSession') {
          isStreaming.set(false);
          currentSessionId.set(null);
          messages.set([]);
          return;
        }
        else if (slashDef.handler === 'help') {
          isStreaming.set(false);
          const helpText = SLASH_COMMANDS.map(c => `${c.cmd} — ${c.desc}`).join('\n');
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: '📖 Comandos disponiveis:\n\n' + helpText,
            timestamp: new Date().toISOString()
          }]);
          return;
        }
        else if (slashDef.handler === 'changeMode') {
          isStreaming.set(false);
          const mode = args[0];
          if (['instant', 'thinking', 'agent', 'swarm'].includes(mode)) {
            currentMode.set(mode);
            messages.update(msgs => [...msgs, {
              id: 'sys-' + Date.now(),
              type: 'system',
              content: `⚡ Modo alterado para: ${mode}`,
              timestamp: new Date().toISOString()
            }]);
          } else {
            messages.update(msgs => [...msgs, {
              id: 'sys-' + Date.now(),
              type: 'system',
              content: '⚡ Modos disponiveis: instant, thinking, agent, swarm',
              timestamp: new Date().toISOString()
            }]);
          }
          return;
        }
        // Plan mode
        else if (slashDef.handler === 'planMode') {
          if ($isStreaming || $planModeState.status === 'processing') {
            console.log('[handleSend] Plan mode already processing, ignoring duplicate');
            isStreaming.set(false);
            return;
          }
          const planMsg = args.join(' ');
          planModeState.update(s => ({ ...s, status: 'processing' }));
          await startPlanMode(planMsg, activeSessionId);
          return;
        }
        // All other tools — execute via luna-tools.cjs backend
        else {
          // Map args to params based on tool type
          let params = {};
          if (args.length > 0) {
            if (['readFile', 'deleteFile', 'getFileInfo', 'listFiles', 'viewDirectory', 'createDirectory', 'removeDirectory', 'gitStatus', 'gitDiff', 'gitLog', 'executeShell', 'runTests', 'checkSyntax', 'installPackages', 'searchWeb', 'downloadFile', 'getCurrentDirectory'].includes(slashDef.handler)) {
              params = args.length === 1 ? args[0] : args;
            } else if (['writeFile', 'appendFile'].includes(slashDef.handler)) {
              params = { filePath: args[0], content: args.slice(1).join(' ') };
            } else if (['moveFile', 'copyFile'].includes(slashDef.handler)) {
              params = { source: args[0], destination: args[1] };
            } else if (['replaceInFile'].includes(slashDef.handler)) {
              params = { filePath: args[0], search: args[1], replacement: args.slice(2).join(' ') };
            } else if (['grep', 'searchFiles'].includes(slashDef.handler)) {
              params = { pattern: args[0], path: args[1] || '.' };
            } else if (['fetchURL'].includes(slashDef.handler)) {
              params = { url: args[0] };
            } else if (['clipboardRead', 'clipboardWrite'].includes(slashDef.handler)) {
              params = args.length > 0 ? args.join(' ') : undefined;
            } else {
              // Dashboard tools — pass as object with positional args
              params = args.length === 1 ? args[0] : Object.fromEntries(args.map((a, i) => [`arg${i}`, a]));
            }
          }
          result = await executeLunaTool(slashDef.handler, params);
        }

        isStreaming.set(false);
        if (result) {
          const content = result.ok
            ? (result.message || result.output || result.result?.stdout || result.result?.output || JSON.stringify(result.result || result, null, 2))
            : (result.error || 'Erro desconhecido');
          messages.update(msgs => [...msgs, {
            id: 'sys-' + Date.now(),
            type: 'system',
            content: content.slice(0, 4000),
            timestamp: new Date().toISOString()
          }]);
        }
      } else if ($planModeState.active) {
        // v4.2-fix: Prevent double plan submission
        if ($isStreaming || $planModeState.status === 'processing') {
          console.log('[handleSend] Plan mode already processing, ignoring duplicate');
          return;
        }
        const planMsg = msg.startsWith('/plan') ? msg.slice(5).trim() : msg;
        planModeState.update(s => ({ ...s, status: 'processing' }));
        await startPlanMode(planMsg, activeSessionId);
      } else {
        await sendMessage(msg, activeSessionId, $currentMode, files);
      }
    } catch (e) {
      console.error('Send error:', e);
      isStreaming.set(false);
      messages.update(msgs => [...msgs, {
        id: 'err-' + Date.now(),
        type: 'error',
        content: 'Falha ao enviar mensagem: ' + e.message,
        timestamp: new Date().toISOString()
      }]);
    }
  }

  async function handleCancel() {
    if (sessionId) {
      await cancelStream(sessionId);
      isStreaming.set(false);
    }
  }

  async function handleApprovePlan() {
    if (!sessionId) return;
    try {
      await approvePlan(sessionId);
      planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null }));
    } catch (e) {
      console.error('Approve plan error:', e);
    }
  }

  async function handleRejectPlan() {
    if (!sessionId) return;
    try {
      await rejectPlan(sessionId);
      planModeState.update(s => ({ ...s, active: false, status: 'idle', plan: null }));
    } catch (e) {
      console.error('Reject plan error:', e);
    }
  }

  async function handleRevisePlan(revisedPlan) {
    if (!sessionId) return;
    try {
      await submitRevision(sessionId, revisedPlan);
    } catch (e) {
      console.error('Revise plan error:', e);
    }
  }

  function handleClear() {
    messages.set([]);
  }

  function handleExport() {
    const msgs = $messages;
    const content = msgs.map(m => {
      const role = m.type === 'user' ? 'Usuario' : m.type === 'assistant' ? 'Luna' : 'Sistema';
      return `[${role}] ${m.content || ''}`;
    }).join('\n\n---\n\n');
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `luna-chat-${sessionId || 'export'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  onDestroy(() => {
    sseManager.disconnect();
    mascotState.set('sleep');
  });
</script>

<div class="chat-area">
  <ChatHeader
    title={$messages.find(m => m.type === 'user')?.content?.slice(0, 50) || 'Nova Conversa'}
    mode={$currentMode}
    isStreaming={$isStreaming}
    on:modeChange={(e) => currentMode.set(e.detail)}
    on:clear={handleClear}
    on:export={handleExport}
  />

  <MessagesList
    messages={$messages}
    onApprovePlan={handleApprovePlan}
    onRejectPlan={handleRejectPlan}
    onRevisePlan={handleRevisePlan}
  />

  <ChatInput
    onSend={handleSend}
    onCancel={handleCancel}
    disabled={$isStreaming}
  />
</div>

<style>
  .chat-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    position: relative;
  }
</style>
