import { invoke } from "@tauri-apps/api/core";
import { nextPaneId } from "../store/appStore";
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

/** プリセットから claude 起動コマンド文字列を組む。既定(continue)は従来挙動そのまま。 */
export function buildClaudeCmd(preset: LaunchPreset): string {
  switch (preset) {
    case "fresh":
      return "claude";
    case "yolo":
      return "claude --continue --dangerously-skip-permissions";
    case "continue":
    default:
      return "claude --continue";
  }
}

/**
 * dev3 レイアウトで案件を「新しいタブ」に起動する（#38: 既存タブを潰さない）。
 * 左=AI(claude, プリセット指定) / 右上=dev サーバ / 右下=git(lazygit)。
 * 各ペインは案件ディレクトリへ cd してからコマンドを実行し、タブ名は案件名にする。
 */
export function launchProject(p: Project, preset: LaunchPreset = "continue"): void {
  const ai = nextPaneId();
  const dev = nextPaneId();
  const git = nextPaneId();
  const devCwd = p.dev_cwd && p.dev_cwd.length > 0 ? p.dev_cwd : p.dir;

  const tree: PaneNode = {
    kind: "split",
    id: nextPaneId(),
    dir: "h",
    ratio: 0.4,
    a: leaf(ai, `${cd(p.dir)}; ${buildClaudeCmd(preset)}`, "ai"),
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
}
