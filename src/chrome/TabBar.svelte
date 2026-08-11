<script lang="ts">
  import { tabs, activeTabId, newTab, closeTab, switchTab, renameTab, type Tab } from "../layout/tabs";
  import { layout, paneStatus, focusedPane, windowFocused } from "../store/appStore";
  import { leafIds, type PaneNode } from "../layout/tree";
  import { aggregateStatus, STATUS_ICON, STATUS_LABEL, shouldShowPaneBadge, type PaneStatus } from "../core/agent-status";

  let editing = $state<number | null>(null);
  let editValue = $state("");

  /** #50: タブ内全ペインの状態を1個へ集約（🔔>🔴>🟡>✅>🟢）。アクティブタブの
   *  レイアウトはグローバル $layout が権威（Workspace の tabLayout と同じ規約）。
   *  記録は focus 不問（Terminal.svelte 参照）。集約に混ぜる前に shouldShowPaneBadge で
   *  「見ている pane」の状態を除く＝ペイン右上バッジと同じ watching 定義で揃える。 */
  function tabStatus(
    t: Tab,
    active: number,
    lay: PaneNode | null,
    statuses: ReadonlyMap<number, PaneStatus>,
    focusedPaneId: number,
    winFocused: boolean,
  ): PaneStatus | null {
    const l = t.id === active ? lay : t.layout;
    if (!l) return null;
    return aggregateStatus(
      leafIds(l).map((id) => (shouldShowPaneBadge(id, focusedPaneId, winFocused) ? statuses.get(id) : undefined)),
    );
  }

  function startEdit(id: number, current: string) {
    editing = id;
    editValue = current;
  }
  function commitEdit(id: number) {
    if (editing !== id) return;
    renameTab(id, editValue);
    editing = null;
  }
  // 編集 input を表示直後にフォーカス＆全選択（autofocus 警告を避ける action）。
  function focusInput(node: HTMLInputElement) {
    node.focus();
    node.select();
  }
</script>

<div class="tabbar">
  {#each $tabs as t, i (t.id)}
    {@const st = tabStatus(t, $activeTabId, $layout, $paneStatus, $focusedPane, $windowFocused)}
    <button
      class="tab"
      class:active={t.id === $activeTabId}
      onclick={() => switchTab(t.id)}
      ondblclick={() => startEdit(t.id, t.name ?? `tab ${i + 1}`)}
    >
      {#if editing === t.id}
        <input
          class="rename"
          bind:value={editValue}
          use:focusInput
          onpointerdown={(e) => e.stopPropagation()}
          onblur={() => commitEdit(t.id)}
          onkeydown={(e) => {
            if (e.key === "Enter") commitEdit(t.id);
            else if (e.key === "Escape") editing = null;
          }}
        />
      {:else}
        <span class="label">{t.name ?? `tab ${i + 1}`}</span>
      {/if}
      {#if st}
        <span class="status" title={STATUS_LABEL[st]} aria-label={STATUS_LABEL[st]}>{STATUS_ICON[st]}</span>
      {/if}
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
  .rename {
    width: 72px;
    background: #000;
    border: 1px solid var(--teal);
    border-radius: 3px;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.72rem;
    padding: 1px 4px;
    outline: none;
  }
  .status {
    font-size: 0.58rem;
    line-height: 1;
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
