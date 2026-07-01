<script lang="ts">
  import { onMount } from "svelte";
  import {
    listProjects,
    launchProject,
    LAUNCH_PRESETS,
    type Project,
    type LaunchPreset,
  } from "./launch";

  let { onClose }: { onClose: () => void } = $props();

  let projects: Project[] = $state([]);
  let query = $state("");
  let selected = $state(0);
  let preset = $state<LaunchPreset>("continue"); // AI ペインの claude 起動プリセット(#38)
  let input: HTMLInputElement | undefined;

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

  function cyclePreset() {
    const i = LAUNCH_PRESETS.findIndex((x) => x.id === preset);
    preset = LAUNCH_PRESETS[(i + 1) % LAUNCH_PRESETS.length].id;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, Math.max(filtered.length - 1, 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
    } else if (e.key === "Tab") {
      e.preventDefault();
      cyclePreset(); // Tab で AI 起動プリセットを巡回
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = filtered[selected];
      if (p) choose(p);
    }
  }
</script>

<div class="overlay" onpointerdown={onClose} role="presentation">
  <div class="palette" onpointerdown={(e) => e.stopPropagation()} role="presentation">
    <input
      bind:this={input}
      bind:value={query}
      onkeydown={onKey}
      oninput={() => (selected = 0)}
      placeholder="案件を検索して Enter で起動…  (dev3: AI / dev / lazygit)"
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
    <ul>
      {#each filtered as p, i (p.slug)}
        <li class:sel={i === selected} onpointerdown={() => choose(p)}>
          <span class="name">{p.name}</span>
          <span class="dir">{p.dir}</span>
        </li>
      {/each}
      {#if filtered.length === 0}
        <li class="empty">該当なし</li>
      {/if}
    </ul>
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
      radial-gradient(ellipse at 70% 65%, rgba(167, 139, 250, 0.13), transparent 55%);
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
  ul {
    list-style: none;
    margin: 0;
    padding: 6px;
    max-height: 50vh;
    overflow-y: auto;
  }
  li {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
  }
  li.sel,
  li:hover {
    background: rgba(45, 212, 191, 0.12);
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
</style>
