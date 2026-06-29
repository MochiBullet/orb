<script lang="ts">
  // P0 でここに TerminalView をマウントする。今はブート確認用プレースホルダ。
</script>

<main class="boot" data-tauri-drag-region>
  <h1>orb</h1>
  <p>vibe-coding terminal — booting…</p>
</main>

<style>
  .boot {
    height: 100vh;
    display: grid;
    place-content: center;
    text-align: center;
    gap: 0.5rem;
  }
  h1 {
    margin: 0;
    font-size: 3rem;
    letter-spacing: 0.35em;
    color: var(--teal);
    text-shadow: 0 0 24px rgba(45, 212, 191, 0.45);
  }
  p {
    margin: 0;
    color: var(--grey);
    letter-spacing: 0.1em;
  }
</style>
