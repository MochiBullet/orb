<script lang="ts">
  // Crew ビュー: アクティブタブのペインを 1 体ずつのアイソメなキャラとして上部の帯に描く。
  // 状態は agent-status.ts の PaneStatus に完全に乗る（ここで判定は一切しない）。
  // 動かすのは transform と opacity だけ＝compositor-only（PERFORMANCE.md）。
  import { fade } from "svelte/transition";
  import { layout, paneStatus, focusedPane } from "../store/appStore";
  import { leafIds, leafInfoMap, type PaneRole } from "../layout/tree";
  import { STATUS_LABEL, type PaneStatus } from "../core/agent-status";
  import { buildCrew, seatToIso, SEAT_COLS, SEAT_ROWS, TILE_W, TILE_H } from "./model";

  // 床は席の格子より 1 マスずつ外側まで敷いて、キャラが端に立っても床が途切れないようにする。
  const FLOOR = (() => {
    const cells: { col: number; row: number; x: number; y: number }[] = [];
    for (let row = -1; row <= SEAT_ROWS; row++) {
      for (let col = -1; col <= SEAT_COLS; col++) {
        cells.push({ col, row, x: (col - row) * (TILE_W / 2), y: (col + row) * (TILE_H / 2) });
      }
    }
    return cells;
  })();

  // 格子全体の中心。ステージ原点をここへずらして帯の中央に置く。
  const CENTER_X = ((SEAT_COLS - 1) / 2 - (SEAT_ROWS - 1) / 2) * (TILE_W / 2);
  const CENTER_Y = ((SEAT_COLS - 1) / 2 + (SEAT_ROWS - 1) / 2) * (TILE_H / 2);
  // キャラは席の点から上へ 70px ほど伸びるので、格子の幾何中心をそのまま帯の中央に
  // 置くと絵全体が上に寄る。視覚的な重心が中央へ来るぶんだけ下へずらす。
  const STAGE_Y = -CENTER_Y + 14;

  // 絵全体の縦の実寸(px): 最奥キャラの吹き出し上端から、最前列タイル/名前ラベルの下端まで。
  // 帯(ウィンドウの 1/4)がこれより低い窓では、はみ出す代わりに全体を縮める。
  const CONTENT_H = 215;
  let bandH = $state(0);
  let scale = $derived(bandH > 0 ? Math.min(1, bandH / CONTENT_H) : 1);

  let info = $derived.by(() => {
    const m = new Map<number, { role?: PaneRole; label?: string }>();
    if ($layout) leafInfoMap($layout, m);
    return m;
  });
  let crew = $derived(buildCrew(leafIds($layout), info, $paneStatus));

  // ホバー時のツールチップ。状態名は STATUS_LABEL を再利用する（バッジと同じ文言に揃える）。
  function tipText(label: string, status: PaneStatus | null): string {
    return status ? `${label} — ${STATUS_LABEL[status]}` : label;
  }

  // 入場: 新しいキャラを最初の 1 フレームだけ帯の左外に置き、次のフレームで席へ移す。
  // 位置の補間は .member の CSS transition が行うので、JS 側は「もう着席したか」の集合を
  // 1 度だけ更新するだけ＝毎フレームのループは無い。
  //
  // paneId は nextPaneId() の単調増加で再利用されないため、閉じたペインの id が seated に
  // 残っても誤って「着席済み」と判定されることはない（掃除は不要）。
  const ENTRY_X = -300;
  let seated = $state(new Set<number>());
  $effect(() => {
    const missing = crew.map((c) => c.paneId).filter((id) => !seated.has(id));
    if (missing.length === 0) return;
    const raf = requestAnimationFrame(() => {
      seated = new Set([...seated, ...missing]);
    });
    return () => cancelAnimationFrame(raf);
  });

  // 非フォーカス時はアニメーションを止める（裏に回った orb が CPU を使い続けないように）。
  let windowFocused = $state(true);
  $effect(() => {
    const on = () => (windowFocused = true);
    const off = () => (windowFocused = false);
    window.addEventListener("focus", on);
    window.addEventListener("blur", off);
    return () => {
      window.removeEventListener("focus", on);
      window.removeEventListener("blur", off);
    };
  });
