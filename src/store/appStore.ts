import { writable, get } from "svelte/store";
import type { PaneNode } from "../layout/tree";

/** OSC 633;P;Cwd マーカーで更新される現在の作業ディレクトリ（フォーカスペインのもの）。 */
export const cwd = writable<string>("");

/** ペインのレイアウトツリー（フロント権威）。null = 未初期化。 */
export const layout = writable<PaneNode | null>(null);

/** フォーカス中のペイン ID（分割・クローズ・枠ハイライトの対象）。 */
export const focusedPane = writable<number>(0);

/** AI(claude)ペインの ID。Ctrl+L で選択テキストの送信先になる。null=AIペイン無し。 */
export const aiPane = writable<number | null>(null);

/** 設定パネルの表示状態（TitleBar の歯車 / Ctrl+, から開く）。 */
export const showSettings = writable(false);

/** コマンドパレットの表示状態（ヘッダーの検索欄 / Ctrl+Shift+P から開く）。 */
export const showPalette = writable(false);

/** パレットを開く初期モード。ヘッダーの ⓘ から開くと "help"（取扱説明）で開く。 */
export const paletteMode = writable<"search" | "help">("search");

/** ブロードキャスト入力。ON の間、フォーカスペインへの入力を全ペインへ複製する。 */
export const broadcast = writable(false);

/** localStorage に永続する真偽ストア（トグルは一度設定すれば以後そのまま）。 */
function persistedBool(key: string, fallback: boolean) {
  let init = fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw != null) init = raw === "1";
  } catch {
    /* localStorage 不可でも既定で動作 */
  }
  const store = writable(init);
  store.subscribe((v) => {
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* 保存失敗は無視 */
    }
  });
  return store;
}

/** フォーカスモード(DND, VIBE_IDEAS #20)。ON の間は成功通知を抑制し、失敗だけ昇格する。
 *  永続なので「起動のたびに有効化」は不要＝一度 ON にすれば以後そのまま。 */
export const dnd = persistedBool("orb.dnd", false);

/** 新規タブ作成のたびに増えるカウンタ。Workspace が購読して小さな welcome を一瞬出す。
 *  初回タブ/セッション復元（ensureFirstTab）では増やさない＝起動直後に余計な演出を出さない。 */
export const tabWelcome = writable(0);

/** ペインごとの画面クリア関数レジストリ（paneId→term.clear）。
 *  Terminal が mount/destroy で登録解除し、Workspace の Ctrl+Shift+K / パレットから呼ぶ。 */
const termClearRegistry = new Map<number, () => void>();
export function registerTermClear(paneId: number, fn: () => void) {
  termClearRegistry.set(paneId, fn);
}
export function unregisterTermClear(paneId: number) {
  termClearRegistry.delete(paneId);
}
/** 指定ペインの画面をクリア（スクロールバックを消去）。 */
export function clearPane(paneId: number) {
  termClearRegistry.get(paneId)?.();
}

/** ペインごとの入力シンク（paneId → 入力バイトを端末の入力経路へ）。Terminal は
 *  spawn 前でも登録し、PTY 未起動の間はバッファへ積む＝起動直後の打鍵を落とさない。 */
const paneInputRegistry = new Map<number, (bytes: Uint8Array) => void>();
export function registerPaneInput(paneId: number, fn: (bytes: Uint8Array) => void) {
  paneInputRegistry.set(paneId, fn);
}
export function unregisterPaneInput(paneId: number) {
  paneInputRegistry.delete(paneId);
}
/** フォーカス中ペイン（無ければ任意の1ペイン）の端末入力経路へバイト列を届ける。
 *  端末未フォーカス時の外部入力ソースからフォーカスペインの入力経路（#39 バッファ）へ
 *  打鍵を流すのに使う。戻り値は届け先が在ったか（＝消えずに済んだか）。 */
export function sendInputToFocusedPane(bytes: Uint8Array): boolean {
  const fn = paneInputRegistry.get(get(focusedPane)) ?? paneInputRegistry.values().next().value;
  if (!fn) return false;
  fn(bytes);
  return true;
}

/** ペインごとの画面内容シリアライザ（paneId→ANSI 付き文字列を返す）。
 *  アプリ終了/リロード時に全ペイン分を保存し、再起動で過去ログとして復元する
 *  （PTY プロセス自体は復元不可なので「画面の記録」を書き戻して新シェルを起動する）。 */
const termSerializeRegistry = new Map<number, () => string>();
export function registerTermSerialize(paneId: number, fn: () => string) {
  termSerializeRegistry.set(paneId, fn);
}
export function unregisterTermSerialize(paneId: number) {
  termSerializeRegistry.delete(paneId);
}

const SCROLLBACK_KEY = "orb.scrollback";
const PER_PANE_MAX = 200_000; // 1 ペインあたりの保存上限（localStorage 5MB を圧迫しない）

/** アプリ終了/リロード時に全ペインの画面内容を localStorage へ保存。 */
export function saveScrollbacks() {
  try {
    const out: Record<number, string> = {};
    for (const [paneId, fn] of termSerializeRegistry) {
      let text = "";
      try {
        text = fn();
      } catch {
        continue;
      }
      if (!text) continue;
      if (text.length > PER_PANE_MAX) text = text.slice(text.length - PER_PANE_MAX);
      out[paneId] = text;
    }
    localStorage.setItem(SCROLLBACK_KEY, JSON.stringify(out));
  } catch {
    /* 保存失敗は無視（端末動作は継続） */
  }
}

