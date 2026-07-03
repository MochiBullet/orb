/**
 * #46: おすすめ MCP コレクションの静的カタログ。
 *
 * install コマンドは運用知見の焼き込み（勝手に変えない）:
 * - 全エントリ `-s user`（user スコープ＝~/.claude.json トップレベル mcpServers）。
 *   既定の local スコープだと status.rs user_mcp() から見えず「済」判定・サイドバー
 *   表示が効かない上、他ディレクトリで無効になる（運用モデルも core=user スコープ）。
 * - Windows の stdio npx/uvx サーバは `cmd /c` 経由が必須
 *   （PS は `--` を食う・git-bash は `/c` をパス化ける — memory feedback-windows-mcp-install）。
 * - リモート（Cloudflare 系）は `--transport sse` + URL。github は公式リモート HTTP
 *   （npm の @modelcontextprotocol/server-github は非推奨）で要 OAuth。
 * MCP はプロセス起動時に解決されるため、追加後は orb（の中の claude）再起動で有効化。
 */

export interface McpCatalogEntry {
  /** カタログ内 ID（= `claude mcp add` に渡すサーバ名）。 */
  id: string;
  name: string;
  desc: string;
  /** そのまま端末に挿入するインストールコマンド（実行は人が Enter で）。 */
  install: string;
  /** 追加後に /mcp での OAuth が要るか。 */
  needsOauth: boolean;
  /** 前提条件などの補足。 */
  note?: string;
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    id: "context7",
    name: "context7",
    desc: "ライブラリ公式ドキュメント検索",
    install: "claude mcp add -s user context7 -- cmd /c npx -y @upstash/context7-mcp",
    needsOauth: false,
  },
  {
    id: "playwright",
    name: "playwright",
    desc: "ブラウザ自動操作/E2E/スクショ",
    install: "claude mcp add -s user playwright -- cmd /c npx -y @playwright/mcp@latest",
    needsOauth: false,
  },
  {
    id: "serena",
    name: "serena",
    desc: "LSPベースのセマンティックコード検索/編集・要 uv",
    install:
      "claude mcp add -s user serena -- cmd /c uvx --from git+https://github.com/oraios/serena serena start-mcp-server --context ide-assistant",
    needsOauth: false,
    note: "要 winget install astral-sh.uv",
  },
  {
    id: "cloudflare-docs",
    name: "cloudflare-docs",
    desc: "Cloudflare 公式ドキュメント",
    install:
      "claude mcp add -s user --transport sse cloudflare-docs https://docs.mcp.cloudflare.com/sse",
    needsOauth: false,
  },
  {
    id: "cloudflare-bindings",
    name: "cloudflare-bindings",
    desc: "Workers/D1/KV/R2 操作",
    install:
      "claude mcp add -s user --transport sse cloudflare-bindings https://bindings.mcp.cloudflare.com/sse",
    needsOauth: true,
    note: "初回 /mcp で OAuth",
  },
  {
    id: "github",
    name: "github",
    desc: "リポ/イシュー/PR 操作",
    install: "claude mcp add -s user --transport http github https://api.githubcopilot.com/mcp/",
    needsOauth: true,
    note: "初回 /mcp で OAuth。gh CLI で足りる場面も多い",
  },
];

/**
 * サイドバー表示用の短縮名。src-tauri/src/status.rs の short_mcp と同一ロジック
 * （cloudflare-* → cf-*, context7 → ctx7）。get_claude_status の .mcp は
 * この短縮名で返るため、カタログ ID との突き合わせに使う。
 */
export function shortMcpName(name: string): string {
  if (name.startsWith("cloudflare-")) return `cf-${name.slice("cloudflare-".length)}`;
  if (name === "context7") return "ctx7";
  return name;
}

/** カタログ項目が導入済みか（configuredShortNames = get_claude_status の .mcp）。 */
export function isInstalled(catalogId: string, configuredShortNames: string[]): boolean {
  return configuredShortNames.includes(shortMcpName(catalogId));
}
