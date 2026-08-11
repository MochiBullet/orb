<script lang="ts">
  // Crew ビュー本体（サイドバーの1セクション）。#50 INBOX の後継＝全タブ横断で「手が要る順」に
  // 席を並べ、状態は吹き出しの文字で言う（色では言わない）。判定ロジックは一切持たず、
  // model.ts / char-svg.ts / sprite.ts に委ねるだけ（判定の二重実装で INBOX/バッジとズレるのを防ぐ）。
  import { onMount, onDestroy } from "svelte";
  import { convertFileSrc } from "@tauri-apps/api/core";
  import {
    selectSeats,
    poseForStatus,
    resolveName,
    bubbleText,
    type CrewCandidate,
  } from "./model";
  import { charSvg } from "./char-svg";
  import { validateSheet, frameRect, SPRITE_ORDER } from "./sprite";
  import { resolveCrewSpritePath, crewSpriteBaseReady } from "./sprite-path";
  import { layout, focusedPane, paneStatus, paneStatusSince, paneLastCommand } from "../store/appStore";
  import { config } from "../core/config";
  import { tabs, activeTabId, switchTab } from "../layout/tabs";
  import { leafIds, leafInfoMap, type PaneRole } from "../layout/tree";
  import { pushToast } from "../store/toasts";

  const CHAR_SIZE = 42; // 既定 SVG のキャラサイズ（design spec 準拠）。

  // 全タブ横断で候補を集める。アクティブタブだけ $layout を権威として使う
  // （Sidebar.svelte の旧 inbox 導出と同じ形。ここを外すと別タブの要承認ペインが消える）。
  let candidates = $derived.by(() => {
    const out: CrewCandidate[] = [];
    $tabs.forEach((t, i) => {
      const l = t.id === $activeTabId ? $layout : t.layout;
      if (!l) return;
      const info = new Map<number, { initialCmd?: string; role?: PaneRole; label?: string }>();
      leafInfoMap(l, info);
      for (const pid of leafIds(l)) {
        const meta = info.get(pid);
        out.push({
          paneId: pid,
          tabId: t.id,
          tabName: t.name ?? `tab ${i + 1}`,
          role: meta?.role ?? "shell",
          label: meta?.label,
          status: $paneStatus.get(pid) ?? null,
          since: $paneStatusSince.get(pid) ?? null,
          command: $paneLastCommand.get(pid) ?? null,
        });
      }
    });
    return out;
  });

  let seating = $derived(selectSeats(candidates));

  /** タブ切替 → フォーカス。フォーカスの購読(appStore の acknowledgePane)が確認済み扱いを
   *  勝手にやってくれるので、ここでは focusedPane を設定するだけでよい。 */
  function jumpToPane(c: CrewCandidate) {
    switchTab(c.tabId);
    focusedPane.set(c.paneId);
  }

  // ---- 経過時間の時計 ------------------------------------------------------
  // 席が0のとき／ウィンドウが非フォーカスのときは止める（背後のorbがCPUを焼かないため）。
  let now = $state(Date.now());
  let windowFocused = $state(true);
  let clockId: number | undefined;

  function onWindowFocus() {
    windowFocused = true;
  }
  function onWindowBlur() {
    windowFocused = false;
  }

  onMount(() => {
    windowFocused = document.hasFocus();
    window.addEventListener("focus", onWindowFocus);
    window.addEventListener("blur", onWindowBlur);
  });

  $effect(() => {
    const shouldTick = seating.seats.length > 0 && windowFocused;
    if (shouldTick && clockId === undefined) {
      now = Date.now(); // 再開直後の表示を最新化してから刻む
      clockId = window.setInterval(() => (now = Date.now()), 1000);
    } else if (!shouldTick && clockId !== undefined) {
      window.clearInterval(clockId);
      clockId = undefined;
    }
  });

  onDestroy(() => {
    if (clockId !== undefined) window.clearInterval(clockId);
    window.removeEventListener("focus", onWindowFocus);
    window.removeEventListener("blur", onWindowBlur);
  });

  // ---- スプライト差し替え ---------------------------------------------------
  // 検証結果を枠index単位でキャッシュする。読み込み失敗/コマ数不正は既定SVGへ戻し、
  // トーストで理由を出す（#79 のエラー可視化。黙って壊れた背景動画の再発防止）。
  let spriteFrame = $state<Map<number, number>>(new Map()); // slot -> 1コマの一辺(px)。無ければ未検証/失敗＝SVG
  const validatedFor = new Map<number, string>(); // slot -> 検証済みの sprite パス（同じ画像の再検証を避ける）
  const warnedFor = new Set<number>(); // slot -> 直近失敗を既にトーストしたか（連続再描画での連打防止）

  function warnSpriteFailure(slot: number, name: string, reason: string) {
    if (warnedFor.has(slot)) return;
    warnedFor.add(slot);
    pushToast("warn", `${name} の画像を読み込めませんでした。既定のキャラに戻します（${reason}）`);
  }

  $effect(() => {
    $crewSpriteBaseReady; // 依存登録のためだけに読む。boot 完了で true になり、下で
    // resolveCrewSpritePath が null 続きだったスロットをこの effect ごと再試行させる。
    const slots = $config.crew;
    for (let i = 0; i < slots.length; i++) {
      const sprite = slots[i]?.sprite?.trim() ?? "";
      if (!sprite) {
        validatedFor.delete(i);
        if (spriteFrame.has(i)) {
          spriteFrame = new Map(spriteFrame);
          spriteFrame.delete(i);
        }
        continue;
      }
      if (validatedFor.get(i) === sprite) continue; // 既に検証済みの同じ画像
      const resolved = resolveCrewSpritePath(sprite);
      if (!resolved) continue; // base 未解決。validatedFor に書かないので base 解決後に再試行される
      validatedFor.set(i, sprite);
      warnedFor.delete(i); // 画像が変わったら、また失敗し得るのでガードを解く
      const slotIndex = i;
      const name = slots[i]?.name?.trim() || `枠${i + 1}`;
      const img = new Image();
      img.onload = () => {
        const res = validateSheet(img.naturalWidth, img.naturalHeight);
        if (res.ok) {
          spriteFrame = new Map(spriteFrame).set(slotIndex, res.frame);
        } else {
          warnSpriteFailure(slotIndex, name, res.reason);
        }
      };
      img.onerror = () => {
        warnSpriteFailure(slotIndex, name, "画像を読み込めませんでした");
      };
      img.src = convertFileSrc(resolved);
    }
  });
