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

/** 起動時オープニング（WELCOME ORB スプラッシュ）の表示状態。App 起動時 / パレットの再生から true。 */
export const showSplash = writable(false);

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
