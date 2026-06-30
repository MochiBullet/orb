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

/// 1回分の usage リクエスト。非 2xx は Err((status, msg)) を返す
/// （エラー応答を 0% として描画しない＝ゲージが一瞬空になるのを防ぐ）。
fn try_fetch(client: &reqwest::blocking::Client, token: &str) -> std::result::Result<Usage, (u16, String)> {
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", "claude-cli/2.1.181")
        .timeout(Duration::from_secs(10))
        .send()
        .map_err(|e| (0u16, e.to_string()))?;

    let status = resp.status();
    if !status.is_success() {
        return Err((status.as_u16(), format!("usage api returned {status}")));
    }

    let json: serde_json::Value = resp.json().map_err(|e| (status.as_u16(), e.to_string()))?;
    Ok(Usage {
        five_hour: json["five_hour"]["utilization"].as_f64().unwrap_or(0.0),
        seven_day: json["seven_day"]["utilization"].as_f64().unwrap_or(0.0),
        five_reset: json["five_hour"]["resets_at"].as_str().unwrap_or("").to_string(),
        seven_reset: json["seven_day"]["resets_at"].as_str().unwrap_or("").to_string(),
    })
}

/// usage エンドポイントを叩いて 5h / 7d の使用率とリセット時刻を返す。
///
/// 401/403 は `claude --continue` 等で OAuth トークンが更新された直後の
/// レース（古いトークンを読んだ）であることが多い。少し待ってトークンを
/// 読み直し、1回だけ再試行する。それ以外の失敗は Err を返し、サイドバーは
/// 直前の値を保持する（取得失敗で 0% に落とさない＝ちらつき防止）。
pub fn fetch_usage() -> Result<Usage> {
    let client = reqwest::blocking::Client::new();
    let token = access_token()?;
    match try_fetch(&client, &token) {
        Ok(u) => Ok(u),
        Err((401, _)) | Err((403, _)) => {
            std::thread::sleep(Duration::from_millis(400));
            let token = access_token()?;
            try_fetch(&client, &token).map_err(|(_, m)| AppError::Usage(m))
        }
        Err((_, m)) => Err(AppError::Usage(m)),
    }
}
