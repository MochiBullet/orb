/**
 * #55: セッション要約（引き継ぎ MD）の生成。純関数＝Tauri/xterm 非依存で vitest 対象。
 *
 * データ源は #31/#49 の耐久ブロックログ（BlockEvent）。ここでは受け取った 1 日分の
 * イベント列を時系列に並べ直し、引き継ぎに使える Markdown を組み立てるだけ。
 * command が null のブロックは text の最初の非空行で代用する（#41「嘘をつかない」:
 * 確定マーカー由来ではない旨をでっち上げず、画面由来の行をそのまま見せる）。
 */

import type { BlockEvent } from "./blocks-log";

/** cwd の末尾ディレクトリ名（見出し用）。`\` `/` 両対応・末尾区切りは無視。 */
function baseName(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

/** epoch ms → ローカル HH:MM。 */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 所要秒（小数 1 桁・負値は 0 に丸め）。 */
function fmtSecs(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** 表示用コマンド。command 確定済みならそれ、null なら text の最初の非空行で代用。 */
export function displayCommand(e: BlockEvent): string {
  if (e.command) return e.command;
  const line = e.text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return line ?? "(コマンド不明)";
}

/** 末尾 n 行（空行は除く・右端の空白は落とす）。エラーの最終行付近だけ引き継ぐ用。 */
function lastLines(s: string, n: number): string[] {
  return s
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-n);
}

/**
 * 1 日分のブロックイベントから引き継ぎ用 Markdown を組む。
 *
 * - events の順序は問わない（内部で started_at 昇順に並べ直す。#49 検索は新しい順で返る）。
 * - 連続する同一コマンドは「×n」で 1 行に圧縮（exit は最後の実行、所要秒は合計）。
 * - 「失敗と解決」は exit≠0 のブロックごとに末尾 3 行を引用し、同一コマンドが
 *   その後成功していれば「→ その後成功 (HH:MM)」を付ける＝最終解決の推定。
 */
export function buildSessionSummary(
  events: BlockEvent[],
  opts: { day: string; cwd: string },
): string {
  if (events.length === 0) return "この日の記録はありません";
  const sorted = [...events].sort((a, b) => a.started_at - b.started_at);

  const abortedCount = sorted.filter((e) => e.aborted).length;
  const okCount = sorted.filter((e) => !e.aborted && e.exit_code === 0).length;
  const failCount = sorted.length - okCount - abortedCount;

  const lines: string[] = [];
  lines.push(`# 作業ログ ${opts.day} — ${baseName(opts.cwd)}`);
  lines.push("");
  lines.push(
    `コマンド ${sorted.length} 件（成功 ${okCount} / 失敗 ${failCount} / 中断 ${abortedCount}）・` +
      `作業時間帯 ${fmtTime(sorted[0].started_at)}–${fmtTime(sorted[sorted.length - 1].ended_at)}`,
  );
  lines.push("");
  lines.push("## 実行コマンド");
  lines.push("");

  // 連続する同一コマンドを run-length で圧縮。
  const runs: { cmd: string; events: BlockEvent[] }[] = [];
  for (const e of sorted) {
    const cmd = displayCommand(e);
    const last = runs[runs.length - 1];
    if (last && last.cmd === cmd) last.events.push(e);
    else runs.push({ cmd, events: [e] });
  }
  for (const r of runs) {
    const first = r.events[0];
    const lastEv = r.events[r.events.length - 1];
    const times = r.events.length > 1 ? ` ×${r.events.length}` : "";
    const totalMs = r.events.reduce((s, e) => s + Math.max(0, e.duration_ms), 0);
    lines.push(
      `- ${fmtTime(first.started_at)} \`${r.cmd}\`${times} (exit ${lastEv.exit_code}, ${fmtSecs(totalMs)})`,
    );
  }

  lines.push("");
  lines.push("## 失敗と解決");
  lines.push("");
  const failures = sorted.filter((e) => e.exit_code !== 0);
  if (failures.length === 0) {
    lines.push("なし");
  } else {
    for (const f of failures) {
      const cmd = displayCommand(f);
      lines.push(`### \`${cmd}\` (exit ${f.exit_code}${f.aborted ? "・中断" : ""})`);
      const tail = lastLines(f.output_body ?? f.text, 3);
      lines.push("```");
      lines.push(...(tail.length ? tail : ["(出力なし)"]));
      lines.push("```");
      // 最終解決の推定: 同一コマンドがこの失敗より後に成功していれば付記する。
      const fixed = sorted.find(
        (e) =>
          !e.aborted &&
          e.exit_code === 0 &&
          e.started_at >= f.ended_at &&
          displayCommand(e) === cmd,
      );
      if (fixed) lines.push(`→ その後成功 (${fmtTime(fixed.started_at)})`);
      lines.push("");
    }
  }
  return lines.join("\n").trimEnd() + "\n";
}
