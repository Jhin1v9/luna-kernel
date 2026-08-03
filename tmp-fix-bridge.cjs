const fs = require('fs');
const file = 'packages/kernel/kimi-bridge.cjs';
let data = fs.readFileSync(file, 'utf8');

const oldSection = `    // v10.36-fix: ALWAYS try to reuse an existing logged-in provider page first.
    // Each Luna Web session gets a different userId ('web-<sessionId>'), but the
    // user expects every Kimi/DeepSeek session to share the same Chrome tab that
    // is already logged in. We pick the best candidate (real /chat/ thread beats
    // landing page) and reassign it to the current userId.
    const candidatePages = [];
    const existingPages = this.defaultContext?.pages() || [];
    for (const p of existingPages) {
      if (p.isClosed()) continue;
      try {
        const url = p.url();
        if (url && url.includes(providerDomain)) {
          const isChatThread = url.includes('/chat/');
          candidatePages.push({ p, url, isChatThread, score: isChatThread ? 2 : 1 });
        }
      } catch (e) {
        // Page may be closing, skip
      }
    }

    const stored = this.store.getUser(userId);
    const storedChatUrl = stored?.chatUrl || null;

    if (candidatePages.length > 0) {
      // v10.39-fix: Honor the persisted chat URL for this Luna session.
      // Each Luna Web session is linked to a specific Kimi chat URL; if the user
      // (or browser) closed the tab, we must return to that exact conversation,
      // not reuse whatever other Kimi tab happens to be open.
      const targetChatId = storedChatUrl?.includes('/chat/')
        ? storedChatUrl.split('/chat/')[1].split('?')[0]
        : null;

      let best = null;
      if (targetChatId) {
        best = candidatePages.find((c) => c.url.includes(\`/chat/\${targetChatId}\`)) || null;
      }
      if (!best) {
        candidatePages.sort((a, b) => b.score - a.score);
        best = candidatePages[0];
      }

      const p = best.p;
      const url = best.url;
      p._lunaUserId = userId;
      p._lunaProvider = provider;

      const session = {
        page: p,
        context: this.defaultContext,
        chatUrl: storedChatUrl || url,
        provider,
        lastActivity: Date.now(),
        processing: false,
        mode: stored?.mode || 'instant',
      sessionSaved: false,
      };
      this.userSessions.set(userId, session);

      // If we reused a page that is not on the saved thread, navigate to it.
      if (storedChatUrl && !url.includes(storedChatUrl.split('?')[0].split('/').pop())) {
        log.info(\`Session \${hashUserId(userId)} has saved chat \${storedChatUrl}; current tab is \${url} — navigating to saved chat\`);
        await p.goto(storedChatUrl, { waitUntil: 'domcontentloaded', timeout: 0 });
        await p.waitForTimeout(1500);
        session.chatUrl = p.url();
      } else {
        log.info(\`Reusing existing \${providerDomain} page for user \${hashUserId(userId)}: \${url}\`);
      }

      this._saveChatUrl(userId, session.chatUrl, { mode: session.mode, provider });
      // v10.27-fix: Do NOT inject master localStorage into an already-open,
      // already-logged-in page — it can overwrite valid tokens and log the user out.
      // Only inject when we create a fresh page/context.
      return p;
    }

    // Acquire semaphore slot (now effectively unlimited)
    log.info(\`Acquiring slot for user \${hashUserId(userId)} (\${this.semaphore.current}/\${this.maxPages})\`);
    await this.semaphore.acquire();

    // Get or create isolated context for this user
    const userCtx = await this._getOrCreateUserContext(userId);

    // Restore previous chat URL from store if available
    const chatUrl = storedChatUrl || this._modeUrl(provider, 'instant');`;

const newSection = `    // v2.6.8-fix: Each Luna Web session is a distinct user ('web-<sessionId>') and
    // must talk in its own provider chat thread. Sharing a single Chrome tab across
    // sessions caused messages from different users/chats to land in the same Kimi
    // thread. We now reuse a page ONLY when it already belongs to the same userId
    // AND is on the persisted chat URL; otherwise we create a dedicated page.
    const stored = this.store.getUser(userId);
    const storedChatUrl = stored?.chatUrl || null;
    const targetChatId = storedChatUrl?.includes('/chat/')
      ? storedChatUrl.split('/chat/')[1].split('?')[0]
      : null;

    const existingPages = this.defaultContext?.pages() || [];
    const ownPages = [];
    const otherUserActivePages = [];
    for (const p of existingPages) {
      if (p.isClosed()) continue;
      try {
        const url = p.url();
        if (!url || !url.includes(providerDomain)) continue;
        const pageUserId = p._lunaUserId;
        if (pageUserId && pageUserId !== userId) {
          // Mark pages owned by another user so we never steal them.
          const otherSession = this.userSessions.get(pageUserId);
          const isActive = otherSession && (otherSession.processing || (Date.now() - otherSession.lastActivity) < 30 * 60 * 1000);
          otherUserActivePages.push({ p, url, userId: pageUserId, active: isActive });
          continue;
        }
        // Same userId or unassigned page.
        const isChatThread = url.includes('/chat/');
        const matchesTarget = targetChatId ? url.includes(\`/chat/\${targetChatId}\`) : false;
        ownPages.push({ p, url, isChatThread, matchesTarget, score: (matchesTarget ? 4 : 0) + (isChatThread ? 2 : 1) });
      } catch (e) {
        // Page may be closing, skip
      }
    }

    // Reuse only if we own the page and it matches the saved chat URL.
    if (ownPages.length > 0 && storedChatUrl) {
      ownPages.sort((a, b) => b.score - a.score);
      const best = ownPages[0];
      if (best.matchesTarget) {
        const p = best.p;
        p._lunaUserId = userId;
        p._lunaProvider = provider;
        const session = {
          page: p,
          context: this.defaultContext,
          chatUrl: storedChatUrl,
          provider,
          lastActivity: Date.now(),
          processing: false,
          mode: stored?.mode || 'instant',
          sessionSaved: false,
        };
        this.userSessions.set(userId, session);
        log.info(\`Reusing own \${providerDomain} page for user \${hashUserId(userId)}: \${best.url}\`);
        this._saveChatUrl(userId, session.chatUrl, { mode: session.mode, provider });
        return p;
      }
    }

    if (otherUserActivePages.length > 0) {
      log.info(\`Not reusing \${otherUserActivePages.length} provider page(s) owned by other users for \${hashUserId(userId)}\`);
    }

    // Acquire semaphore slot (now effectively unlimited)
    log.info(\`Acquiring slot for user \${hashUserId(userId)} (\${this.semaphore.current}/\${this.maxPages})\`);
    await this.semaphore.acquire();

    // Get or create isolated context for this user
    const userCtx = await this._getOrCreateUserContext(userId);

    // If we have a persisted chat URL, go directly to it. Otherwise open a fresh
    // chat so this session never lands in another user's thread.
    let chatUrl = storedChatUrl;
    let needsNewChat = false;
    if (!chatUrl) {
      chatUrl = this._modeUrl(provider, 'instant');
      needsNewChat = true;
    }`;

if (!data.includes(oldSection)) {
  console.error('old section not found');
  process.exit(1);
}
data = data.replace(oldSection, newSection);
fs.writeFileSync(file, data, 'utf8');
console.log('replaced successfully');