/** 実行中に 1 ペイン分の画面内容を保存マップへ増分マージする（出力が落ち着くたびに呼ばれる）。
 *  saveScrollbacks は終了時の一括版。こちらは他ペインの保存を消さないよう既存マップへ読み書きする。 */
export function saveOneScrollback(paneId: number, text: string) {
  try {
    let map: Record<number, string> = {};
    try {
      const raw = localStorage.getItem(SCROLLBACK_KEY);
      if (raw) map = JSON.parse(raw);
    } catch {
      map = {};
    }
    if (!text) {
      delete map[paneId];
    } else {
      if (text.length > PER_PANE_MAX) text = text.slice(text.length - PER_PANE_MAX);
      map[paneId] = text;
    }
    localStorage.setItem(SCROLLBACK_KEY, JSON.stringify(map));
  } catch {
    /* 保存失敗は無視（端末動作は継続） */
  }
}

// 前回セッションの scrollback を起動時に一度だけメモリ(restoreCache)へ退避しておく。
// #43: 起動時の自動書き戻し（eager restore）は速度のため廃止。退避したスナップショットは
// パレットの「前回のセッションを復元」からオンデマンドでのみ消費する。ensureFirstTab が
// 一度だけ確定させる（セッション中の saveOneScrollback が localStorage を上書きしても、
// 前回分はこの時点でメモリへ写してあるので失われない）。
let restoreCache: Record<number, string> | null = null;
let restorePrimed = false;

/** ensureFirstTab から一度だけ呼ぶ。保存済み scrollback をメモリへ読み込み、オンデマンド
 *  復元で使えるよう退避する。#43 以降は起動時の自動書き戻しをしないため、引数 enabled は
 *  互換のための残置（自動復元の可否を分岐していた名残）で、常にスナップショットのみ退避する。 */
export function primeScrollbackRestore(enabled: boolean) {
  void enabled; // #43: 自動復元は廃止。分岐せず常にオンデマンド用スナップショットを退避。
  if (restorePrimed) return;
  restorePrimed = true;
  try {
    const raw = localStorage.getItem(SCROLLBACK_KEY);
    restoreCache = raw ? JSON.parse(raw) : null;
  } catch {
    restoreCache = null;
  }
}

/** 指定ペインの保存済み画面内容を取り出す（消費。一度取り出したら二度は返さない）。
 *  オンデマンド復元（パレット）から呼ぶ。 */
export function consumeScrollback(paneId: number): string | undefined {
  if (!restoreCache) return undefined;
  const text = restoreCache[paneId];
  if (text === undefined) return undefined;
  delete restoreCache[paneId];
  return text;
}

/** ペインごとの端末書き込みシンク（paneId→term.write）。オンデマンドの前回セッション復元で、
 *  退避しておいた画面内容をそのペインの端末へ書き戻すのに使う（registerTermClear と同じ流儀）。 */
const termWriteRegistry = new Map<number, (text: string) => void>();
export function registerTermWrite(paneId: number, fn: (text: string) => void) {
  termWriteRegistry.set(paneId, fn);
}
export function unregisterTermWrite(paneId: number) {
  termWriteRegistry.delete(paneId);
}
/** 指定ペインの端末へ文字列（ANSI 可）を書き込む。前回セッション復元で使う。 */
export function writeToPane(paneId: number, text: string): boolean {
  const fn = termWriteRegistry.get(paneId);
  if (!fn) return false;
  fn(text);
  return true;
}

/** ペインごとの cwd レジストリ。focus 切替時に旧ペイン値が残置しないよう、
 *  OSC Cwd を全ペイン分ここに溜め、focus 中ペインの値を cwd ストアへ即反映する。 */
const cwdRegistry = new Map<number, string>();

/** OSC 633;P;Cwd 受信時に呼ぶ（フォーカス中なら即 cwd ストアへ）。 */
export function setPaneCwd(paneId: number, dir: string) {
  cwdRegistry.set(paneId, dir);
  if (get(focusedPane) === paneId) cwd.set(dir);
}

// フォーカス変化で即その paneId の cwd へ追従（次の OSC Cwd を待たない＝残置を防ぐ）。
focusedPane.subscribe((pid) => cwd.set(cwdRegistry.get(pid) ?? ""));

let paneCounter = 0;
/** 単調増加のペイン ID を採番する。 */
export function nextPaneId(): number {
  return ++paneCounter;
}
/** セッション保存時に現在のカウンタを覗く。 */
export function peekPaneCounter(): number {
  return paneCounter;
}
/** セッション復元時、保存済み最大 ID 以上にカウンタを進める（ID 衝突防止）。 */
export function setPaneCounter(n: number) {
  if (n > paneCounter) paneCounter = n;
}

/** orb 起動時刻（稼働時間表示用）。 */
export const startedAt = Date.now();

/** サイドバーの左右位置（localStorage 永続、既定は右）。 */
const savedSide =
  typeof localStorage !== "undefined"
    ? (localStorage.getItem("orb.sidebarSide") as "left" | "right" | null)
    : null;
export const sidebarSide = writable<"left" | "right">(savedSide ?? "right");
sidebarSide.subscribe((s) => {
  try {
    localStorage.setItem("orb.sidebarSide", s);
  } catch {
    /* localStorage 不可でも動く */
  }
});
