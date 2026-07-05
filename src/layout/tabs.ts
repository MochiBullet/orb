import { get, writable } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import {
  layout,
  focusedPane,
  aiPane,
  nextPaneId,
  tabWelcome,
  primeScrollbackRestore,
  broadcast,
} from "../store/appStore";
import { leaf, leafIds, type PaneNode } from "./tree";
import { findInfoTab, type TabKind } from "./tabs-logic";
import { config } from "../core/config";

/** 1 タブ = 独立したレイアウトツリー＋フォーカス＋AIペイン。
 *  kind: undefined は "term"（kind を付けない通常生成の既定）。
 *  "info" は PTY を持たない取扱説明書タブ（layout: null・ai: null）。 */
export interface Tab {
  id: number;
  layout: PaneNode | null;
  focused: number;
  ai: number | null;
  name?: string;
  kind?: TabKind;
}

export const tabs = writable<Tab[]>([]);
export const activeTabId = writable<number>(-1);

/** アクティブタブの現在状態(layout/focus/ai)を tabs に保存。 */
function saveActive() {
  const aid = get(activeTabId);
  tabs.update((ts) =>
    ts.map((t) =>
      t.id === aid
        ? { ...t, layout: get(layout), focused: get(focusedPane), ai: get(aiPane) }
        : t,
    ),
  );
}

/** タブの状態をグローバル store(layout/focus/ai)へ反映。 */
function loadTab(t: Tab) {
  layout.set(t.layout);
  focusedPane.set(t.focused);
  aiPane.set(t.ai);
  // #77 FN-4a: broadcast はタブに紐付かないグローバル state。ON のままタブを跨ぐと、
  // 切替先タブの見えていないペイン（vim/lazygit 等）へ気づかぬまま複製され続け、唯一の
  // 手掛かりが赤枠だけという事故りやすい挙動になる。タブが変わるたび（=loadTab のたび）
  // 必ず OFF へ戻す＝broadcast は「今見えているタブの中だけ」の一時状態に限定する。
  broadcast.set(false);
}

// ===== セッション永続化は #48 で廃止 =====
// PTY は復元できないため、タブ構造だけ戻すと「殻だけのタブ」が並んでいた。
// 起動時は常に fresh 構成（クラッシュ時も同一挙動）。旧バージョンが残した
// 保存データは ensureFirstTab が掃除する。scrollback の退避（appStore の
// SCROLLBACK_KEY）とパレット「前回のセッションを復元」は別キーで維持。
const SESSION_KEY = "orb.session";

function makeTab(lay?: PaneNode): Tab {
  const id = nextPaneId();
  if (lay) {
    const ids = leafIds(lay);
    return { id, layout: lay, focused: ids[0] ?? nextPaneId(), ai: null };
  }
  const leafId = nextPaneId();
  return { id, layout: leaf(leafId), focused: leafId, ai: null };
}

/** 初回起動用の AI タブ: claude は自動起動せず空シェル（claude 未導入環境でも安全）＋
 *  role="ai" のみ予約。ai を最初から埋めておくことで、サイドバーの model/effort
 *  プルダウンと claude 起動ボタンが起動直後から使える（#34 の続き）。 */
function makeAiTab(): Tab {
  const id = nextPaneId();
  const leafId = nextPaneId();
  return { id, layout: leaf(leafId, undefined, "ai"), focused: leafId, ai: leafId, name: "AI" };
}
function makeShellTab(): Tab {
  const id = nextPaneId();
  const leafId = nextPaneId();
  return { id, layout: leaf(leafId), focused: leafId, ai: null, name: "shell" };
}

/** #47: info（取扱説明書）タブ。PTY を持たない特殊タブ＝layout/ai とも null。
 *  focused は実在しないペイン ID(-1) にして、どのレジストリにもヒットさせない。 */
export function makeInfoTab(): Tab {
  return { id: nextPaneId(), kind: "info", layout: null, focused: -1, ai: null, name: "info" };
}

