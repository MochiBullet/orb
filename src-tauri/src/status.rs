use std::os::windows::process::CommandExt;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Claude Code の設定由来ステータス（サイドバー表示用）。
/// ライブのセッション状態ではなく、settings.json / .mcp.json から導く
/// （statusline.ps1 と同じ「config-derived」方針）。
#[derive(Serialize, Deserialize, Clone)]
pub struct ClaudeStatus {
    pub model: String,
    pub effort: String,
    pub mcp: Vec<String>,
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
}

fn claude_dir() -> PathBuf {
    home_dir().join(".claude")
}

/// 表示用の短縮名（cloudflare-* -> cf-*, context7 -> ctx7）。
fn short_mcp(name: &str) -> String {
    if let Some(rest) = name.strip_prefix("cloudflare-") {
        return format!("cf-{rest}");
    }
    if name == "context7" {
        return "ctx7".to_string();
    }
    name.to_string()
}

/// user スコープの MCP サーバ名を ~/.claude.json の mcpServers から読む（実 config 由来）。
/// 44KB 程度のファイルだが 30s 間隔の取得なので毎回読んで問題ない。
fn user_mcp() -> Vec<String> {
    let path = home_dir().join(".claude.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(servers) = json["mcpServers"].as_object() {
                return servers.keys().cloned().collect();
            }
        }
    }
    Vec::new()
}

/// settings.json の model / effortLevel と、実 MCP 構成（user スコープ + cwd の .mcp.json）を集める。
/// 読めない項目は空で返す（端末は動き続ける＝サイドバーが欠けるだけ）。
pub fn fetch_status(cwd: Option<String>) -> ClaudeStatus {
    let mut model = String::new();
    let mut effort = String::new();

    if let Ok(text) = std::fs::read_to_string(claude_dir().join("settings.json")) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            model = json["model"].as_str().unwrap_or("").to_string();
            effort = json["effortLevel"].as_str().unwrap_or("").to_string();
        }
    }

    // MCP: 実 config 由来。user スコープ（~/.claude.json）+ プロジェクト .mcp.json を
    // 短縮名で重複排除しつつ列挙（ハードコードはしない＝実際に有効な構成を映す）。
    let mut seen = std::collections::HashSet::new();
    let mut mcp = Vec::new();
    for name in user_mcp() {
        let s = short_mcp(&name);
        if seen.insert(s.clone()) {
            mcp.push(s);
        }
    }
    if let Some(dir) = cwd {
        let proj = PathBuf::from(dir).join(".mcp.json");
        if let Ok(text) = std::fs::read_to_string(&proj) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(servers) = json["mcpServers"].as_object() {
                    for name in servers.keys() {
                        let s = short_mcp(name);
                        if seen.insert(s.clone()) {
                            mcp.push(s);
                        }
                    }
                }
            }
        }
    }

    ClaudeStatus { model, effort, mcp }
}

/// `claude mcp list` の実測による各 MCP サーバの接続状態（サイドバーのチップ色用）。
/// config 由来の一覧（fetch_status）と違い、実際に接続を試みた「生死」を映す。
#[derive(Serialize, Deserialize, Clone)]
pub struct McpHealth {
    /// 短縮名。fetch_status のチップ（short_mcp 済み）と突き合わせるため同じ関数を通す。
    pub name: String,
    /// "connected" | "needs_auth" | "failed" | "unknown"。
    pub status: String,
}

