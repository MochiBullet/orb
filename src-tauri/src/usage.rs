use std::path::PathBuf;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// Claude のトークン使用率（非公式 usage API のサブセット）。サイドバー表示用。
#[derive(Serialize, Deserialize, Clone)]
pub struct Usage {
    pub five_hour: f64,
    pub seven_day: f64,
    pub five_reset: String,
    pub seven_reset: String,
}

/// ~/.claude/.credentials.json から OAuth アクセストークンを読む。
fn access_token() -> Result<String> {
    let path = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".claude")
        .join(".credentials.json");
    let text = std::fs::read_to_string(path)?;
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| AppError::Usage(e.to_string()))?;
    json["claudeAiOauth"]["accessToken"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Usage("accessToken not found in .credentials.json".into()))
}

/// usage エンドポイントを叩いて 5h / 7d の使用率とリセット時刻を返す。
pub fn fetch_usage() -> Result<Usage> {
    let token = access_token()?;
    let client = reqwest::blocking::Client::new();
    let resp: serde_json::Value = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-cli/2.1.181")
        .timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| AppError::Usage(e.to_string()))?
        .json()
        .map_err(|e| AppError::Usage(e.to_string()))?;

    Ok(Usage {
        five_hour: resp["five_hour"]["utilization"].as_f64().unwrap_or(0.0),
        seven_day: resp["seven_day"]["utilization"].as_f64().unwrap_or(0.0),
        five_reset: resp["five_hour"]["resets_at"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        seven_reset: resp["seven_day"]["resets_at"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    })
}
