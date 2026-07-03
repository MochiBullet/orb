import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { aiPane, aiPaneActivity, getPaneCwd } from "../store/appStore";
import { logError } from "./log";

/** #54: 1件のチェックポイント（`git stash create` で捕捉した非破壊スナップショット）。 */
export interface Checkpoint {
  hash: string;
  created_at: number; // epoch ms
}

/** AI ペイン自身の cwd（フォーカス中ペインとは独立）。無ければ null（AI ペイン未設定/cwd未取得）。 */
function aiPaneCwd(): string | null {
  const id = get(aiPane);
  if (id == null) return null;
  return getPaneCwd(id) ?? null;
}

async function checkpointList(cwd: string): Promise<Checkpoint[]> {
  try {
    return await invoke<Checkpoint[]>("checkpoint_list", { cwd });
  } catch (e) {
    logError(`checkpoint list failed: ${String(e)}`);
    return [];
  }
}

export async function checkpointDiff(cwd: string, hash: string): Promise<string> {
  return invoke<string>("checkpoint_diff", { cwd, hash });
}

export async function checkpointRestore(cwd: string, hash: string): Promise<void> {
  return invoke("checkpoint_restore", { cwd, hash });
}

/** AI ペインの一覧・diff・restore をまとめて取り扱うためのヘルパー（cwd 解決込み）。 */
export function currentProjectCwd(): string | null {
  return aiPaneCwd();
}

export async function listCheckpointsForAiPane(): Promise<Checkpoint[]> {
  const cwd = aiPaneCwd();
  if (!cwd) return [];
  return checkpointList(cwd);
}

/** #54: AI ペインのターン開始（Enter 送信）ごとに、その時点の作業ツリーを非破壊で控える。
 *  git 未導入・非リポジトリ・無変更は Rust 側が静かに no-op にする（呼び出し側は結果を問わない）。
 *  Workspace.svelte の onMount から一度だけ呼ぶ（appStore モジュールレベルの購読と同じ流儀）。 */
export function initCheckpointCapture(): () => void {
  let first = true; // svelte store は subscribe 直後に現在値で1回発火する＝起動時の無駄撃ちを避ける
  return aiPaneActivity.subscribe(() => {
    if (first) {
      first = false;
      return;
    }
    const cwd = aiPaneCwd();
    if (!cwd) return;
    void invoke("checkpoint_capture", { cwd }).catch((e) =>
      logError(`checkpoint capture failed: ${String(e)}`),
    );
  });
}
