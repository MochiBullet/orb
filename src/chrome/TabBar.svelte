<script lang="ts">
  import { tabs, activeTabId, newTab, closeTab, switchTab } from "../layout/tabs";
</script>

<div class="tabbar">
  {#each $tabs as t, i (t.id)}
    <button class="tab" class:active={t.id === $activeTabId} onclick={() => switchTab(t.id)}>
      <span class="label">tab {i + 1}</span>
      {#if $tabs.length > 1}
        <span
          class="x"
          role="button"
          tabindex="-1"
          aria-label="close tab"
          onpointerdown={(e) => {
            e.stopPropagation();
            closeTab(t.id);
          }}>&#x2715;</span
        >
      {/if}
    </button>
  {/each}
  <button class="newtab" onclick={() => newTab()} aria-label="new tab">&#x2b;</button>
</div>

<style>
  .tabbar {
    display: flex;
    align-items: stretch;
    gap: 2px;
    height: 28px;
    flex: 0 0 auto;
    padding: 0 6px;
    background: #000;
    border-bottom: 1px solid rgba(45, 212, 191, 0.15);
    user-select: none;
    overflow-x: auto;
  }
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--grey);
    font-family: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab:hover {
    color: var(--fg);
  }
  .tab.active {
    color: var(--teal);
    border-bottom-color: var(--teal);
  }
  .x {
    font-size: 0.62rem;
    opacity: 0.6;
  }
  .x:hover {
    opacity: 1;
    color: var(--red);
  }
  .newtab {
    border: 0;
    background: transparent;
    color: var(--grey);
    font-size: 0.9rem;
    cursor: pointer;
    padding: 0 8px;
  }
  .newtab:hover {
    color: var(--teal);
  }
</style>
