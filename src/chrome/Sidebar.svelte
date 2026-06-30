<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { getUsage, type Usage } from "../core/usage";
  import { getClaudeStatus, getGitBranch, type ClaudeStatus } from "../core/status";
  import { cwd as cwdStore, layout, startedAt, sidebarSide } from "../store/appStore";
  import { tabs } from "../layout/tabs";
  import { leafIds } from "../layout/tree";

  let usage = $state<Usage | null>(null);
  let status = $state<ClaudeStatus | null>(null);
  let err = $state(false);
  let now = $state(Date.now());
  let wsOpen = $state(false);
  let branch = $state<string | null>(null);
  let timer: number | undefined;
  let clock: number | undefined;

  let paneCount = $derived($layout ? leafIds($layout).length : 0);
  let uptime = $derived(fmtUptime(now - startedAt));

  // cwd が変わるたび git ブランチを取得（非リポジトリ・detached は null）。
  $effect(() => {
    const c = $cwdStore;
    getGitBranch(c || undefined)
      .then((b) => (branch = b))
      .catch(() => (branch = null));
  });

  async function refreshUsage() {
    try {
      usage = await getUsage();
      err = false;
    } catch {
      err = true;
    }
  }
  async function refreshStatus() {
    try {
      status = await getClaudeStatus(get(cwdStore) || undefined);
    } catch {
      /* settings 読めない時はサイドバーが欠けるだけ */
    }
  }

  onMount(() => {
    refreshUsage();
    refreshStatus();
    timer = window.setInterval(() => {
      refreshUsage();
      refreshStatus();
    }, 30000);
    clock = window.setInterval(() => (now = Date.now()), 10000);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (clock) clearInterval(clock);
  });

  function fmtReset(iso: string): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }
  function fmtResetDate(iso: string): string {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      return (
        d.toLocaleDateString([], { month: "numeric", day: "numeric" }) +
        " " +
        d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      );
    } catch {
      return "";
    }
  }
  function fmtUptime(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.floor(m / 60)}h${m % 60}m`;
  }
  function shortCwd(p: string): string {
    if (!p) return "—";
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : p;
  }
</script>

<aside class="sidebar" class:left={$sidebarSide === "left"}>
  <div class="sec">
    <div class="label">TOKENS</div>
    {#if usage}
      <div class="meter">
        <div class="row"><span>5h</span><span class="pct" class:hot={usage.five_hour > 80}>{Math.round(usage.five_hour)}%</span></div>
        <div class="bar"><div class="fill" class:hot={usage.five_hour > 80} style="width:{Math.min(100, usage.five_hour)}%"></div></div>
        <div class="reset">reset {fmtReset(usage.five_reset)}</div>
      </div>
      <div class="meter">
        <div class="row"><span>7d</span><span class="pct">{Math.round(usage.seven_day)}%</span></div>
        <div class="bar"><div class="fill" style="width:{Math.min(100, usage.seven_day)}%"></div></div>
        <div class="reset">reset {fmtResetDate(usage.seven_reset)}</div>
      </div>
    {:else if err}
      <div class="muted">取得失敗</div>
    {:else}
      <div class="muted">…</div>
    {/if}
  </div>

  <div class="sec">
    <div class="label">CLAUDE</div>
    {#if status}
      <div class="krow"><span>model</span><span class="kv">{status.model || "—"}</span></div>
      <div class="krow"><span>effort</span><span class="kv">{status.effort || "—"}</span></div>
      <div class="krow mcp" title={"MCP（config由来）:\n" + status.mcp.join("\n")}>
        <span>mcp</span><span class="kv">{status.mcp.length} <span class="caret">▾</span></span>
      </div>
      {#if status.mcp.length}
        <div class="chips">
          {#each status.mcp as m}<span class="chip">{m}</span>{/each}
        </div>
      {/if}
    {:else}
      <div class="muted">…</div>
    {/if}
  </div>

  <div class="sec ws-sec">
    <button class="ws-toggle" onclick={() => (wsOpen = !wsOpen)} aria-expanded={wsOpen}>
      <span class="label">WORKSPACE</span>
      <span class="tri">{wsOpen ? "▽" : "△"}</span>
    </button>
    {#if wsOpen}
      <div class="krow"><span>cwd</span><span class="kv" title={$cwdStore}>{shortCwd($cwdStore)}</span></div>
      {#if branch}
        <div class="krow"><span>branch</span><span class="kv">{branch}</span></div>
      {/if}
      <div class="krow"><span>tabs</span><span class="kv">{$tabs.length}</span></div>
      <div class="krow"><span>panes</span><span class="kv">{paneCount}</span></div>
      <div class="krow"><span>uptime</span><span class="kv">{uptime}</span></div>
    {/if}
  </div>
</aside>

<style>
  .sidebar {
    flex: 0 0 168px;
    height: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    background: #04100d;
    border-left: 1px solid rgba(45, 212, 191, 0.2);
    display: flex;
    flex-direction: column;
    gap: 16px;
    overflow-y: auto;
  }
  .sidebar.left {
    border-left: none;
    border-right: 1px solid rgba(45, 212, 191, 0.2);
  }
  .label {
    font-size: 0.62rem;
    letter-spacing: 0.18em;
    color: var(--teal);
    margin-bottom: 8px;
  }
  .meter {
    margin-bottom: 10px;
  }
  .row {
    display: flex;
    justify-content: space-between;
    font-size: 0.72rem;
    color: var(--grey);
  }
  .pct {
    color: var(--fg);
  }
  .pct.hot {
    color: var(--red);
  }
  .bar {
    height: 5px;
    margin: 3px 0;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.06);
    overflow: hidden;
  }
  .fill {
    height: 100%;
    background: var(--teal);
    box-shadow: 0 0 8px -1px rgba(45, 212, 191, 0.6);
    transition: width 0.4s;
  }
  .fill.hot {
    background: var(--red);
    box-shadow: 0 0 8px -1px rgba(255, 92, 138, 0.6);
  }
  .reset {
    font-size: 0.6rem;
    color: var(--grey);
    opacity: 0.7;
  }
  .krow {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    font-size: 0.72rem;
    color: var(--grey);
    margin-bottom: 5px;
  }
  .kv {
    color: var(--fg);
    font-size: 0.7rem;
    max-width: 96px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mcp {
    cursor: help;
  }
  .mcp .caret {
    color: var(--teal);
    font-size: 0.6rem;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .chip {
    font-size: 0.58rem;
    color: var(--teal);
    background: rgba(45, 212, 191, 0.1);
    border: 1px solid rgba(45, 212, 191, 0.22);
    border-radius: 4px;
    padding: 1px 5px;
  }
  .ws-sec {
    margin-top: auto;
  }
  .ws-toggle {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
  }
  .ws-toggle .label {
    margin-bottom: 0;
  }
  .ws-toggle .tri {
    color: var(--teal);
    font-size: 0.7rem;
  }
  .ws-toggle:hover .tri {
    text-shadow: 0 0 6px rgba(45, 212, 191, 0.7);
  }
  .muted {
    font-size: 0.66rem;
    color: var(--grey);
    opacity: 0.7;
  }
</style>
