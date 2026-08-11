import { invoke } from "@tauri-apps/api/core";
import { get } from "svelte/store";
import { nextPaneId, setPaneModelEffort, setPaneCwd, markLaunchedAgent, layout, workspaceWidthPx } from "../store/appStore";
import { openProjectTab } from "./tabs";
import { leaf, type PaneNode } from "./tree";
import { MODEL_OPTIONS, EFFORT_OPTIONS } from "../core/model-effort";
import { pushToast } from "../store/toasts";

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

/** サイドバーのクイック起動ボタン1件分（projects.toml の [[quick_launch]]）。 */
export interface QuickLaunch {
  name: string;
  slugs: string[];
  width_px: number;
}

export function listQuickLaunch(): Promise<QuickLaunch[]> {
  return invoke("list_quick_launch");
}

/** slug 群を案件一覧に対して解決する純ロジック。順序を保ち、未知の slug は落として
 *  dropped に集める（呼び出し側がトーストで報告するための情報。押したのに何も起きない
 *  ように見える「静かな失敗」を作らないため、必ず何が落ちたか分かるようにしておく）。 */
export function resolveQuickLaunchSlugs(
  slugs: string[],
  projects: Project[],
): { resolved: Project[]; dropped: string[] } {
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const resolved: Project[] = [];
  const dropped: string[] = [];
  for (const slug of slugs) {
    const p = bySlug.get(slug);
    if (p) resolved.push(p);
    else dropped.push(slug);
  }
  return { resolved, dropped };
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
    a: leaf(ai, `${cd(p.dir)}; ${buildClaudeCmd(preset, opts)}`, "ai", p.label, p.name),
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

/** N ペインを一列（dir 方向）に均等分割する split ツリーを組む（columns3 の可変本数版）。
 *  launchAiRow の横並び行と、クイック起動の縦積み列の両方がこれを共有する。 */
function equalSplit(nodes: PaneNode[], dir: "h" | "v"): PaneNode {
  if (nodes.length === 1) return nodes[0];
  const [first, ...rest] = nodes;
  return { kind: "split", id: nextPaneId(), dir, ratio: 1 / nodes.length, a: first, b: equalSplit(rest, dir) };
}

/** 各案件を AI ペイン(leaf) に組み立てる。cd+claude起動コマンド・role・ルーティングlabel・
 *  表示名title の組み方は launchAiRow / クイック起動で共通（呼び出し元をまたいで揃えるための
 *  唯一の場所）。 */
function buildAiLeaves(
  items: { project: Project; opts?: ModelEffort }[],
  preset: LaunchPreset,
): { leaves: PaneNode[]; aiIds: number[] } {
  const aiIds = items.map(() => nextPaneId());
  const leaves = items.map((it, i) =>
    leaf(aiIds[i], `${cd(it.project.dir)}; ${buildClaudeCmd(preset, it.opts)}`, "ai", it.project.label, it.project.name),
  );
  return { leaves, aiIds };
}

/** buildAiLeaves で組んだ各 AI ペインの cwd 追跡・起動中フラグ・model/effort 記録を確定する
 *  （タブへどう配置したかに関わらず共通の後処理）。 */
function registerAiRowPanes(items: { project: Project; opts?: ModelEffort }[], aiIds: number[]): void {
  items.forEach((it, i) => {
    const ai = aiIds[i];
    setPaneCwd(ai, it.project.dir);
    markLaunchedAgent(ai);
    if (it.opts?.model && it.opts.model !== "default") setPaneModelEffort(ai, { model: it.opts.model });
    if (it.opts?.effort && it.opts.effort !== "auto") setPaneModelEffort(ai, { effort: it.opts.effort });
  });
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
  const { leaves, aiIds } = buildAiLeaves(items, preset);
  const tree = leaves.length === 1 ? leaves[0] : {
    kind: "split" as const,
    id: nextPaneId(),
    dir: "h" as const,
    ratio: 0.5,
    a: leaves[0],
    b: equalSplit(leaves.slice(1), "h"),
  };
  const name = items.map((it) => it.project.name).join(" / ");
  openProjectTab(tree, aiIds[0], name);
  registerAiRowPanes(items, aiIds);
  return aiIds;
}

// ---- サイドバーのクイック起動ボタン --------------------------------------------------------
// launchAiRow（新規タブ・司令塔+横並び）とは別の配置: 「今見ているタブ」のレイアウトはそのまま
// 残し（=既存ペインは一切壊さない）、右側に細い縦長ペイン列を1本足すだけ。常時起動している
// 主ペインの隣に補助ペインを添えたいだけ、という運用向け（新規タブを増やさない）。

/** ドラッグ分割(Workspace.svelte の startDrag)の 0.15/0.85 とは別の緩いクランプ。この列は
 *  そもそも「狭い常駐ペイン」前提（既定 168px）で使われるため、ドラッグ用の下限をそのまま
 *  流用すると既定値ですら下限へ丸められて狭さの意図が消えてしまう。ここでは 0除算・符号反転・
 *  画面を飲み込む/消えるだけを避ける最小限のガードに留める。 */
const MIN_QUICK_LAUNCH_RATIO = 0.05;
const MAX_QUICK_LAUNCH_RATIO = 0.9;
/** ワークスペース実寸が取れない/0以下の時のフォールバック比率（新ペイン側の取り分）。 */
const FALLBACK_QUICK_LAUNCH_RATIO = 0.2;

/** クイック起動ペイン列の幅(px)を、作成時点のワークスペース実寸(px)から split 比率
 *  （新ペイン側=右側の取り分, 0..1）へ換算する。orb の分割は比率ベースで px を保持し
 *  続けられない（ウィンドウをリサイズすると比率のまま追従する設計）ため、ボタンを押した
 *  瞬間の実寸だけを基準に一度だけ換算する。
 *  実寸が取得できない/0以下なら FALLBACK_QUICK_LAUNCH_RATIO にフォールバック（0除算で
 *  レイアウトを壊さない）。結果は [MIN_QUICK_LAUNCH_RATIO, MAX_QUICK_LAUNCH_RATIO] へ
 *  クランプし、極端な width_px 指定（ワークスペースより大きい／0／負値）でも既存コンテンツが
 *  消える・新規ペインがつぶれる、を避ける。 */
export function widthPxToRatio(widthPx: number, workspaceWidthPxVal: number): number {
  const fraction = workspaceWidthPxVal > 0 ? widthPx / workspaceWidthPxVal : FALLBACK_QUICK_LAUNCH_RATIO;
  return Math.min(MAX_QUICK_LAUNCH_RATIO, Math.max(MIN_QUICK_LAUNCH_RATIO, fraction));
}

/** クイック起動で並べる各案件を縦積みの split ツリーに組む（1件ならそのまま1ペイン）。
 *  leaf() の組み方は buildAiLeaves を経由するため launchAiRow と揃う。 */
function buildQuickLaunchColumn(
  items: { project: Project }[],
  preset: LaunchPreset,
): { tree: PaneNode; aiIds: number[] } {
  const { leaves, aiIds } = buildAiLeaves(items, preset);
  return { tree: equalSplit(leaves, "v"), aiIds };
}

/**
 * クイック起動ボタン1個分の実処理（サイドバー用）。config の slugs を案件一覧に対して解決し、
 * 縦積みの AI ペイン列を「今見ているタブ」のレイアウト全体(a)の右側(b)へ水平分割で追加する。
 * 新しいタブは増やさず、既存レイアウトも一切壊さない（新しい split で包むだけ）。
 *
 * 未知の slug はスキップしてトーストで知らせる（無言の失敗はこのプロジェクトが繰り返し
 * 踏んできた地雷なので、押したのに何も起きないように見える状態を必ず可視化する）。
 * 1件も解決できなければレイアウトには触れず、トーストだけ出す。
 */
export async function runQuickLaunch(entry: QuickLaunch): Promise<void> {
  const projects = await listProjects();
  const { resolved, dropped } = resolveQuickLaunchSlugs(entry.slugs, projects);
  if (dropped.length > 0) {
    pushToast("warn", `クイック起動「${entry.name}」: 未登録の案件をスキップしました（${dropped.join(", ")}）`);
  }
  if (resolved.length === 0) return;

  const items = resolved.map((project) => ({ project }));
  // 外部ランチャー経路(#82)と同じ理由で "fresh" を使う: `claude --continue` は cwd に関わらず
  // 直近の会話を再開しうるため、ボタン1つで意図しない会話に接続する事故を避ける。
  const { tree: column, aiIds } = buildQuickLaunchColumn(items, "fresh");

  const current = get(layout);
  const newPaneFraction = widthPxToRatio(entry.width_px, get(workspaceWidthPx));
  const root: PaneNode = current
    ? { kind: "split", id: nextPaneId(), dir: "h", ratio: 1 - newPaneFraction, a: current, b: column }
    : column; // 既存レイアウトが無い（info タブ等）場合は素直に新ペイン列をそのまま使う
  layout.set(root);
  registerAiRowPanes(items, aiIds);
}