</script>

<div class="crew" class:paused={!windowFocused} bind:clientHeight={bandH}>
  <!-- scale を先に書く＝translate ごと拡縮されるので、縮めても帯の中央に収まったままになる。 -->
  <div class="stage" style:transform="scale({scale}) translate3d({-CENTER_X}px, {STAGE_Y}px, 0)">
    {#each FLOOR as f (`${f.col},${f.row}`)}
      <div class="tile" aria-hidden="true" style:transform="translate3d({f.x}px, {f.y}px, 0)"></div>
    {/each}
    {#each crew as m (m.paneId)}
      {@const p = seatToIso(m.seat)}
      <!-- 押せる実体なので div ではなく button。キーボードでも到達でき、状態が読み上げに乗る。 -->
      <button
        class="member {m.action} {m.facing}"
        class:focused={$focusedPane === m.paneId}
        style:transform="translate3d({seated.has(m.paneId) ? p.x : ENTRY_X}px, {p.y}px, 0)"
        title={tipText(m.label, m.status)}
        aria-label={tipText(m.label, m.status)}
        onclick={() => focusedPane.set(m.paneId)}
        out:fade={{ duration: 320 }}
      >
        <!-- 描画順がそのまま前後関係。人を描いたあとに机と画面を重ねると
             「机の向こうに座っている」ように見える（脚と胴の下半分が隠れる）。 -->
        <div class="shadow"></div>
        <div class="rig">
          <div class="body"></div>
          <div class="head"></div>
        </div>
        <div class="desk"></div>
        <div class="screen"></div>
        {#if m.action === "calling" || m.action === "urgent"}
          <div class="bubble">{m.action === "urgent" ? "!" : "?"}</div>
        {/if}
        <div class="name">{m.label}</div>
      </button>
    {/each}
  </div>
</div>

<style>
  /* .stack は flex column。ここだけ 25% を固定で取れば .body(flex:1 1 auto) が
     自動的に残り 3/4 に縮む＝既存レイアウトへの影響はこの 1 箇所で閉じる。 */
  .crew {
    flex: 0 0 25%;
    position: relative;
    overflow: hidden;
    background: linear-gradient(180deg, var(--dark), var(--black));
    border-bottom: 1px solid var(--surface);
  }
  /* 帯の中央に置いた 0 サイズの原点。子はここからの transform だけで配置する。 */
  .stage {
    position: absolute;
    left: 50%;
    top: 50%;
    width: 0;
    height: 0;
  }
  .stage > * {
    position: absolute;
  }
  /* 菱形タイル。clip-path なので rotate+scale の寸法ズレが起きない。
     格子ピッチ(96×48)より一回り小さく描き、生まれた隙間で格子を見せる
     （clip-path は border も一緒に切り落とすので、線ではなく隙間で表現する）。 */
  .tile {
    width: 90px;
    height: 45px;
    margin-left: -45px;
    margin-top: -22.5px;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
    background: var(--surface);
    opacity: 0.5;
  }
  .member {
    --crew-c: var(--grey);
    --crew-amber: #fbbf24;
    /* button の既定装飾を落とす（当たり判定は絶対配置した子が持つ）。 */
    appearance: none;
    background: none;
    border: 0;
    padding: 0;
    font: inherit;
    color: inherit;
    width: 0;
    height: 0;
    cursor: pointer;
    /* 席が詰んだ時の移動。transform だけを補間するので歩いているように見える。 */
    transition: transform 0.9s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .member:focus-visible .head {
    outline: 2px solid var(--teal);
    outline-offset: 2px;
  }
  .member > * {
    position: absolute;
  }
  .member.typing {
    --crew-c: var(--teal);
  }
  .member.calling {
    --crew-c: var(--crew-amber);
  }
  .member.urgent {
    --crew-c: var(--violet);
  }
  .member.resting {
    --crew-c: var(--mint);
  }
  .member.down {
    --crew-c: var(--red);
  }
  /* 机（床タイルと同じ菱形）と、その上に載る画面。人より後に描くので手前に来る。 */
  .desk {
    width: 54px;
    height: 27px;
    left: -27px;
    top: -8px;
    clip-path: polygon(50% 0, 100% 50%, 50% 100%, 0 50%);
    /* 床タイル(--surface の半透明)より明るくして、床ではなく家具として読ませる。 */
    background: var(--surface);
    filter: brightness(1.7);
  }
  .screen {
    width: 22px;
    height: 15px;
    left: -11px;
    top: -20px;
    border-radius: 2px;
    background: var(--black);
    border: 1px solid var(--surface);
  }
  .shadow {
    width: 32px;
    height: 16px;
    left: -16px;
    top: -8px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.45);
  }
  .rig {
    width: 0;
    height: 0;
  }
  .rig > * {
    position: absolute;
  }
  .body {
    width: 23px;
    height: 33px;
    left: -11.5px;
    top: -38px;
    border-radius: 11px 11px 6px 6px;
    background: var(--crew-c);
  }
  .head {
    width: 20px;
    height: 20px;
    left: -10px;
    top: -56px;
    border-radius: 50%;
    background: var(--crew-c);
    filter: brightness(1.25);
  }
  /* front(こちら向き)だけ目を描く。「目が合ったら自分の番」が一目で分かる。 */
  .member.front .head::before,
  .member.front .head::after {
    content: "";
    position: absolute;
    top: 8px;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--dark);
  }
  .member.front .head::before {
    left: 4px;
  }
  .member.front .head::after {
    right: 4px;
  }
  .name {
    left: -40px;
    top: 22px;
    width: 80px;
    text-align: center;
    font-size: 9px;
    line-height: 1.2;
    color: var(--grey);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* 席が埋まるとラベル同士が重なって全部読めなくなるので、常時は出さない。
       フォーカス中の 1 人とホバー中の 1 人だけ名乗る（全員分の名前は title で引ける）。 */
    opacity: 0;
    transition: opacity 0.15s ease-out;
  }
  .member:hover .name,
  .member:focus-visible .name,
  .member.focused .name {
    opacity: 1;
    color: var(--fg);
  }

  /* 動かすのは transform / opacity / filter のみ。位置決めの transform は .member 側が
     持っているので、アニメーションは必ず内側の .rig に当てる（打ち消し事故を防ぐ）。 */
  @keyframes crew-bob {
    from {
      transform: translateY(0);
    }
    to {
      transform: translateY(-2px);
    }
  }
  @keyframes crew-hop {
    0%,
    100% {
      transform: translateY(0);
    }
    40% {
      transform: translateY(-9px);
    }
  }
  @keyframes crew-breathe {
    from {
      transform: scaleY(1);
    }
    to {
      transform: scaleY(1.03);
    }
  }
  @keyframes crew-blink {
    from {
      opacity: 1;
    }
    to {
      opacity: 0.45;
    }
  }
  .typing .rig {
    animation: crew-bob 0.35s ease-in-out infinite alternate;
  }
  .urgent .rig {
    animation: crew-hop 0.6s ease-in-out infinite;
  }
  .idle .rig,
  .resting .rig {
    transform-origin: bottom center;
    animation: crew-breathe 2.4s ease-in-out infinite alternate;
  }
  .calling .rig {
    animation: crew-blink 0.9s ease-in-out infinite alternate;
  }
  /* 落ちたキャラは色を抜いて少し沈める。動かないこと自体が失敗のサイン。 */
  .down .rig {
    transform: translateY(3px);
    filter: grayscale(1);
  }
  .typing .screen {
    background: color-mix(in srgb, var(--crew-c) 22%, var(--black));
    box-shadow: 0 0 9px var(--crew-c);
  }
  .urgent .screen,
  .calling .screen {
    box-shadow: 0 0 11px var(--crew-c);
  }
  .bubble {
    left: 10px;
    top: -72px;
    padding: 1px 7px;
    border-radius: 8px;
    background: var(--surface);
    color: var(--fg);
    font-size: 12px;
    line-height: 1.4;
    font-weight: 700;
  }
  /* 非フォーカス時 / 動き軽減設定で全アニメーションを止める。 */
  .crew.paused :global(*) {
    animation-play-state: paused;
  }
  @media (prefers-reduced-motion: reduce) {
    .rig {
      animation: none !important;
    }
    .member {
      transition: none;
    }
  }
</style>
