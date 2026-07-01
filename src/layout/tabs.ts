import { get, writable } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import {
  layout,
  focusedPane,
  aiPane,
  nextPaneId,
  peekPaneCounter,
  setPaneCounter,
  tabWelcome,
  primeScrollbackRestore,
} from "../store/appStore";
import { leaf, leafIds, type PaneNode } from "./tree";

/** 1 タブ = 独立したレイアウトツリー＋フォーカス＋AIペイン。 */
export interface Tab {
  id: number;
  layout: PaneNode | null;
  focused: number;
  ai: number | null;
  name?: string;
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
}

// ===== セッション永続化（再起動でタブ＆レイアウトを復元。PTY は新規 spawn） =====
const SESSION_KEY = "orb.session";
let saveTimer: number | undefined;

function saveSession() {
  try {
    const aid = get(activeTabId);
    const snap = get(tabs).map((t) =>
      t.id === aid
        ? { ...t, layout: get(layout), focused: get(focusedPane), ai: get(aiPane) }
        : t,
    );
    if (!snap.length) return;
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ tabs: snap, active: aid, counter: peekPaneCounter() }),
    );
  } catch {
    /* localStorage 不可でも動作は継続 */
  }
}
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveSession, 500);
}
layout.subscribe(scheduleSave);
tabs.subscribe(scheduleSave);
activeTabId.subscribe(scheduleSave);
focusedPane.subscribe(scheduleSave);

function makeTab(lay?: PaneNode): Tab {
  const id = nextPaneId();
  if (lay) {
    const ids = leafIds(lay);
    return { id, layout: lay, focused: ids[0] ?? nextPaneId(), ai: null };
  }
  const leafId = nextPaneId();
  return { id, layout: leaf(leafId), focused: leafId, ai: null };
}

/** 初回マウント時に最初のタブを用意する。前回セッションがあれば復元する。 */
export function ensureFirstTab() {
  if (get(tabs).length > 0) return;
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const data = JSON.parse(raw) as { tabs: Tab[]; active: number; counter: number };
      if (data?.tabs?.length) {
        setPaneCounter(data.counter ?? 0); // ID 衝突を防ぐ
        tabs.set(data.tabs);
        const active = data.tabs.find((t) => t.id === data.active) ?? data.tabs[0];
        activeTabId.set(active.id);
        loadTab(active);
        // #43: 起動時は自動復元しない（速度）。前回の scrollback はメモリへ退避され、
        // パレット「前回のセッションを復元」からオンデマンドで書き戻せる。
        primeScrollbackRestore(false);
        return;
      }
    }
  } catch {
    /* 壊れたセッションは無視して新規 */
  }
  primeScrollbackRestore(false); // #43: 起動時は自動復元しない（新規起動でも同様）
  const t = makeTab();
  tabs.set([t]);
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
