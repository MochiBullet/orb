import { writable } from "svelte/store";
import type { PaneNode } from "../layout/tree";

/** OSC 633;P;Cwd マーカーで更新される現在の作業ディレクトリ（フォーカスペインのもの）。 */
export const cwd = writable<string>("");

/** ペインのレイアウトツリー（フロント権威）。null = 未初期化。 */
export const layout = writable<PaneNode | null>(null);

/** フォーカス中のペイン ID（分割・クローズ・枠ハイライトの対象）。 */
export const focusedPane = writable<number>(0);

/** AI(claude)ペインの ID。Ctrl+L で選択テキストの送信先になる。null=AIペイン無し。 */
export const aiPane = writable<number | null>(null);

let paneCounter = 0;
/** 単調増加のペイン ID を採番する。 */
export function nextPaneId(): number {
  return ++paneCounter;
}
