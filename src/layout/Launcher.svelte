<script lang="ts">
  import { onMount } from "svelte";
  import { listProjects, launchProject, type Project } from "./launch";

  let { onClose }: { onClose: () => void } = $props();

  let projects: Project[] = $state([]);
  let query = $state("");
  let selected = $state(0);
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
    launchProject(p);
    onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selected = Math.min(selected + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(selected - 1, 0);
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
