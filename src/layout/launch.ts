import { invoke } from "@tauri-apps/api/core";
import { nextPaneId, setPaneModelEffort, setPaneCwd, markLaunchedAgent } from "../store/appStore";
import { openProjectTab } from "./tabs";
import { leaf, type PaneNode } from "./tree";
import { MODEL_OPTIONS, EFFORT_OPTIONS } from "../core/model-effort";

export interface Project {
  slug: string;
  name: string;
  dir: string;
  dev_cmd: string;
  dev_cwd: string;
  /** #82: 外部インボックス機能用のラベル（未設定なら従来どおり無ラベルで起動）。 */
  label?: string;
}

export function listProjects(): Promise<Project[]> {
  return invoke("list_projects");
}

/** pwsh で安全に cd するスニペット（シングルクオートは '' へエスケープ）。
 *  #Theme-C: `-ErrorAction Stop` を付ける＝dir が消えた/移動した/アンマウントされた等で
 *  Set-Location が失敗したら「終端エラー」を投げ、`;` で続く後段（claude 等）を実行させない。
 *  これが無いと cd 失敗時でも `; claude --continue --dangerously-skip-permissions`（yolo）が
 *  orb のホーム cwd で自動実行される＝間違ったディレクトリで危険モードが走る事故になる。
 *  -NoExit なので失敗しても対話シェルは残る（ユーザーは手で cd し直せる）。 */
export function cd(dir: string): string {
  return `Set-Location -LiteralPath '${dir.replace(/'/g, "''")}' -ErrorAction Stop`;
}

/** #Theme-F: 起動時に焼き込む model/effort の許可語彙（MODEL_OPTIONS/EFFORT_OPTIONS 由来）。
 *  現状は <select> の固定選択肢のみだが、将来 自由入力が混ざっても起動コマンド行へ
 *  任意文字列（`; rm -rf …` 等）が注入されないよう、既知の値だけを通す最終ゲートにする。 */
const MODEL_VALUES = new Set(MODEL_OPTIONS.map((o) => o.value));
const EFFORT_VALUES = new Set(EFFORT_OPTIONS.map((o) => o.value));

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
  // #Theme-F: 既知語彙（MODEL_VALUES/EFFORT_VALUES）に含まれる値だけ焼き込む。"default"/"auto"
  //  ＝claude 既定に任せる（フラグを付けない）。未知値は黙って無視＝注入経路を塞ぐ。
  if (opts?.model && opts.model !== "default" && MODEL_VALUES.has(opts.model)) cmd += ` --model ${opts.model}`;
  if (opts?.effort && opts.effort !== "auto" && EFFORT_VALUES.has(opts.effort)) cmd += ` --effort ${opts.effort}`;
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
    a: leaf(ai, `${cd(p.dir)}; ${buildClaudeCmd(preset, opts)}`, "ai", p.label),
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
  // #Theme-A(1): AI ペインの追跡 cwd を OSC マーカーを待たずに案件 dir へ即確定する。ランチャー
  //  起動の claude は P;Cwd マーカーを出さない（claude 終了まで prompt() が再発火しない）ため、
  //  これが無いと aiPaneCwd() が spawn 時のホームのまま＝#54 のチェックポイント捕捉が間違った
  //  リポで走る/no-op になり、復元セーフティネットが死ぬ。openProjectTab 後は ai が前景なので
  //  setPaneCwd はグローバル cwd 表示にも即反映される（後で本物の P;Cwd が来れば普通に上書き）。
  setPaneCwd(ai, p.dir);
  // #Theme-A(2): 「起動 claude 稼働中」フラグ。C マーカー不在でもアイドル判定・状態追跡を
  //  許可させ、待機/注意バッジ(#50)とキュー自動投入(#51)を生かす。claude 終了＝最初の A で解除。
  markLaunchedAgent(ai);
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

/** N ペインを横一列に均等分割する split ツリーを組む（columns3 の可変本数版）。 */
function rowOf(nodes: PaneNode[]): PaneNode {
  if (nodes.length === 1) return nodes[0];
  const [first, ...rest] = nodes;
  return { kind: "split", id: nextPaneId(), dir: "h", ratio: 1 / nodes.length, a: first, b: rowOf(rest) };
}

/**
 * 複数案件の AI ペインだけを、1つの新規タブにまとめて起動する（dev/git ペインは作らない）。
 * 複数の常駐セッションを同一画面に並べて見比べたい/連携させたい場合向け（例: labelを使った
 * 外部インボックス経由でお互いにメッセージを送り合う運用、#82）。
 *
 * レイアウト: 先頭の案件を「司令塔」として左半分を占有し、残りは右半分を横並びで均等分割する
 * （2件なら実質50/50の単純な左右分割、3件以上で右側がさらに分かれる）。1件だけの場合は
 * 単純に1ペインを占有する。
 *
 * タブの代表 AI ペイン（tab.ai、checkpoint 自動捕捉やサイドバーの model/effort 表示が紐づく）は
 * 先頭案件（司令塔）のものになる——既存の「タブ1つにつき AI ペイン1つ」という前提を崩さないための
 * 代表選出。他の AI ペインも role="ai"・label 付きで独立して動作する（この代表選出の影響を受けない）。
 */
export function launchAiRow(
  items: { project: Project; opts?: ModelEffort }[],
  preset: LaunchPreset = "continue",
): number[] {
  if (items.length === 0) return [];
  const aiIds = items.map(() => nextPaneId());
  const leaves = items.map((it, i) =>
    leaf(aiIds[i], `${cd(it.project.dir)}; ${buildClaudeCmd(preset, it.opts)}`, "ai", it.project.label),
  );
  const tree = leaves.length === 1 ? leaves[0] : {
    kind: "split" as const,
    id: nextPaneId(),
    dir: "h" as const,
    ratio: 0.5,
    a: leaves[0],
    b: rowOf(leaves.slice(1)),
  };
  const name = items.map((it) => it.project.name).join(" / ");
  openProjectTab(tree, aiIds[0], name);
  items.forEach((it, i) => {
    const ai = aiIds[i];
    setPaneCwd(ai, it.project.dir);
    markLaunchedAgent(ai);
    if (it.opts?.model && it.opts.model !== "default") setPaneModelEffort(ai, { model: it.opts.model });
    if (it.opts?.effort && it.opts.effort !== "auto") setPaneModelEffort(ai, { effort: it.opts.effort });
  });
  return aiIds;
}
