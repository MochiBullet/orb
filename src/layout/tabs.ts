import { get, writable } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { layout, focusedPane, aiPane, nextPaneId } from "../store/appStore";
import { leaf, leafIds, type PaneNode } from "./tree";

/** 1 タブ = 独立したレイアウトツリー＋フォーカス＋AIペイン。 */
export interface Tab {
  id: number;
  layout: PaneNode | null;
  focused: number;
  ai: number | null;
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

function makeTab(lay?: PaneNode): Tab {
  const id = nextPaneId();
  if (lay) {
    const ids = leafIds(lay);
    return { id, layout: lay, focused: ids[0] ?? nextPaneId(), ai: null };
  }
  const leafId = nextPaneId();
  return { id, layout: leaf(leafId), focused: leafId, ai: null };
}

/** 初回マウント時に最初のタブを用意する。 */
export function ensureFirstTab() {
  if (get(tabs).length > 0) return;
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
