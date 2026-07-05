import { describe, expect, it } from "vitest";
import type { BlockEvent } from "./blocks-log";
import { buildSessionSummary, displayCommand } from "./session-summary";

/** ローカル時刻から epoch ms を作る（fmtTime がローカル HH:MM なのでテストもローカル基準）。 */
function at(h: number, m: number): number {
  return new Date(2026, 6, 3, h, m).getTime();
}

/** フィクスチャ生成。started/ended はローカル [時, 分]。 */
function ev(
  over: Partial<BlockEvent> & { started: [number, number]; ended?: [number, number] },
): BlockEvent {
  const started_at = at(...over.started);
  const ended_at = over.ended ? at(...over.ended) : started_at + 1500;
  return {
    v: 1,
    session_id: "s",
    pane_id: 1,
    block_id: Math.random().toString(36).slice(2),
    cwd: "C:\\Users\\hiyok\\orb",
    shell: "pwsh",
    prompt_type: "starship",
    exit_code: 0,
    aborted: false,
    text: "",
    truncated: false,
    command: null,
    output_body: null,
    duration_ms: ended_at - started_at,
    ...over,
    started_at,
    ended_at,
  };
}

const OPTS = { day: "2026-07-03", cwd: "C:\\Users\\hiyok\\orb" };

describe("buildSessionSummary", () => {
  it("空データなら固定メッセージを返す", () => {
    expect(buildSessionSummary([], OPTS)).toBe("この日の記録はありません");
  });

  it("見出し・サマリ行（件数内訳と時間帯）を組む。失敗件数は「失敗と解決」に列挙される件数と一致する", () => {
    const events = [
      ev({ command: "pnpm vitest run", started: [9, 5] }),
      ev({ command: "cargo build", exit_code: 101, started: [10, 0] }),
      ev({ command: "cargo test", exit_code: -1, aborted: true, started: [11, 30], ended: [11, 42] }),
    ];
    const md = buildSessionSummary(events, OPTS);
    expect(md).toContain("# 作業ログ 2026-07-03 — orb");
    // 失敗 2 = cargo build(101) + cargo test(中断,-1)。「失敗と解決」に並ぶ ### 見出しも2個で一致する
    // （旧: 中断を除いた 1 のみを表示し、実際に列挙される件数(2件)とズレていた）。
    expect(md).toContain("コマンド 3 件（成功 1 / 失敗 2 (うち中断 1)）");
    expect(md).toContain("作業時間帯 09:05–11:42");
    const failureHeadings = md.split("\n").filter((l) => l.startsWith("### `"));
    expect(failureHeadings).toHaveLength(2);
  });

  it("新しい順で渡しても時系列（古い順）に並べ直す", () => {
    const events = [
      ev({ command: "second", started: [10, 0] }),
      ev({ command: "first", started: [9, 0] }),
    ];
    const md = buildSessionSummary(events, OPTS);
    expect(md.indexOf("`first`")).toBeLessThan(md.indexOf("`second`"));
    expect(md).toContain("作業時間帯 09:00–");
  });

  it("command が null なら text の最初の非空行で代用する", () => {
    const e = ev({ command: null, text: "\n  \n> git status\nnothing to commit", started: [9, 0] });
    expect(displayCommand(e)).toBe("> git status");
    const md = buildSessionSummary([e], OPTS);
    expect(md).toContain("- 09:00 `> git status` (exit 0, 1.5s)");
  });

  it("連続する同一コマンドは ×n に圧縮（exit は最後・秒は合計）", () => {
    const events = [
      ev({ command: "pnpm vitest run", exit_code: 1, started: [9, 0], ended: [9, 1] }),
      ev({ command: "pnpm vitest run", exit_code: 0, started: [9, 5], ended: [9, 6] }),
      ev({ command: "git status", started: [9, 10] }),
    ];
    const md = buildSessionSummary(events, OPTS);
    expect(md).toContain("- 09:00 `pnpm vitest run` ×2 (exit 0, 120.0s)");
    expect(md).toContain("- 09:10 `git status`");
    // 実行コマンド一覧では 1 行に圧縮（個別 2 行に展開されていない）。
    const cmdLines = md.split("\n").filter((l) => l.startsWith("- ") && l.includes("`pnpm vitest run`"));
    expect(cmdLines).toHaveLength(1);
    // 9:00 の失敗はその後 9:05 に成功している＝解決済みとして推定される。
    expect(md).toContain("→ その後成功 (09:05)");
  });

  it("失敗は末尾3行を引用し、後で同一コマンドが成功していれば「→ その後成功」", () => {
    const events = [
      ev({
        command: "cargo build",
        exit_code: 101,
        output_body: "line1\nline2\nline3\nerror[E0308]: mismatched types\nerror: could not compile",
        started: [10, 0],
        ended: [10, 1],
      }),
      ev({ command: "cargo build", exit_code: 0, started: [10, 20] }),
    ];
    const md = buildSessionSummary(events, OPTS);
    expect(md).toContain("### `cargo build` (exit 101)");
    // 末尾 3 行のみ（line1/line2 は落ちる）。
    expect(md).toContain("line3\nerror[E0308]: mismatched types\nerror: could not compile");
    expect(md).not.toContain("line1");
    expect(md).toContain("→ その後成功 (10:20)");
  });

  it("後続成功が無い失敗・output_body 無しの text フォールバック・中断表記", () => {
    const events = [
      ev({
        command: "npm run build",
        exit_code: -1,
        aborted: true,
        output_body: null,
        text: "npm run build\nビルド中…\n^C",
        started: [12, 0],
      }),
      // 別コマンドの成功では「その後成功」は付かない。
      ev({ command: "git status", started: [12, 5] }),
    ];
    const md = buildSessionSummary(events, OPTS);
    expect(md).toContain("### `npm run build` (exit -1・中断)");
    expect(md).toContain("^C");
    expect(md).not.toContain("→ その後成功");
  });

  it("マーカー無し(command:null)の別ブロックは先頭行が同じでも同一コマンド扱いしない（誤merge/誤『その後成功』を防ぐ）", () => {
    const events = [
      ev({ command: null, exit_code: 1, text: "$ some-tool\nfailed: xyz", started: [9, 0] }),
      ev({
        command: null,
        exit_code: 0,
        text: "$ some-tool\nunrelated success, just shares the leading line",
        started: [9, 10],
      }),
    ];
    const md = buildSessionSummary(events, OPTS);
    // 実行コマンド一覧: 先頭行が同じでも別ブロックとして2行のまま（×2 に圧縮されない）。
    const cmdLines = md.split("\n").filter((l) => l.startsWith("- ") && l.includes("`$ some-tool`"));
    expect(cmdLines).toHaveLength(2);
    // 失敗と解決: 先頭行が同じだけの無関係な後続ブロックを「解決した」と嘘をつかない。
    expect(md).not.toContain("→ その後成功");
  });

  it("失敗が無ければ「なし」", () => {
    const md = buildSessionSummary([ev({ command: "ls", started: [9, 0] })], OPTS);
    expect(md).toContain("## 失敗と解決\n\nなし");
  });
});