</script>

{#each seating.seats as seat, i (seat.paneId)}
  {@const slot = $config.crew[i]}
  {@const pose = poseForStatus(seat.status)}
  {@const frame = spriteFrame.get(i)}
  {@const spriteSrc = slot?.sprite ? resolveCrewSpritePath(slot.sprite) : null}
  <button
    class="seat"
    onclick={() => jumpToPane(seat)}
    title="クリックでジャンプ: {seat.tabName} / pane {seat.paneId}"
  >
    <span class="char">
      {#if slot?.sprite && frame && spriteSrc}
        <!-- サイドバーは168px固定。差し替えシートの元解像度(frame=validateSheetの検査値、
             64pxでも128pxでも)に関わらず、既定SVGと同じ CHAR_SIZE で表示する。シート全体を
             CHAR_SIZE*コマ数 幅へ拡縮し、ポーズのコマ番号 × CHAR_SIZE だけ左へオフセットして
             CHAR_SIZE四方の窓で切り抜く（frame は妥当性判定にのみ使い、レイアウトには使わない）。 -->
        <span class="sprite-box" style="width:{CHAR_SIZE}px;height:{CHAR_SIZE}px">
          <img
            class="sprite"
            src={convertFileSrc(spriteSrc)}
            alt=""
            style="width:{CHAR_SIZE * SPRITE_ORDER.length}px;height:{CHAR_SIZE}px;object-position:-{frameRect(pose, CHAR_SIZE).x}px 0"
          />
        </span>
      {:else}
        {@html charSvg(pose, slot?.color, CHAR_SIZE)}
      {/if}
    </span>
    <span class="info">
      <span class="bubble">{bubbleText(seat.status, seat.since, now)}</span>
      <span class="name">{resolveName(slot?.name, seat)}</span>
      {#if seat.role === "shell" && seat.command}
        <span class="cmd">{seat.command}</span>
      {/if}
    </span>
  </button>
{/each}
{#if seating.overflow > 0}
  <div class="overflow">他 {seating.overflow} 人</div>
{/if}

<style>
  .seat {
    display: flex;
    align-items: flex-start;
    gap: 5px;
    width: 100%;
    border: 1px solid rgba(45, 212, 191, 0.18);
    border-radius: 6px;
    background: transparent;
    color: var(--fg);
    font-family: inherit;
    text-align: left;
    padding: 5px;
    margin-bottom: 6px;
    cursor: pointer;
    box-sizing: border-box;
    transition: transform 0.12s ease, border-color 0.12s ease;
  }
  .seat:hover {
    border-color: rgba(45, 212, 191, 0.45);
    transform: translateY(-1px);
  }
  @media (prefers-reduced-motion: reduce) {
    .seat {
      transition: none;
    }
    .seat:hover {
      transform: none;
    }
  }
  .char {
    flex: 0 0 auto;
    line-height: 0;
  }
  .sprite-box {
    display: block;
    overflow: hidden;
  }
  .sprite {
    display: block;
    /* シート全体を width/height の指定どおりに拡縮する（object-fit: none だと指定サイズを
       無視して原寸のまま描画されてしまい、128px 原寸シートが168px幅のサイドバーを突き破る）。
       img 自身の width/height は常にシート原寸と同じアスペクト比（CHAR_SIZE*コマ数 : CHAR_SIZE）
       で指定しているので、fill でも歪まない。 */
    object-fit: fill;
  }
  .info {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* 吹き出し: しっぽを左（キャラ側）へ出す。色分けはしない＝状態は文字だけで言う。 */
  .bubble {
    position: relative;
    display: block;
    background: rgba(255, 255, 255, 0.07);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 5px;
    padding: 3px 6px;
    font-size: 0.6rem;
    color: var(--fg);
    /* 168px 幅では「要承認 24時間+」級の長文が単語の途中(数字+記号の間)で
       割れることがある。break-word は使わず既定の折返し(空白/かな区切り)に任せ、
       割れる時も語の途中で千切れないようにする。 */
    word-break: keep-all;
    overflow-wrap: normal;
  }
  .bubble::before {
    content: "";
    position: absolute;
    left: -5px;
    top: 8px;
    width: 0;
    height: 0;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    border-right: 5px solid rgba(255, 255, 255, 0.12);
  }
  .name {
    font-size: 0.64rem;
    color: var(--grey);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cmd {
    font-size: 0.6rem;
    color: var(--grey);
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: "Cascadia Code", "Consolas", monospace;
  }
  .overflow {
    font-size: 0.64rem;
    color: var(--grey);
    text-align: right;
  }
</style>
