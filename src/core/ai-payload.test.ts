import { describe, it, expect } from "vitest";
import {
  formatBlockForAi,
  formatFixRequest,
  formatFailureDigest,
  frameBracketedPaste,
  type BlockAiContext,
} from "./ai-payload";

const structured: BlockAiContext = {
  cwd: "C:\\proj",
  exitCode: 101,
  command: "cargo test",
  outputBody: "error[E0308]: mismatched types",
  text: "❯ cargo test\nerror[E0308]: mismatched types",
};

describe("formatBlockForAi (#34)", () => {
  it("E/C 確定ブロックは構造化（cwd/exit/$command/output）", () => {
    const s = formatBlockForAi(structured);
    expect(s).toContain("cwd=C:\\proj");
    expect(s).toContain("exit=101");
    expect(s).toContain("$ cargo test");
    expect(s).toContain("--- output ---\nerror[E0308]");
    // 生テキストへはフォールバックしない（構造化が優先）
    expect(s).not.toContain("❯");
  });

  it("マーカー不在は生テキストへフォールバック（嘘の分割を作らない）", () => {
    const s = formatBlockForAi({ ...structured, command: null, outputBody: null });
    expect(s).toContain("❯ cargo test");
    expect(s).not.toContain("$ ");
  });

  it("出力なしのコマンドは (出力なし) を明示", () => {
    const s = formatBlockForAi({ ...structured, outputBody: "" });
    expect(s).toContain("(出力なし)");
  });

  it("exitCode null は exit= を出さない（選択テキスト等の非ブロック文脈）", () => {
    const s = formatBlockForAi({ ...structured, exitCode: null });
    expect(s).not.toContain("exit=");
  });
});

describe("formatFixRequest / formatFailureDigest (#34)", () => {
  it("fix 依頼は exit と依頼文を含む", () => {
    const s = formatFixRequest(structured);
    expect(s).toContain("exit 101 で失敗");
    expect(s).toContain("$ cargo test");
  });

  it("一括ダイジェストは件数と各ブロックを含む", () => {
    const s = formatFailureDigest([structured, { ...structured, command: "pnpm build", exitCode: 1 }]);
    expect(s).toContain("2 件");
    expect(s).toContain("失敗 1/2");
    expect(s).toContain("失敗 2/2");
    expect(s).toContain("$ pnpm build");
  });
});

describe("frameBracketedPaste (#34)", () => {
  it("bracketed paste で包む（\\n は保持＝1回の貼り付けとして届く）", () => {
    expect(frameBracketedPaste("a\nb")).toBe("\x1b[200~a\nb\x1b[201~");
  });

  it("ESC 等の制御文字を除去＝枠の早期終了（ESC[201~ 注入）を不能にする", () => {
    const evil = "safe\x1b[201~\rrm -rf /\x1b[200~";
    const framed = frameBracketedPaste(evil);
    // 枠は先頭と末尾の1組だけ・中身に ESC も CR も残らない
    expect(framed.startsWith("\x1b[200~")).toBe(true);
    expect(framed.endsWith("\x1b[201~")).toBe(true);
    expect(framed.slice(6, -6)).toBe("safe[201~rm -rf /[200~");
  });

  it("タブは保持する（コード貼り付けを壊さない）", () => {
    expect(frameBracketedPaste("a\tb")).toContain("a\tb");
  });

  it("C1 制御（U+009B 1文字CSI 等）も落とす", () => {
    expect(frameBracketedPaste("a201~bc")).toBe("\x1b[200~a201~bc\x1b[201~");
  });
});
