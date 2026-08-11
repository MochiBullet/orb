/**
 * Crew ビュー（ペイン＝キャラ）の純ロジック。DOM/Svelte/Tauri 非依存＝vitest 対象。
 *
 * 状態判定そのものは一切持たない。agent-status.ts が決めた PaneStatus を「席」と「見た目」へ
 * 写すだけ（判定を二重実装するとバッジ・通知・キャラの表示がズレる）。
 */
import { STATUS_PRIORITY, type PaneStatus } from "../core/agent-status";
import type { PaneRole } from "../layout/tree";

/** キャラのポーズ。状態名そのまま＋バッジ無しの idle。 */
export type CrewPose = PaneStatus | "idle";

/** サイドバー幅 168px に収まる席数。 */
export const MAX_SEATS = 2;

export interface CrewCandidate {
  paneId: number;
  tabId: number;
  tabName: string;
  role: PaneRole;
  /** ランチャー由来のラベル（案件名）。 */
  label?: string;
  status: PaneStatus | null;
  /** status になった時刻(ms)。null = 不明。 */
  since: number | null;
  /** 直近のコマンド行。AI ペインでは常に "claude" なので描画側で出さない。 */
  command?: string | null;
}

function rank(s: PaneStatus | null): number {
  if (s == null) return STATUS_PRIORITY.length; // 状態無し＝最下位
  const i = STATUS_PRIORITY.indexOf(s);
  return i < 0 ? STATUS_PRIORITY.length : i;
}

/**
 * 手が要る順に並べ、上位 max 件を席に着ける。あふれた数も返す。
 * 元の配列は変更しない（$derived から呼ばれるため）。
 */
export function selectSeats(all: CrewCandidate[], max = MAX_SEATS): {
  seats: CrewCandidate[];
  overflow: number;
} {
  const sorted = [...all].sort((a, b) => rank(a.status) - rank(b.status) || a.paneId - b.paneId);
  return { seats: sorted.slice(0, max), overflow: Math.max(0, sorted.length - max) };
}

export function poseForStatus(s: PaneStatus | null | undefined): CrewPose {
  return s ?? "idle";
}

/** 枠に付けた名前を最優先。無ければ案件ラベル、それも無ければタブ名とペインID。 */
export function resolveName(slotName: string | undefined, c: CrewCandidate): string {
  const slot = slotName?.trim();
  if (slot) return slot;
  const label = c.label?.trim();
  if (label) return label;
  return `${c.tabName} · p${c.paneId}`;
}
