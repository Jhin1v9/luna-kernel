// luna-tool-guard.cjs — Stub vazio (desativado)
module.exports = {
  ToolGuard: class {
    constructor() {}
    async execute(toolName, params, toolFn) { return await toolFn(); }
    recordChecksum() { return null; }
    async checkpoint() { return { success: true }; }
    async rollback() { return { success: true }; }
    async undo() { return { success: true }; }
    listCheckpoints() { return []; }
    reset() {}
  },
  CircuitBreaker: class {
    check() {}
    record() {}
    reset() {}
  },
  IdempotencyStore: class {
    generateKey() { return ''; }
    isProcessed() { return false; }
    markProcessed() {}
    clear() {}
  },
  FileChecksumCache: class {
    record() { return null; }
    verify() { return { ok: true }; }
    clear() {}
  },
  StepCheckpoint: class {
    async create() { return { success: true }; }
    async rollbackTo() { return { success: true }; }
    async undoLast() { return { success: true }; }
    list() { return []; }
  },
  withRetry: async (fn) => await fn(),
  withTimeout: async (promise) => await promise,
  validateToolCall: () => true,
  computeChecksum: () => null,
  TOOL_SCHEMAS: {},
  validatePythonCode: () => ({ ok: true }),
  checkDestructivePattern: () => null,
};
