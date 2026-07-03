<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { get } from "svelte/store";
  import { invoke } from "@tauri-apps/api/core";
  import { getUsage, type Usage } from "../core/usage";
  import { getClaudeStatus, getGitBranch, getMcpHealth, type ClaudeStatus, type McpStatus } from "../core/status";
  import { cwd as cwdStore, layout, startedAt, sidebarSide, aiPaneActivity, aiPane, focusedPane, paneStatus } from "../store/appStore";
  import { tabs, activeTabId, switchTab } from "../layout/tabs";
  import { leafIds } from "../layout/tree";
  import { STATUS_ICON, STATUS_LABEL, STATUS_PRIORITY, type PaneStatus } from "../core/agent-status";
  import { logError } from "../core/log";
  import { buildClaudeCmd } from "../layout/launch";

  // #34 系: サイドバーから直接 model/effort を切替。値は Claude CLI の非対話引数
  // （`/model <alias>` `/effort <level>` は Enter で即反映）。
  // ultracode は誤操作で強制発火すると影響が大きいため一覧には含めない（要れば手打ちで）。
  const MODEL_OPTIONS = [
    { value: "opus", label: "Opus 4.8" },
    { value: "sonnet", label: "Sonnet 5" },
    { value: "haiku", label: "Haiku 4.5" },
    { value: "fable", label: "Fable 5" },
    { value: "default", label: "Default" },
  ];
  const EFFORT_OPTIONS = [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max（このセッションのみ）" },
    { value: "auto", label: "auto" },
  ];
  const cmdEncoder = new TextEncoder();

  /** AI ペイン（フォーカスとは無関係に固定の aiPane store）へスラッシュコマンドを Enter 込みで
   *  投入する。model/effort 切替は UI から明示選択された非破壊操作なので、#33 の rerun（Enter
   *  を送らず人に委ねる）とは違い、即時反映が自然＝ここでは \r まで送る。
   *  会話に既に出力がある場合 /model は確認プロンプトを出すことがあるが、それは自動化せず
   *  端末上でユーザーの確認に委ねる（勝手に Enter を連打しない）。 */
  function sendAiCommand(cmd: string) {
    const target = get(aiPane);
    if (target == null) return;
    void invoke("write_pty", { paneId: target, data: Array.from(cmdEncoder.encode(cmd + "\r")) })
      .catch((e) => logError(`AI pane command failed: ${String(e)}`));
    aiPaneActivity.set(Date.now()); // 直後にサイドバーのステータスを再チェック（1.2s/3s）
  }
  function onModelChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    (e.currentTarget as HTMLSelectElement).value = ""; // プレースホルダに戻す（現在値は下のkvで見える）
    if (v) sendAiCommand(`/model ${v}`);
  }
  function onEffortChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value;
    (e.currentTarget as HTMLSelectElement).value = "";
    if (v) sendAiCommand(`/effort ${v}`);
  }

  /** claude 起動ボタン。aiPane 未設定ならフォーカス中のペインへフォールバックし、
   *  そのペインをそのまま aiPane として確定する（「ここで起動する」＝「ここが AI ペイン」）。
   *  model/effort プルダウンとは違い、ボタンは押したら必ず何か起きてほしいための挙動。 */
  function startClaude(preset: "fresh" | "continue") {
    let target = get(aiPane);
    if (target == null) {
      // #47: info タブ表示中は focusedPane が実在しないダミー(-1)＝フォールバック先にしない
      // （ペイン ID は 1 始まり）。誤って aiPane を -1 に確定させると以後の切替が全部死ぬ。
      const focused = get(focusedPane);
      if (focused > 0) {
        target = focused;
        aiPane.set(target);
      }
    }
    if (target == null) return;
    void invoke("write_pty", {
      paneId: target,
      data: Array.from(cmdEncoder.encode(buildClaudeCmd(preset) + "\r")),
    }).catch((e) => logError(`claude start failed: ${String(e)}`));
    aiPaneActivity.set(Date.now());
  }

  let usage = $state<Usage | null>(null);
  let status = $state<ClaudeStatus | null>(null);
  let usageStale = $state(false); // 直近の取得が失敗＝直前の値を表示中（ゲージは消さない）
  let now = $state(Date.now());
  let wsOpen = $state(false);
  let branch = $state<string | null>(null);
  let health = $state<Record<string, McpStatus>>({}); // 短縮名 -> 生死（claude mcp list 実測）
  let healthLoading = $state(false);
  // #43: 重い claude mcp list（npx MCP 群を全 spawn、数秒〜十数秒）は起動処理に混ぜない。
  // onMount の 3s デファーが走るまで cwd 追従からの health フェッチを封じるゲート
  // （それまでキャッシュは空なので表示面の損失もない）。マウント直後の $effect（cwd=""）や
  // 最初の OSC Cwd 到着で起動中に重フェッチが先行・多重発火するのを防ぐ。
  let healthPrimed = false;
  let timer: number | undefined;
  let healthTimer: number | undefined;
  let healthDeferTimer: number | undefined;
  let clock: number | undefined;

  let paneCount = $derived($layout ? leafIds($layout).length : 0);
  let uptime = $derived(fmtUptime(now - startedAt));

  // #50 INBOX: 「手が要る」ペイン（要承認/失敗/入力待ち）だけを全タブ横断で集約。
  // 並びは STATUS_PRIORITY（🔔>🔴>🟡）。クリックでそのタブ＆ペインへジャンプする。
  const INBOX_STATUSES: PaneStatus[] = ["attention", "failed", "waiting"];
  interface InboxItem {
    paneId: number;
    tabId: number;
    tabName: string;
    status: PaneStatus;
  }
  let inbox = $derived.by(() => {
    const out: InboxItem[] = [];
    $tabs.forEach((t, i) => {
      const l = t.id === $activeTabId ? $layout : t.layout; // アクティブタブは $layout が権威
      if (!l) return;
      for (const pid of leafIds(l)) {
        const st = $paneStatus.get(pid);
        if (st && INBOX_STATUSES.includes(st)) {
          out.push({ paneId: pid, tabId: t.id, tabName: t.name ?? `tab ${i + 1}`, status: st });
        }
      }
    });
    out.sort((a, b) => STATUS_PRIORITY.indexOf(a.status) - STATUS_PRIORITY.indexOf(b.status));
    return out;
  });

  /** INBOX からのジャンプ。タブ切替＋ペインフォーカス（focusedPane の購読が
   *  acknowledgePane を発火するので、飛んだ時点でバッジは自動で消える）。 */
  function jumpToPane(item: InboxItem) {
    switchTab(item.tabId);
    focusedPane.set(item.paneId);
  }

  // #45: cwd が変わるたび（タブ切替・OSC Cwd 更新）branch / CLAUDE ステータス / MCP を追従。
  // 直前の表示は消さず、取得成功時に差し替える（ちらつき防止）。連続切替でコマンドを
  // 乱発しないよう 300ms debounce。
  let cwdDebounce: number | undefined;
  $effect(() => {
    const c = $cwdStore;
    if (cwdDebounce) clearTimeout(cwdDebounce);
    cwdDebounce = window.setTimeout(() => {
      getGitBranch(c || undefined)
        .then((b) => {
          if (get(cwdStore) === c) branch = b; // 後着の旧 cwd の結果で上書きしない
        })
        .catch(() => {
          if (get(cwdStore) === c) branch = null;
        });
      void refreshStatus();
      // 起動中（3s デファー前）は health を触らない＝初回フェッチは #43 どおり 1 回だけ。
      if (healthPrimed) syncHealthForCwd(c);
    }, 300);
  });

  // AI ペインで Enter が押された（/model・/effort 等の可能性）→ CLAUDE ステータスを再チェック。
  // settings.json への書き込みには若干のタイムラグがあるため 2 段（1.2s / 3s）でリトライする。
  let aiActivityTimers: number[] = [];
  $effect(() => {
    void $aiPaneActivity; // 依存として購読するだけ（値そのものは使わない）
    for (const t of aiActivityTimers) clearTimeout(t);
    aiActivityTimers = [1200, 3000].map((ms) => window.setTimeout(() => refreshStatus(), ms));
  });

  let usageErr = $state("");
  let usageBackoffUntil = 0; // 429 を食らったらこの時刻まで叩かない（自分で悪化させない）

  async function refreshUsage() {
    if (Date.now() < usageBackoffUntil) return;
    try {
      usage = await getUsage();
      usageStale = false;
      usageErr = "";
    } catch (e) {
      // 取得失敗：直前の usage を保持し、ゲージは消さない（少し薄くするだけ）。
      // 初回未取得（usage===null）の時だけプレースホルダが出る（理由はツールチップで正直に）。
      usageStale = true;
      usageErr = String(e);
      // usage API 側のレート制限。ハンマリングすると回復が遅れるので 90 秒黙る。
      if (usageErr.includes("429")) usageBackoffUntil = Date.now() + 90_000;
    }
  }
  async function refreshStatus() {
    try {
      status = await getClaudeStatus(get(cwdStore) || undefined);
    } catch {
      /* settings 読めない時はサイドバーが欠けるだけ */
    }
  }
  // MCP の生死（claude mcp list 実測）。重い（数秒）ので手動リロード＋長間隔でのみ叩き、
  // #45: 結果は cwd をキーにキャッシュしてタブ切替では即差し替え・裏で鮮度補充する。
  const HEALTH_TTL = 300_000; // 5 分。これより古いキャッシュは表示しつつ裏で再取得
  const healthCache = new Map<string, { health: Record<string, McpStatus>; at: number }>();
  async function refreshHealth(force = false) {
    if (healthLoading) return; // 連打・タイマー重なりでの二重起動を防ぐ
    const key = get(cwdStore) || "";
    const cached = healthCache.get(key);
    if (!force && cached && Date.now() - cached.at < HEALTH_TTL) {
      health = cached.health; // 新鮮なキャッシュがあるなら重い実測は省略
      return;
    }
    healthLoading = true;
    try {
      const list = await getMcpHealth(key || undefined);
      const map: Record<string, McpStatus> = {};
      for (const h of list) map[h.name] = h.status;
      healthCache.set(key, { health: map, at: Date.now() });
      // 取得中に別タブへ移っていたら表示は差し替えない（古い cwd の結果で上書きしない）。
      if ((get(cwdStore) || "") === key) health = map;
    } catch {
      /* 取れなければ従来どおりグレー表示のまま（config 一覧は残る） */
    } finally {
      healthLoading = false;
    }
    // 取得中に cwd が変わっていたら、その cwd の分をもう一周（キャッシュが新鮮なら即終了）。
    const cur = get(cwdStore) || "";
    if (cur !== key) syncHealthForCwd(cur);
  }

  /** cwd 変化時の MCP 生死の追従。キャッシュがあれば即表示し（UI をブロックしない）、
   *  未取得か 5 分以上 stale なら裏で再取得して差し替える。 */
  function syncHealthForCwd(c: string) {
    const cached = healthCache.get(c || "");
    if (cached) health = cached.health;
    if (!cached || Date.now() - cached.at >= HEALTH_TTL) void refreshHealth();
  }

  // 初回はトークン更新レース（claude --continue 直後の 401）を避けるため、
  // 値が入るまで短間隔（1.5s×最大6回≒9s）で再試行する。以後は 30s 間隔。
  // 429（レート制限）だけは即あきらめて backoff に任せる＝叩くほど回復が遅れるため。
  async function initialLoad() {
    refreshStatus();
    for (let i = 0; i < 6 && !usage; i++) {
      await refreshUsage();
      if (usage || usageErr.includes("429")) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  onMount(() => {
    void initialLoad();
    timer = window.setInterval(() => {
      refreshUsage();
      refreshStatus();
    }, 30000);
    // MCP 生死は重い（数秒）ので起動処理から外し、起動が落ち着いた頃に一度だけ実行（#43: 起動高速化）。
    // この時点の cwd（OSC Cwd が届いていれば実 cwd）をキーに取得し、以後 cwd 追従を解禁する。
    healthDeferTimer = window.setTimeout(() => {
      healthPrimed = true;
      void refreshHealth();
    }, 3000);
    // 生死は重いので usage/status とは別に 5 分間隔。鮮度は ↻ 手動リロードで補う。
    healthTimer = window.setInterval(() => void refreshHealth(), 300000);
    clock = window.setInterval(() => (now = Date.now()), 10000);
  });
  onDestroy(() => {
    if (timer) clearInterval(timer);
    if (healthTimer) clearInterval(healthTimer);
    if (healthDeferTimer) clearTimeout(healthDeferTimer);
    if (clock) clearInterval(clock);
    if (cwdDebounce) clearTimeout(cwdDebounce);
    for (const t of aiActivityTimers) clearTimeout(t);
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
    <div class="startrow">
      <button class="startbtn" onclick={() => startClaude("fresh")} title="claude を新規起動">claude</button>
      <button class="startbtn" onclick={() => startClaude("continue")} title="claude --continue（会話を再開）">continue</button>
    </div>
  </div>

  <div class="sec">
    <div class="label">TOKENS</div>
    {#if usage}
      <div class="meters" class:stale={usageStale} title={usageStale ? "最新の取得に失敗：直前の値を表示中" : ""}>
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
      </div>
    {:else}
      <!-- 未取得の理由を隠さない: 429=API側レート制限（待てば直る）/ 詳細はツールチップ -->
      <div class="muted" title={usageErr || "取得中…"}>
        {usageErr.includes("429") ? "制限中（自動再試行）" : "…"}
      </div>
    {/if}
  </div>

  <div class="sec">
    <div class="label">CLAUDE</div>
    {#if status}
      <!-- model/effort は値が長い（claude-fable-5[1m] 等）ので 2 行積みで全文表示する。
           プルダウンは「変更する」専用（選ぶたびプレースホルダへ戻る）、現在値は kv 側の表示で見る。 -->
      <div class="krow stack">
        <span>model</span>
        <span class="kv">{status.model || "—"}</span>
        <select class="switcher" onchange={onModelChange} disabled={$aiPane == null} title={$aiPane == null ? "AI ペインがありません" : "モデルを切替"}>
          <option value="">変更…</option>
          {#each MODEL_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
      <div class="krow stack">
        <span>effort</span>
        <span class="kv">{status.effort || "—"}</span>
        <select class="switcher" onchange={onEffortChange} disabled={$aiPane == null} title={$aiPane == null ? "AI ペインがありません" : "effort を切替"}>
          <option value="">変更…</option>
          {#each EFFORT_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
      </div>
      <div class="krow mcp" title={"MCP 生死（claude mcp list 実測）:\n✔ connected  ! needs auth  ✗ failed"}>
        <span>mcp</span>
        <span class="kv"
          >{status.mcp.length}<button
            class="reload"
            class:spin={healthLoading}
            onclick={() => void refreshHealth(true)}
            title="MCP の生死を再取得"
            aria-label="reload MCP health">↻</button
          ></span
        >
      </div>
      {#if status.mcp.length}
        <div class="chips">
          {#each status.mcp as m}<span class="chip {health[m] ?? 'unknown'}" title={health[m] ?? 'unknown'}>{m}</span>{/each}
        </div>
      {/if}
    {:else}
      <div class="muted">…</div>
    {/if}
  </div>

  {#if inbox.length}
    <div class="sec">
      <div class="label">INBOX</div>
      {#each inbox as item (item.paneId)}
        <button
          class="inbox-row"
          onclick={() => jumpToPane(item)}
          title="クリックでジャンプ: {item.tabName} / pane {item.paneId}"
        >
          <span class="inbox-ico">{STATUS_ICON[item.status]}</span>
          <span class="inbox-name">{item.tabName} · p{item.paneId}</span>
          <span class="inbox-what">{STATUS_LABEL[item.status]}</span>
        </button>
      {/each}
    </div>
  {/if}

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
  /* #50 INBOX 行（手が要るペインへの1クリックジャンプ）。 */
  .inbox-row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    border: 1px solid rgba(45, 212, 191, 0.18);
    border-radius: 5px;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.66rem;
    padding: 3px 6px;
    margin-top: 4px;
    cursor: pointer;
    text-align: left;
  }
  .inbox-row:hover {
    background: rgba(45, 212, 191, 0.1);
    border-color: rgba(45, 212, 191, 0.45);
  }
  .inbox-ico {
    flex: 0 0 auto;
    font-size: 0.6rem;
  }
  .inbox-name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .inbox-what {
    flex: 0 0 auto;
    color: var(--grey);
    font-size: 0.6rem;
  }
  .label {
    font-size: 0.62rem;
    letter-spacing: 0.18em;
    color: var(--teal);
    margin-bottom: 8px;
  }
  .meters {
    transition: opacity 0.3s;
  }
  /* 最新取得に失敗している間は薄く＝消さずに直前値を見せる（ちらつき防止）。 */
  .meters.stale {
    opacity: 0.5;
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
  /* ラベル1行目＋値2行目の縦積み。長い値（model 名等）は切らずに折り返して全文見せる。 */
  .krow.stack {
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
  }
  .krow.stack .kv {
    max-width: 100%;
    white-space: normal;
    word-break: break-all;
    line-height: 1.3;
    padding-left: 8px;
  }
  .switcher {
    margin-top: 3px;
    margin-left: 8px;
    max-width: calc(100% - 8px);
    background: #05100e;
    color: var(--grey);
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.64rem;
    padding: 2px 4px;
    cursor: pointer;
  }
  .switcher:hover:not(:disabled) {
    border-color: var(--teal);
    color: var(--fg);
  }
  .switcher:disabled {
    opacity: 0.35;
    cursor: default;
  }
  .startrow {
    display: flex;
    gap: 5px;
  }
  .startbtn {
    flex: 1 1 0;
    min-width: 0;
    background: transparent;
    color: var(--teal);
    border: 1px solid rgba(45, 212, 191, 0.35);
    border-radius: 6px;
    font-family: inherit;
    font-size: 0.68rem;
    padding: 5px 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .startbtn:hover {
    background: rgba(45, 212, 191, 0.14);
    border-color: var(--teal);
  }
  .mcp {
    cursor: help;
  }
  .reload {
    background: none;
    border: none;
    padding: 0;
    margin-left: 5px;
    color: var(--teal);
    font-size: 0.72rem;
    line-height: 1;
    cursor: pointer;
    vertical-align: middle;
  }
  .reload:hover {
    text-shadow: 0 0 6px rgba(45, 212, 191, 0.7);
  }
  /* 取得中はスピン（transform のみ＝compositor-only、軽量ethos準拠）。 */
  .reload.spin {
    display: inline-block;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
  }
  .chip {
    font-size: 0.58rem;
    border: 1px solid;
    border-radius: 4px;
    padding: 1px 5px;
    /* health 未取得＝ニュートラルなグレー。取得後に status クラスで生死の色がつく。 */
    color: var(--grey);
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.16);
    transition:
      color 0.3s,
      background 0.3s,
      border-color 0.3s;
  }
  .chip.connected {
    color: var(--teal);
    background: rgba(45, 212, 191, 0.1);
    border-color: rgba(45, 212, 191, 0.22);
  }
  .chip.needs_auth {
    color: #f5c451;
    background: rgba(245, 196, 81, 0.1);
    border-color: rgba(245, 196, 81, 0.3);
  }
  .chip.failed {
    color: var(--red);
    background: rgba(255, 92, 138, 0.1);
    border-color: rgba(255, 92, 138, 0.3);
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
