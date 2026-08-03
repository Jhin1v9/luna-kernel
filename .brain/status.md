# Luna Status

> Living memory for AI agents. Update this file when system reality changes.
> Last verified: 2026-08-03 by Kimi Code CLI.

## Current Branch

**`Luna-Abner`** is the active development branch.
- Created: 2026-08-03
- Pushed to: `origin/Luna-Abner`
- All agent work should be committed and pushed to this branch, not `main`.

## System State

| Component | Status | Notes |
|---|---|---|
| `luna-server` | Online, stable | No automatic restarts since auto-health removal. |
| `nexo-dashboard` | Online | Standard operation. |
| `luna-health-watchdog` | Stopped | Disabled intentionally; it was causing restart loops. |
| Chrome/CDP | Connected on `:9222` | Kimi Web reachable. |
| SSE streaming | Working | Both thinking and response bubbles populate correctly. |
| Wallpaper | Deterministic | Constellation lines are seeded and visible after hard refresh. |

## Recent Fixes (2026-08-03)

1. **Server stability**
   - Removed the `Auto-Health Monitor` loop from `apps/dashboard/luna-chat-routes.js`.
   - The monitor was detecting port 3458 as "closed" during boot and calling `runScript('restart')`, causing an infinite restart loop.
   - Cleaned all PM2 processes and Node zombies, then restarted only `luna-server` and `nexo-dashboard`.

2. **Deterministic wallpaper**
   - Fixed `packages/kernel/luna-web/src/lib/starAnimations.js` so `projectStar()` and `projectBgStar()` initialize `currentX/currentY` immediately.
   - Before the fix, dynamic constellation lines were calculated from `(0,0)` on the first frame, producing inconsistent layouts after hard refresh.
   - Increased constellation and proximity line opacity in `ParticleBackground.svelte` to keep the "connected constellations" look always visible.

3. **Build + deploy**
   - Rebuilt `packages/kernel/luna-web/dist/` with Vite.
   - Verified `localhost:3458` serves the new build.

## Known Quirks (Non-blocking)

- The thinking bubble may end with the text `JSON Copiar`. This is UI text leaked from Kimi's DOM extraction. It does not affect functionality and is left as-is per owner request: "do not touch what is working".

## Commands That Work Right Now

```bash
# Restart Luna cleanly
cd ~/.luna-kernel
pm2 delete all
taskkill //F //IM node.exe 2>nul
pm2 start pm2-ecosystem.config.js --only luna-server,nexo-dashboard

# Rebuild frontend
cd packages/kernel/luna-web
npm run build
cd ../../../
pm2 restart luna-server
```

## Files to Check Before Changing Behavior

- `apps/dashboard/luna-chat-routes.js` — chat/SSE routes, health/auto-restart logic.
- `packages/kernel/luna-soul.cjs` — orchestrator, JSON parsing, thinking/response extraction.
- `packages/kernel/kimi-bridge.cjs` + `bridge-libs/` — CDP/Chrome control.
- `packages/kernel/luna-web/src/components/ParticleBackground.svelte` — wallpaper.
- `packages/kernel/luna-web/src/lib/starAnimations.js` — star state/projection utilities.
