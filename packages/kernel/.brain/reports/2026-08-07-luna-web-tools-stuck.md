# Bug: Tools de Luna web se quedan "Pensando" (no ejecutan/completan)

**Fecha:** 2026-08-07
**Entorno:** VPS (luna-server), rama main tras merge de Luna-Abner
**Área:** flujo bridge → soul → feedback de herramientas (luna-soul.cjs / kimi-bridge.cjs)

## Síntoma
Cuando el usuario pide en la Luna web una tarea que requiere herramienta (executeShell /
executeScript / python), Kimi muestra "Pensando" y el flujo **se queda bloqueado** sin
completar ni responder al usuario.

## Observaciones en logs (luna-server)

1. La tool **se detecta correctamente** en el bridge:
   `[JSON STREAM] Action detected: executeScript`
2. Pero el evento llega **tarde**, cuando Kimi ya generó la respuesta final:
   `[JSON STREAM] Late action detected in finalResponse: executeScript`
3. El soul registra la promesa en `domActionPromises` (`Waiting for 1 background action`) pero la
   ejecución **no emite `action_start`** ni completa de forma sincronizada.
4. Con el fix de timeout se observó: `[DOM MIRROR] Action error: Tool executeScript excedeu o
   tempo limite de 120s sem resposta.` → el cuelgue se detecta pero la tool no llega a ejecutar.

## Causa raíz probable
Problema de **sincronización/orden de eventos** entre el bridge (que emite `action_detected`) y el
soul (que debe ejecutar la tool). La detección ocurre en `finalResponse`, demasiado tarde para que
el soul procese la acción dentro del bucle del stream (`_generate`).

Al ejecutar `lunaTools.executeScript` directamente funciona OK (devuelve resultado en ~5ms) cuando
el `cwd` existe. El fallo es del flujo bridge→soul, no de la tool en sí.

## Intentos de fix (revertidos)
1. **Timeout anti-cuelgue** (Promise.race 120s en `_executeActionAsync`): evita el cuelgue infinito
   (ahora da error visible a los 120s) pero NO completa la ejecución de la tool.
2. **Feedback de resultados** (reenviar resultado local a Kimi tras `done`): CAUSÓ bucle infinito —
   el script se ejecutó hasta 23 veces porque Kimi re-ejecutaba la tool en vez de responder.

## Pendiente para Luna-Abner
Revisar el flujo `sendMessageStream` → `_generate` en luna-soul.cjs:
- Por qué `action_detected` llega en `finalResponse` (tarde).
- Cómo propagar correctamente el evento de acción al soul para que ejecute la tool y devuelva el
  resultado a Kimi UNA sola vez (con deduplicación estricta), sin bucle.
- El "Pensando" no avanza porque la tool no completa; el fix debe asegurar que la tool se ejecute y
  el resultado vuelva a Kimi antes del `done`.

## Estado actual
- luna-server quedó con el **código original del merge** + **fix de timeout** (evita cuelgue
  infinito, pero las tools no completan).
- Las tools de Luna web **no funcionan** satisfactoriamente hasta que Luna-Abner resuelva el flujo.
