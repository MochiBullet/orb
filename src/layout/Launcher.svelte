<script lang="ts">
  import { onMount } from "svelte";
  import {
    listProjects,
    launchProject,
    launchProjects,
    LAUNCH_PRESETS,
    type Project,
    type LaunchPreset,
  } from "./launch";
  import { MODEL_OPTIONS, EFFORT_OPTIONS } from "../core/model-effort";

  let { onClose }: { onClose: () => void } = $props();

  let projects: Project[] = $state([]);
  let query = $state("");
  let cursor = $state(0);
  let preset = $state<LaunchPreset>("continue"); // AI ペインの claude 起動プリセット(#38)
  let input = $state<HTMLInputElement | undefined>(); // 検索欄は approve モードで一時的にアンマウントされるため $state で追跡

  // 複数案件の一括起動: Ctrl+Space（またはチェックボックスクリック）で候補に印を付け、
  // Enter で「まとめて model/effort を承認 → 一括起動」画面へ。auto mode で複数案件を長時間
  // 放置する運用を想定し、起動前にまとめて承認しておけば起動後に個別の確認を挟まずに済む。
  // 何もチェックしていない場合は従来どおり Enter で即座に1件だけ起動する（挙動を変えない）。
  let checked = $state<Set<string>>(new Set());
  let mode = $state<"search" | "approve">("search");

  interface Approval {
    project: Project;
    model: string;
    effort: string;
  }
  let approvals = $state<Approval[]>([]);
  let bulkModel = $state("default");
  let bulkEffort = $state("auto");

  onMount(async () => {
    projects = await listProjects();
    input?.focus();
  });

  let filtered = $derived(
    projects.filter((p) => {
      const q = query.toLowerCase();
      return p.name.toLowerCase().includes(q) || p.slug.includes(q);
    }),
  );

  function choose(p: Project) {
    launchProject(p, preset);
    onClose();
  }

  function toggleCheck(p: Project) {
    const next = new Set(checked);
    if (next.has(p.slug)) next.delete(p.slug);
    else next.add(p.slug);
    checked = next;
  }

  function goApprove() {
    const picked = projects.filter((p) => checked.has(p.slug));
    if (!picked.length) return;
    approvals = picked.map((p) => ({ project: p, model: "default", effort: "auto" }));
    mode = "approve";
  }

  function backToSearch() {
    mode = "search";
  }

  function applyBulkToAll() {
    approvals = approvals.map((a) => ({ ...a, model: bulkModel, effort: bulkEffort }));
  }

  function launchAll() {
    launchProjects(
      approvals.map((a) => ({ project: a.project, opts: { model: a.model, effort: a.effort } })),
      preset,
    );
    onClose();
  }

  function cyclePreset() {
    const i = LAUNCH_PRESETS.findIndex((x) => x.id === preset);
    preset = LAUNCH_PRESETS[(i + 1) % LAUNCH_PRESETS.length].id;
  }

  function onKey(e: KeyboardEvent) {
    if (mode === "approve") {
      if (e.key === "Escape") {
        e.preventDefault();
        backToSearch();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      cursor = Math.min(cursor + 1, Math.max(filtered.length - 1, 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      cursor = Math.max(cursor - 1, 0);
    } else if (e.key === "Tab") {
      e.preventDefault();
      cyclePreset(); // Tab で AI 起動プリセットを巡回
    } else if (e.key === " " && (e.ctrlKey || e.metaKey)) {
      // 素の Space は検索クエリへの文字入力に使うため、複数選択は Ctrl/Cmd+Space に割り当てる。
      e.preventDefault();
      const p = filtered[cursor];
      if (p) toggleCheck(p);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (checked.size > 0) {
        goApprove();
      } else {
        const p = filtered[cursor];
        if (p) choose(p);
      }
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="palette" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    {#if mode === "approve"}
      <div class="approve">
        <div class="approve-head">
          <span class="ttl">起動前にまとめて承認（{approvals.length}件）</span>
          <button class="back" onpointerdown={backToSearch}>← 選び直す</button>
        </div>
        <div class="bulk-row">
          <span class="pl">全案件に適用:</span>
          <select bind:value={bulkModel} aria-label="全案件のモデルを一括指定">
            {#each MODEL_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
          </select>
          <select bind:value={bulkEffort} aria-label="全案件のeffortを一括指定">
            {#each EFFORT_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
          </select>
          <button class="applybtn" onpointerdown={applyBulkToAll}>反映</button>
        </div>
        <ul class="approve-list">
          {#each approvals as a (a.project.slug)}
            <li>
              <span class="name">{a.project.name}</span>
              <select bind:value={a.model} aria-label={`${a.project.name} のモデル`}>
                {#each MODEL_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
              <select bind:value={a.effort} aria-label={`${a.project.name} のeffort`}>
                {#each EFFORT_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
              </select>
            </li>
          {/each}
        </ul>
        <div class="presets">
          <span class="pl">AI 起動:</span>
          {#each LAUNCH_PRESETS as ps (ps.id)}
            <button
              class="chip"
              class:on={preset === ps.id}
              class:danger={ps.id === "yolo"}
              title={ps.hint}
              onpointerdown={(e) => {
                e.preventDefault();
                preset = ps.id;
              }}
            >{ps.label}</button>
          {/each}
        </div>
        <button class="launch-all" onpointerdown={launchAll}
          >この設定で{approvals.length}件を起動する（放置OK）</button
        >
      </div>
    {:else}
      <input
        bind:this={input}
        bind:value={query}
        oninput={() => (cursor = 0)}
        placeholder="案件を検索して Enter で起動…  (dev3: AI / dev / lazygit / Ctrl+Space で複数選択)"
      />
      <div class="presets">
        <span class="pl">AI 起動:</span>
        {#each LAUNCH_PRESETS as ps (ps.id)}
          <button
            class="chip"
            class:on={preset === ps.id}
            class:danger={ps.id === "yolo"}
            title={ps.hint}
            onpointerdown={(e) => {
              e.preventDefault();
              preset = ps.id;
              input?.focus();
            }}
          >{ps.label}</button>
        {/each}
        <span class="pk">Tab で切替</span>
      </div>
      {#if checked.size > 0}
        <div class="batchbar">
          <span>{checked.size}件選択中</span>
          <button class="go" onpointerdown={goApprove}>まとめて承認へ（Enter）</button>
          <button class="clearsel" onpointerdown={() => (checked = new Set())}>選択解除</button>
        </div>
      {/if}
      <ul>
        {#each filtered as p, i (p.slug)}
          <li class:sel={i === cursor} onpointerdown={() => choose(p)}>
            <button
              type="button"
              class="chk"
              class:on={checked.has(p.slug)}
              onpointerdown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleCheck(p);
              }}
              title="複数選択に追加/解除（Ctrl+Space）"
              aria-label={checked.has(p.slug) ? `${p.name} の選択を解除` : `${p.name} を複数選択に追加`}
              >{checked.has(p.slug) ? "☑" : "☐"}</button
            >
            <div class="row-main">
              <span class="name">{p.name}</span>
              <span class="dir">{p.dir}</span>
            </div>
          </li>
        {/each}
        {#if filtered.length === 0}
          <li class="empty">該当なし</li>
        {/if}
      </ul>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding-top: 12vh;
    z-index: 100;
    overflow: hidden;
  }
  /* 漂うオーロラ帯（blur 不使用・transform/opacity 駆動で軽量）。 */
  .overlay::before {
    content: "";
    position: absolute;
    inset: -30%;
    background:
      radial-gradient(ellipse at 30% 35%, rgba(45, 212, 191, 0.16), transparent 60%),
      radial-gradient(ellipse at 70% 65%, rgba(var(--violet-rgb, 167, 139, 250), 0.13), transparent 55%);
    animation: aurora 16s ease-in-out infinite alternate;
    pointer-events: none;
  }
  @keyframes aurora {
    from {
      transform: translate3d(-4%, -3%, 0) scale(1.05);
    }
    to {
      transform: translate3d(4%, 4%, 0) scale(1.18);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .overlay::before {
      animation: none;
    }
  }
  .palette {
    position: relative;
    z-index: 1;
  }
  .palette {
    width: min(640px, 86vw);
    background: #05100e;
    border: 1px solid rgba(45, 212, 191, 0.4);
    border-radius: 10px;
    box-shadow: 0 0 40px -8px rgba(45, 212, 191, 0.35);
    overflow: hidden;
  }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 14px 16px;
    border: 0;
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    font-size: 0.95rem;
    outline: none;
  }
  .presets {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 12px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.12);
  }
  .presets .pl {
    color: var(--grey);
    font-size: 0.7rem;
    margin-right: 2px;
  }
  .chip {
    border: 1px solid rgba(45, 212, 191, 0.25);
    background: transparent;
    color: var(--grey);
    font-family: inherit;
    font-size: 0.72rem;
    border-radius: 999px;
    padding: 2px 10px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s, border-color 0.12s;
  }
  .chip:hover {
    border-color: rgba(45, 212, 191, 0.5);
  }
  .chip.on {
    background: rgba(45, 212, 191, 0.16);
    border-color: var(--teal);
    color: var(--fg);
  }
  /* 危険モード(--dangerously-skip-permissions)は赤で警告し誤クリックを抑止。 */
  .chip.danger {
    color: #ff5c8a;
    border-color: rgba(255, 92, 138, 0.4);
  }
  .chip.danger.on {
    background: rgba(255, 92, 138, 0.18);
    border-color: #ff5c8a;
    color: #ffd0dd;
  }
  .pk {
    margin-left: auto;
    color: var(--grey);
    opacity: 0.55;
    font-size: 0.62rem;
  }
  .batchbar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 12px;
    background: rgba(45, 212, 191, 0.08);
    border-bottom: 1px solid rgba(45, 212, 191, 0.15);
    font-size: 0.74rem;
    color: var(--fg);
  }
  .batchbar .go,
  .batchbar .clearsel {
    border: 1px solid rgba(45, 212, 191, 0.4);
    background: transparent;
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    border-radius: 6px;
    padding: 3px 9px;
    cursor: pointer;
  }
  .batchbar .go:hover {
    background: rgba(45, 212, 191, 0.14);
  }
  .batchbar .clearsel {
    margin-left: auto;
    border-color: rgba(255, 92, 138, 0.3);
    color: #ff8ca8;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 50vh;
    overflow-y: auto;
  }
  li {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    border-radius: 6px;
    cursor: pointer;
  }
  li.sel,
  li:hover {
    background: rgba(45, 212, 191, 0.12);
  }
  .chk {
    flex: 0 0 auto;
    border: 0;
    background: transparent;
    color: var(--grey);
    font-size: 0.9rem;
    line-height: 1;
    padding: 2px 4px;
    cursor: pointer;
  }
  .chk.on {
    color: var(--teal);
  }
  .row-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .name {
    color: var(--teal);
    font-weight: 600;
    font-size: 0.9rem;
  }
  .dir {
    color: var(--grey);
    font-size: 0.72rem;
  }
  .empty {
    color: var(--grey);
    cursor: default;
  }

  /* 一括承認画面（複数案件の model/effort を起動前にまとめて確定する） */
  .approve {
    display: flex;
    flex-direction: column;
    max-height: 74vh;
  }
  .approve-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.2);
  }
  .approve-head .ttl {
    color: var(--fg);
    font-size: 0.86rem;
  }
  .approve-head .back {
    border: 1px solid rgba(45, 212, 191, 0.3);
    background: transparent;
    color: var(--teal);
    font-family: inherit;
    font-size: 0.72rem;
    border-radius: 6px;
    padding: 4px 10px;
    cursor: pointer;
  }
  .approve-head .back:hover {
    background: rgba(45, 212, 191, 0.12);
  }
  .bulk-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-bottom: 1px solid rgba(45, 212, 191, 0.12);
    font-size: 0.76rem;
  }
  .bulk-row .pl {
    color: var(--grey);
  }
  .bulk-row select {
    background: #0a1614;
    color: var(--fg);
    border: 1px solid rgba(45, 212, 191, 0.3);
    border-radius: 6px;
    font-size: 0.76rem;
    padding: 3px 6px;
  }
  .applybtn {
    border: 1px solid var(--teal);
    background: rgba(45, 212, 191, 0.14);
    color: var(--fg);
    font-family: inherit;
    font-size: 0.74rem;
    border-radius: 6px;
    padding: 3px 10px;
    cursor: pointer;
  }
  .approve-list {
    list-style: none;
    margin: 0;
    padding: 6px 14px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .approve-list li {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    cursor: default;
  }
  .approve-list li:hover {
    background: none;
  }
  .approve-list .name {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .approve-list select {
    background: #0a1614;
    color: var(--fg);
    border: 1px solid rgba(45, 212, 191, 0.25);
    border-radius: 6px;
    font-size: 0.74rem;
    padding: 3px 6px;
  }
  .launch-all {
    margin: 10px 14px 14px;
    border: 1px solid var(--teal);
    background: rgba(45, 212, 191, 0.16);
    color: var(--fg);
    font-family: inherit;
    font-size: 0.86rem;
    font-weight: 600;
    border-radius: 8px;
    padding: 10px 14px;
    cursor: pointer;
  }
  .launch-all:hover {
    background: rgba(45, 212, 191, 0.26);
  }
</style>
