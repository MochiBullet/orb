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

fn claude_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude")
}

/// settings.json の model / effortLevel と、MCP（core 固定 + cwd の .mcp.json）を集める。
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

    // MCP: 常時 on の core（context7 + cloudflare）+ プロジェクト .mcp.json。
    let mut mcp = vec!["ctx7".to_string(), "cf".to_string()];
    if let Some(dir) = cwd {
        let proj = PathBuf::from(dir).join(".mcp.json");
        if let Ok(text) = std::fs::read_to_string(&proj) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(servers) = json["mcpServers"].as_object() {
                    for name in servers.keys() {
                        mcp.push(name.replace("cloudflare-", "cf-"));
                    }
                }
            }
        }
    }

    ClaudeStatus { model, effort, mcp }
}
