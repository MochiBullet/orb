import { invoke } from "@tauri-apps/api/core";
import { nextPaneId, setPaneModelEffort } from "../store/appStore";
import { openProjectTab } from "./tabs";
import { leaf, type PaneNode } from "./tree";

export interface Project {
  slug: string;
  name: string;
  dir: string;
  dev_cmd: string;
  dev_cwd: string;
}

export function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

/** pwsh で安全に cd するスニペット（シングルクオートはエスケープ）。 */
function cd(dir: string): string {
  return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}'`;
}

/** AI ペインの Claude Code 起動プリセット（#38）。 */
export type LaunchPreset = "continue" | "fresh" | "yolo";

export const LAUNCH_PRESETS: { id: LaunchPreset; label: string; hint: string }[] = [
  { id: "continue", label: "継続", hint: "claude --continue" },
  { id: "fresh", label: "新規", hint: "claude" },
  { id: "yolo", label: "危険モード", hint: "claude --continue --dangerously-skip-permissions" },
];

/** サイドバーの model/effort プルダウンや案件ランチャーの一括起動承認で使う、起動時点で
 *  適用したい model/effort（"default"/"auto" または未指定 = claude 自身の既定に任せる）。 */
export interface ModelEffort {
  model?: string;
  effort?: string;
}

/** プリセットから claude 起動コマンド文字列を組む。既定(continue)は従来挙動そのまま。
 *  opts.model/opts.effort は claude CLI 自身の `--model`/`--effort` 起動時引数として渡す
 *  （スラッシュコマンドの後打ちだと claude 起動完了を待つ必要があり非同期起動と相性が悪い
 *  ため、起動コマンド自体に焼き込む）。値は MODEL_OPTIONS/EFFORT_OPTIONS 由来の固定語彙のみ
 *  想定（自由入力ではないためシェルエスケープ不要）。 */
export function buildClaudeCmd(preset: LaunchPreset, opts?: ModelEffort): string {
  let cmd: string;
  switch (preset) {
    case "fresh":
      cmd = "claude";
      break;
    case "yolo":
      cmd = "claude --continue --dangerously-skip-permissions";
      break;
    case "continue":
    default:
      cmd = "claude --continue";
  }
  if (opts?.model && opts.model !== "default") cmd += ` --model ${opts.model}`;
  if (opts?.effort && opts.effort !== "auto") cmd += ` --effort ${opts.effort}`;
  return cmd;
}

/**
 * dev3 レイアウトで案件を「新しいタブ」に起動する（#38: 既存タブを潰さない）。
 * 左=AI(claude, プリセット指定) / 右上=dev サーバ / 右下=git(lazygit)。
 * 各ペインは案件ディレクトリへ cd してからコマンドを実行し、タブ名は案件名にする。
 * opts で model/effort を指定した場合、サイドバーがそれを正しく表示できるよう
 * paneModelEffort にも記録する（config 由来の status だけでは全ペイン共通の値しか出せない）。
 * 戻り値は起動した AI ペインの ID（一括起動でまとめて記録する際に使う）。
 */
export function launchProject(p: Project, preset: LaunchPreset = "continue", opts?: ModelEffort): number {
  const ai = nextPaneId();
  const dev = nextPaneId();
  const git = nextPaneId();
  const devCwd = p.dev_cwd && p.dev_cwd.length > 0 ? p.dev_cwd : p.dir;

  const tree: PaneNode = {
    kind: "split",
    id: nextPaneId(),
    dir: "h",
    ratio: 0.4,
    a: leaf(ai, `${cd(p.dir)}; ${buildClaudeCmd(preset, opts)}`, "ai"),
    b: {
      kind: "split",
      id: nextPaneId(),
      dir: "v",
      ratio: 0.62,
      a: leaf(dev, `${cd(devCwd)}; ${p.dev_cmd}`),
      b: leaf(git, `${cd(p.dir)}; lg`),
    },
  };

  openProjectTab(tree, ai, p.name);
  if (opts?.model && opts.model !== "default") setPaneModelEffort(ai, { model: opts.model });
  if (opts?.effort && opts.effort !== "auto") setPaneModelEffort(ai, { effort: opts.effort });
  return ai;
}

/** 複数案件をまとめて起動する（一括承認フロー用）。案件ごとに model/effort を変えられる。
 *  auto mode で複数案件を長時間放置する運用を想定し、起動前に全部まとめて承認を済ませておけば
 *  起動後は個別に model/effort を訊き返さずに済む。 */
export function launchProjects(
  items: { project: Project; opts?: ModelEffort }[],
  preset: LaunchPreset = "continue",
): void {
  for (const { project, opts } of items) {
    launchProject(project, preset, opts);
  }
}
