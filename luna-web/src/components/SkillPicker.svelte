<script>
  import { availableSkills, activeSkills } from '../stores.js';
  import { validateSkillPath, setSessionActiveSkills } from '../api.js';

  export let sessionId = null;

  let showAdd = false;
  let newPath = '';
  let validationError = '';
  let validating = false;

  $: activeList = $activeSkills.map((path) => {
    const found = $availableSkills.find((s) => s.path === path);
    return found || { name: path.split('/').pop() || path, path };
  });

  function handleClickOutside(e) {
    if (showAdd && !e.target.closest('.skill-picker')) {
      showAdd = false;
    }
  }

  function updateActive(next) {
    activeSkills.set(next);
    if (sessionId) {
      setSessionActiveSkills(sessionId, next);
    }
  }

  function toggleSkill(path) {
    const next = $activeSkills.includes(path)
      ? $activeSkills.filter((p) => p !== path)
      : [...$activeSkills, path];
    updateActive(next);
  }

  function removeSkill(path) {
    const next = $activeSkills.filter((p) => p !== path);
    updateActive(next);
  }

  async function addByPath() {
    const trimmed = newPath.trim();
    if (!trimmed || validating) return;

    validationError = '';
    validating = true;
    const res = await validateSkillPath(trimmed);
    validating = false;

    if (!res.ok || !res.result?.valid) {
      validationError = res.result?.error || res.error || 'Skill inválida';
      return;
    }

    const result = res.result || {};
    const canonicalPath = result.path || trimmed;

    const next = [...new Set([...$activeSkills, canonicalPath])];
    updateActive(next);

    if (result.skill) {
      availableSkills.update((list) => {
        if (list.some((s) => s.path === canonicalPath)) return list;
        return [...list, result.skill];
      });
    }

    newPath = '';
    showAdd = false;
  }

  function handleInputKeydown(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addByPath();
    }
  }
</script>

<svelte:window on:click={handleClickOutside} />

<div class="skill-picker">
  <div class="skill-chips">
    {#each activeList as skill (skill.path)}
      <span class="skill-chip">
        <span class="chip-name">{skill.name}</span>
        <button
          class="chip-remove"
          on:click={() => removeSkill(skill.path)}
          aria-label="Remover skill {skill.name}"
          title="Remover skill {skill.name}"
          type="button"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </span>
    {/each}

    <button
      class="add-skill-btn"
      on:click|stopPropagation={() => (showAdd = !showAdd)}
      type="button"
      aria-expanded={showAdd}
      aria-haspopup="true"
    >
      + Skill
    </button>
  </div>

  {#if showAdd}
    <div class="skill-dropdown" role="dialog" aria-modal="true" on:click|stopPropagation on:keydown={() => {}}>
      {#if $availableSkills.length > 0}
        <div class="skill-list" role="listbox" aria-label="Skills disponíveis">
          {#each $availableSkills as skill (skill.path)}
            <label class="skill-option" role="option" aria-selected={$activeSkills.includes(skill.path)}>
              <input
                type="checkbox"
                checked={$activeSkills.includes(skill.path)}
                on:change={() => toggleSkill(skill.path)}
              />
              <span class="skill-name">{skill.name}</span>
              {#if skill.description}
                <span class="skill-desc">{skill.description}</span>
              {/if}
            </label>
          {/each}
        </div>
      {:else}
        <div class="skill-empty">Nenhuma skill disponível</div>
      {/if}

      <div class="skill-path-add">
        <input
          type="text"
          bind:value={newPath}
          on:keydown={handleInputKeydown}
          placeholder="Caminho da skill (ex: /home/jhin/.luna/skills/coding)"
          aria-label="Caminho da skill"
          disabled={validating}
        />
        <button
          on:click={addByPath}
          disabled={!newPath.trim() || validating}
          type="button"
        >
          {validating ? '...' : 'Validar e adicionar'}
        </button>
      </div>

      {#if validationError}
        <div class="skill-error" role="alert">{validationError}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .skill-picker {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    position: relative;
  }

  .skill-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    align-items: center;
  }

  .skill-chip {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    background: var(--luna-accent-border);
    color: var(--luna-accent);
    border: 1px solid var(--luna-accent);
    border-radius: 999px;
    padding: 0.2rem 0.625rem;
    font-size: clamp(0.6875rem, 1.5vw, 0.75rem);
    font-weight: 500;
  }

  .chip-name {
    max-width: 8rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip-remove {
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    padding: 0.125rem;
    border-radius: 0.25rem;
    transition: opacity 0.15s;
  }

  .chip-remove:hover {
    opacity: 0.8;
  }

  .add-skill-btn {
    background: transparent;
    border: 1px dashed var(--luna-border);
    color: var(--luna-text-secondary);
    border-radius: 999px;
    padding: 0.2rem 0.625rem;
    font-size: clamp(0.6875rem, 1.5vw, 0.75rem);
    cursor: pointer;
    transition: all 0.2s;
  }

  .add-skill-btn:hover {
    border-color: var(--luna-accent);
    color: var(--luna-accent);
  }

  .skill-dropdown {
    background: var(--luna-elevated);
    border: 1px solid var(--luna-border);
    border-radius: 0.625rem;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.4);
    z-index: 50;
  }

  .skill-list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    max-height: 11rem;
    overflow-y: auto;
  }

  .skill-option {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.375rem 0.5rem;
    border-radius: 0.375rem;
    cursor: pointer;
    font-size: clamp(0.75rem, 1.8vw, 0.8125rem);
    transition: background 0.15s;
  }

  .skill-option:hover {
    background: rgba(255, 255, 255, 0.04);
  }

  .skill-option input[type='checkbox'] {
    flex-shrink: 0;
    accent-color: var(--luna-accent);
  }

  .skill-name {
    font-weight: 600;
    color: var(--luna-text);
  }

  .skill-desc {
    color: var(--luna-text-secondary);
    margin-left: auto;
    font-size: clamp(0.625rem, 1.5vw, 0.6875rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 50%;
  }

  .skill-empty {
    padding: 0.5rem;
    color: var(--luna-text-secondary);
    font-size: 0.8125rem;
    text-align: center;
  }

  .skill-path-add {
    display: flex;
    gap: 0.5rem;
  }

  .skill-path-add input {
    flex: 1;
    background: var(--luna-bg);
    border: 1px solid var(--luna-border);
    color: var(--luna-text);
    border-radius: 0.5rem;
    padding: 0.5rem 0.625rem;
    font-size: 0.8125rem;
    outline: none;
  }

  .skill-path-add input:focus {
    border-color: var(--luna-accent);
    box-shadow: 0 0 0 2px var(--luna-accent-border);
  }

  .skill-path-add button {
    background: var(--luna-accent);
    color: white;
    border: none;
    border-radius: 0.5rem;
    padding: 0.5rem 0.75rem;
    font-size: 0.8125rem;
    cursor: pointer;
    transition: filter 0.15s;
    flex-shrink: 0;
  }

  .skill-path-add button:hover:not(:disabled) {
    filter: brightness(1.1);
  }

  .skill-path-add button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .skill-error {
    color: #fca5a5;
    font-size: 0.75rem;
  }
</style>
