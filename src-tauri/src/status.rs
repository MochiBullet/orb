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

    // 出力先が stdout / stderr どちらでも拾えるよう両方を連結してパースする
    // （有効行＝`<name>: … - <status>` だけ拾うのでヘッダ行が混じっても無害）。
    let mut text = String::from_utf8_lossy(&out.stdout).into_owned();
    text.push('\n');
    text.push_str(&String::from_utf8_lossy(&out.stderr));

    let mut result = Vec::new();
    for line in text.lines() {
        // 期待形式: "<name>: <url/cmd> - <marker> <status text>"
        // ヘッダ行 "Checking MCP server health…"（`:` 無し）や空行はここで弾かれる。
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
