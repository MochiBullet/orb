import { listen } from "@tauri-apps/api/event";
import { listProjects, launchAiRow, type Project } from "./launch";
import { logWarn } from "../core/log";

/** Rust 側 queue watcher（#82 外部インボックス）が `{"launch": [...]}` 形式のメッセージを
 *  受け取った時に emit するイベント名。lib.rs/queue.rs と一致させること。 */
const LAUNCH_EVENT = "orb://launch-request";

interface LaunchRequestPayload {
  /** 起動したい案件の slug 一覧（projects.toml の slug）。 */
  slugs: string[];
}

/**
 * 外部プロセスが「このslug群を1画面(AIペインのみ・司令塔+横並び)で起動して」と要求できる
 * 経路（#82 外部インボックスの `{"launch": [...]}` メッセージ）をフロントで受ける。
 * 未知の slug は黙って無視（該当案件だけ欠けて起動、0件なら何もしない）。
 */
export async function initExternalLaunchListener(): Promise<() => void> {
  const unlisten = await listen<LaunchRequestPayload>(LAUNCH_EVENT, (event) => {
    void handleLaunchRequest(event.payload);
  });
  return unlisten;
}

async function handleLaunchRequest(payload: LaunchRequestPayload): Promise<void> {
  const slugs = payload?.slugs ?? [];
  if (slugs.length === 0) return;
  const projects = await listProjects();
  const bySlug = new Map(projects.map((p) => [p.slug, p]));
  const items: { project: Project }[] = [];
  for (const slug of slugs) {
    const p = bySlug.get(slug);
    if (p) {
      items.push({ project: p });
    } else {
      logWarn(`external-launch: unknown project slug "${slug}" (projects.toml に無い、スキップ)`);
    }
  }
  // "continue" ではなく明示的に "fresh"（`claude` 単体、`--continue` 無し）を使う。
  // `claude --continue` は cwd に関わらず直近の会話を再開しうるため（実機検証で確認: 新規
  // ペインのはずが、たまたま直近アクティブだった全く無関係な別セッションを継続してしまった）、
  // 外部トリガーの新規起動でこれを踏むと意図しない会話に接続する事故になる。
  if (items.length > 0) launchAiRow(items, "fresh");
}
