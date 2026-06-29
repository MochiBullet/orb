<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { getUsage, type Usage } from "../core/usage";
  import { getClaudeStatus, type ClaudeStatus } from "../core/status";
  import { cwd as cwdStore } from "../store/appStore";

  let usage = $state<Usage | null>(null);
  let status = $state<ClaudeStatus | null>(null);
  let err = $state(false);
  let timer: number | undefined;

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
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  function fmtReset(iso: string): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  }
</script>

<aside class="sidebar">
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
      <div class="krow mcp" title={"アクティブ MCP（config由来）:\n" + status.mcp.join("\n")}>
        <span>mcp</span><span class="kv">{status.mcp.length} <span class="caret">▾</span></span>
      </div>
    {:else}
      <div class="muted">…</div>
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
  .muted {
    font-size: 0.66rem;
    color: var(--grey);
    opacity: 0.7;
  }
</style>
