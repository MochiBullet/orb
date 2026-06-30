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
