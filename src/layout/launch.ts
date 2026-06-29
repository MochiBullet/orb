import { invoke } from "@tauri-apps/api/core";
import { nextPaneId, layout, focusedPane } from "../store/appStore";
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

/**
 * dev3 レイアウトで案件を起動する。
 * 左=AI(claude --continue) / 右上=dev サーバ / 右下=git(lazygit)。
 * 各ペインは案件ディレクトリへ cd してからコマンドを実行する。
 */
export function launchProject(p: Project): void {
  const ai = nextPaneId();
  const dev = nextPaneId();
  const git = nextPaneId();
  const devCwd = p.dev_cwd && p.dev_cwd.length > 0 ? p.dev_cwd : p.dir;

  const tree: PaneNode = {
    kind: "split",
    dir: "h",
    ratio: 0.4,
    a: leaf(ai, `${cd(p.dir)}; claude --continue`),
    b: {
      kind: "split",
      dir: "v",
      ratio: 0.62,
      a: leaf(dev, `${cd(devCwd)}; ${p.dev_cmd}`),
      b: leaf(git, `${cd(p.dir)}; lg`),
    },
  };

  layout.set(tree);
  focusedPane.set(ai);
}