/** 初回マウント時に最初のタブを用意する。#48: タブ構造の復元は廃止し、常に fresh
 *  構成（AI + shell、設定 ON なら + info）で開始する。ペイン ID も毎回 1 から採番
 *  されるため、fresh 構成の AI/shell ペインは前回起動と同じ ID になり、パレット
 *  「前回のセッションを復元」（paneId キーの scrollback 書き戻し）が引き続き効く。 */
export function ensureFirstTab() {
  if (get(tabs).length > 0) return;
  try {
    // #48: 旧バージョンが残したタブ構造の保存データを掃除する（もう読まない）。
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* localStorage 不可でも動作は継続 */
  }
  // #43: 前回の scrollback をメモリへ退避（起動時の自動書き戻しはしない。
  // パレット「前回のセッションを復元」からオンデマンドで書き戻せる）。
  primeScrollbackRestore(false);
  // AI タブ + 通常シェルタブ（+ 設定 ON なら info タブ）で開始。
  // #47: info がある場合は初見の人がまず読めるよう info をアクティブにする。
  const aiTab = makeAiTab();
  const shellTab = makeShellTab();
  if (get(config).show_info_on_startup) {
    const infoTab = makeInfoTab();
    tabs.set([aiTab, shellTab, infoTab]);
    activeTabId.set(infoTab.id);
    loadTab(infoTab);
  } else {
    tabs.set([aiTab, shellTab]);
    activeTabId.set(aiTab.id);
    loadTab(aiTab);
  }
}

/** #47: パレット「info / 説明書を開く」。既存の info タブがあればアクティブ化、
 *  無ければ新規作成してアクティブ化する（重複作成しない）。 */
export function openInfoTab() {
  const existing = findInfoTab(get(tabs));
  if (existing) {
    switchTab(existing.id);
    return;
  }
  saveActive();
  const t = makeInfoTab();
  tabs.update((ts) => [...ts, t]);
  activeTabId.set(t.id);
  loadTab(t);
}

export function newTab(lay?: PaneNode) {
  saveActive();
  const t = makeTab(lay);
  tabs.update((ts) => [...ts, t]);
  activeTabId.set(t.id);
  loadTab(t);
  tabWelcome.update((n) => n + 1); // 新規タブで小さな welcome を出す
}

/** 案件ランチャー用: 新しいタブで案件を開く（既存タブを潰さない・#38）。
 *  ai ペイン ID と案件名（タブ名）を設定する。 */
export function openProjectTab(lay: PaneNode, aiPaneId: number, name: string) {
  saveActive();
  const t: Tab = { id: nextPaneId(), layout: lay, focused: aiPaneId, ai: aiPaneId, name };
  tabs.update((ts) => [...ts, t]);
  activeTabId.set(t.id);
  loadTab(t);
  tabWelcome.update((n) => n + 1);
}

export function switchTab(id: number) {
  if (id === get(activeTabId)) return;
  saveActive();
  const t = get(tabs).find((x) => x.id === id);
  if (t) {
    activeTabId.set(id);
    loadTab(t);
  }
}

/** タブ名を変更（空文字なら既定の "tab N" 表示へ戻す）。 */
export function renameTab(id: number, name: string) {
  tabs.update((ts) => ts.map((t) => (t.id === id ? { ...t, name: name.trim() || undefined } : t)));
}

export function closeTab(id: number) {
  const ts = get(tabs);
  if (ts.length <= 1) return; // 最後の1枚は残す
  const idx = ts.findIndex((x) => x.id === id);
  if (idx < 0) return;

  // 閉じるタブが持つ全ペインの PTY を kill（孤児防止）。
  const closing = ts[idx];
  const src = closing.id === get(activeTabId) ? get(layout) : closing.layout;
  if (src) for (const pid of leafIds(src)) void invoke("close_pty", { paneId: pid });

  const remaining = ts.filter((x) => x.id !== id);
  tabs.set(remaining);

  if (id === get(activeTabId)) {
    const next = remaining[Math.max(0, idx - 1)];
    activeTabId.set(next.id);
    loadTab(next);
  }
}
