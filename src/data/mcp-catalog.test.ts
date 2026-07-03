import { describe, it, expect } from "vitest";
import { MCP_CATALOG, isInstalled, shortMcpName } from "./mcp-catalog";

describe("shortMcpName (#46: status.rs short_mcp と同一の短縮規則)", () => {
  it("cloudflare-* は cf-*、context7 は ctx7、他はそのまま", () => {
    expect(shortMcpName("cloudflare-docs")).toBe("cf-docs");
    expect(shortMcpName("cloudflare-bindings")).toBe("cf-bindings");
    expect(shortMcpName("context7")).toBe("ctx7");
    expect(shortMcpName("playwright")).toBe("playwright");
    expect(shortMcpName("serena")).toBe("serena");
    expect(shortMcpName("github")).toBe("github");
  });
});

describe("isInstalled (#46: get_claude_status の短縮名配列との突き合わせ)", () => {
  it("context7 は短縮名 ctx7 で導入済み扱い", () => {
    expect(isInstalled("context7", ["ctx7"])).toBe(true);
    expect(isInstalled("context7", ["context7"])).toBe(false); // 生名は来ない前提（短縮名のみ）
  });

  it("cloudflare-docs は cf-docs で導入済み、cf-bindings では未導入", () => {
    expect(isInstalled("cloudflare-docs", ["cf-docs"])).toBe(true);
    expect(isInstalled("cloudflare-bindings", ["cf-docs"])).toBe(false);
  });

  it("短縮されない名前はそのまま照合、空配列は常に未導入", () => {
    expect(isInstalled("playwright", ["playwright", "ctx7"])).toBe(true);
    expect(isInstalled("serena", [])).toBe(false);
  });
});

describe("MCP_CATALOG データ形式 (#46 受け入れ条件)", () => {
  it("id は一意", () => {
    const ids = MCP_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("install は必ず 'claude mcp add' で始まる", () => {
    for (const e of MCP_CATALOG) {
      expect(e.install.startsWith("claude mcp add"), e.id).toBe(true);
    }
  });

  it("install は必ず user スコープ（-s user）。local スコープだと status.rs user_mcp() から見えず「済」判定・サイドバー表示が効かない", () => {
    for (const e of MCP_CATALOG) {
      expect(e.install.includes("-s user"), e.id).toBe(true);
    }
  });

  it("github は公式リモート HTTP（npm の server-github は非推奨）で要 OAuth", () => {
    const github = MCP_CATALOG.find((e) => e.id === "github")!;
    expect(github.install).toContain("--transport http");
    expect(github.install).toContain("https://api.githubcopilot.com/mcp/");
    expect(github.install).not.toContain("@modelcontextprotocol/server-github");
    expect(github.needsOauth).toBe(true);
  });

  it("stdio 系（--transport 無し）は Windows 運用知見どおり 'cmd /c' を含む", () => {
    for (const e of MCP_CATALOG) {
      if (!e.install.includes("--transport")) {
        expect(e.install.includes("cmd /c"), e.id).toBe(true);
      }
    }
  });

  it("install に改行・制御文字が無い（bracketed paste で1行挿入できる）", () => {
    for (const e of MCP_CATALOG) {
      // eslint-disable-next-line no-control-regex
      expect(/[\x00-\x1f\x7f]/.test(e.install), e.id).toBe(false);
    }
  });
});