/// `claude mcp list` を実行し、各行末尾の状態文字列から生死を判定して返す。
/// claude は Windows では PATH 上 `claude.cmd` シムのため `cmd /c` 経由で起動する
/// （`claude.exe` 実体は PATH に出ない — memory reference-claude-exe-path-windows）。
/// npx stdio 系サーバを毎回起動して接続試行するので数秒〜十数秒かかる重い呼び出し。
/// サイドバーからは長間隔（5分）＋手動リロード時のみ叩く。
pub fn fetch_mcp_health() -> Vec<McpHealth> {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let Ok(out) = std::process::Command::new("cmd")
        .args(["/C", "claude", "mcp", "list"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
    else {
        return Vec::new();
    };

    // 出力先が stdout / stderr どちらでも拾えるよう両方を連結してパースする。
    let mut raw = String::from_utf8_lossy(&out.stdout).into_owned();
    raw.push('\n');
    raw.push_str(&String::from_utf8_lossy(&out.stderr));
    parse_mcp_health(&raw)
}

/// ANSI エスケープ（CSI: `ESC [ … 最終バイト(0x40-0x7e)`）を除去して平文化する。
/// `claude mcp list` が色付きで出力する環境でも名前抽出・状態判定が壊れないよう、
/// パース前に一度剥がす（監査 wf_aabcbab7 の PLAUSIBLE 指摘への堅牢化）。
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // ESC の次が '[' なら CSI。最終バイト(0x40..=0x7e)まで読み飛ばす。
            if chars.peek() == Some(&'[') {
                chars.next();
                while let Some(nc) = chars.next() {
                    if ('\u{40}'..='\u{7e}').contains(&nc) {
                        break;
                    }
                }
            }
            // ESC 単体・非 CSI は ESC を落とすだけ
        } else {
            out.push(c);
        }
    }
    out
}

/// `claude mcp list` 出力テキストから各サーバの生死を判定する
/// （プロセス起動と分離＝単体テスト可能）。
fn parse_mcp_health(raw: &str) -> Vec<McpHealth> {
    let text = strip_ansi(raw);
    let mut result = Vec::new();
    for line in text.lines() {
        // 期待形式: "<name>: <url/cmd> - <marker> <status text>"
        // ヘッダ行 "Checking MCP server health…"（`:` 無し）や空行はここで弾かれる。
        // URL 内の ':' は split_once(':') が最初の ':' で切るので名前抽出に影響しない。
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || !rest.contains(" - ") {
            continue;
        }
        // 状態は最後の " - " 以降だけ見る（コマンド内のハイフンに引っ掛からない）。
        let tail = rest.rsplit(" - ").next().unwrap_or("").to_lowercase();
        let status = if tail.contains("connected") {
            "connected"
        } else if tail.contains("auth") {
            "needs_auth"
        } else if tail.contains("failed") || tail.contains("error") {
            "failed"
        } else {
            "unknown"
        };
        result.push(McpHealth {
            name: short_mcp(name),
            status: status.to_string(),
        });
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_plain_url_and_ansi_lines() {
        let sample = "Checking MCP server health…\n\
            playwright: cmd /c npx -y @playwright/mcp@latest - ✔ Connected\n\
            cloudflare-docs: https://docs.mcp.cloudflare.com/mcp (HTTP) - ✔ Connected\n\
            claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ! Needs authentication\n\
            \u{1b}[1mcontext7\u{1b}[0m: cmd /c npx -y @upstash/context7-mcp - \u{1b}[32m✔ Connected\u{1b}[0m\n\
            broken: some cmd - ✗ Failed to connect\n";
        let r = parse_mcp_health(sample);
        let find = |n: &str| r.iter().find(|h| h.name == n).map(|h| h.status.as_str());
        assert_eq!(find("playwright"), Some("connected"));
        // URL 内の ':' に惑わされず first-colon で名前を取り、短縮名になる
        assert_eq!(find("cf-docs"), Some("connected"));
        assert_eq!(find("claude.ai Gmail"), Some("needs_auth"));
        // ANSI 装飾を剥がして context7 -> ctx7 / connected
        assert_eq!(find("ctx7"), Some("connected"));
        assert_eq!(find("broken"), Some("failed"));
        // ヘッダ行（": " を含まない）は拾われない
        assert!(!r.iter().any(|h| h.name.contains("Checking")));
    }
}
