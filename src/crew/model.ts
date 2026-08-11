/**
 * Crew ビュー（ペイン＝キャラ）の純ロジック。DOM/Svelte/Tauri 非依存＝vitest 対象。
 *
 * 状態判定そのものは一切持たない。agent-status.ts が決めた PaneStatus を「席」と「見た目」へ
 * 写すだけ（判定を二重実装するとバッジ・通知・キャラの表示がズレる）。
 */
import { STATUS_LABEL, STATUS_PRIORITY, type PaneStatus } from "../core/agent-status";
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

/** 状態を持たないペインの吹き出し。STATUS_LABEL には足さない
 *  （idle は PaneStatus ではなく「バッジ無し」なので、バッジ/通知の意味論を変えない）。 */
export const CREW_IDLE_LABEL = "待機";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 経過時間の見出し。24時間で頭打ちにするのは、桁が増えて 168px を割るのを防ぐため。 */
export function formatElapsed(ms: number): string {
  const t = Math.max(0, ms);
  if (t >= DAY_MS) return "24時間+";
  const totalSec = Math.floor(t / 1000);
  const hours = Math.floor(totalSec / 3600);
  if (hours >= 1) return `${hours}時間${Math.floor((totalSec % 3600) / 60)}分`;
  return `${Math.floor(totalSec / 60)}分${totalSec % 60}秒`;
}

/** 吹き出しの中身。状態は文字で言う（色では言わない）。 */
export function bubbleText(status: PaneStatus | null, since: number | null, now: number): string {
  if (status == null) return CREW_IDLE_LABEL;
  const label = STATUS_LABEL[status];
  if (since == null) return label; // 時刻が無いのに経過を書くと嘘になる
  return `${label} ${formatElapsed(now - since)}`;
}
