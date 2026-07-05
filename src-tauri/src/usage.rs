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
    // home 未解決（USERPROFILE/HOME 未設定）ならプロセス cwd 起点の意図しない相対パスを
    // 読みに行かず、素直に読めない扱いにする（status.rs の home_dir_checked と同じ方針）。
    let home = crate::status::home_dir_checked()
        .ok_or_else(|| AppError::Usage("home directory not resolved (USERPROFILE/HOME unset)".into()))?;
    let path = home.join(".claude").join(".credentials.json");
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
    parse_usage_json(&json).ok_or((
        status.as_u16(),
        "usage api returned 200 but utilization fields are missing/malformed".to_string(),
    ))
}

/// 200 応答の JSON ボディから `Usage` を組み立てる（純粋・単体テスト可能）。
/// five_hour/seven_day の utilization が**両方**欠落/型不一致なら None を返す＝呼び元はこれを
/// Err 化する。0.0 埋めのまま Ok にしてしまうと、スキーマ変更や障害時の空/想定外ボディの
/// 200 がゲージを 0% に落としてしまい、非2xx を Err にしている意図（直前値を保持しちらつき
/// を防ぐ）と矛盾する。片方だけ欠落は（実運用でまず起きない上位互換の緩い解釈として）
/// 従来通り 0.0 埋めで通す。
fn parse_usage_json(json: &serde_json::Value) -> Option<Usage> {
    let five_hour = json["five_hour"]["utilization"].as_f64();
    let seven_day = json["seven_day"]["utilization"].as_f64();
    if five_hour.is_none() && seven_day.is_none() {
        return None;
    }
    Some(Usage {
        five_hour: five_hour.unwrap_or(0.0),
        seven_day: seven_day.unwrap_or(0.0),
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
            // エラーは "status: msg" 形式で返す＝フロントが 401（レース）と 429（レート制限）を
            // 区別してリトライ戦略を変えられるようにする。
            try_fetch(&client, &token).map_err(|(s, m)| AppError::Usage(format!("{s}: {m}")))
        }
        Err((s, m)) => Err(AppError::Usage(format!("{s}: {m}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_usage_json_normal_body() {
        let j: serde_json::Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":12.5,"resets_at":"2026-07-06T10:00:00Z"},
                "seven_day":{"utilization":40.0,"resets_at":"2026-07-10T00:00:00Z"}}"#,
        )
        .unwrap();
        let u = parse_usage_json(&j).expect("normal body must parse");
        assert_eq!(u.five_hour, 12.5);
        assert_eq!(u.seven_day, 40.0);
        assert_eq!(u.five_reset, "2026-07-06T10:00:00Z");
        assert_eq!(u.seven_reset, "2026-07-10T00:00:00Z");
    }

    /// Bug: 空/想定外ボディの 200 が 0.0 埋めで Ok になり、ゲージが 0% に落ちていた。
    /// 両方の utilization が欠落しているボディは None（呼び元で Err 化）になること。
    #[test]
    fn parse_usage_json_rejects_body_missing_both_utilizations() {
        assert!(parse_usage_json(&serde_json::json!({})).is_none());
        assert!(parse_usage_json(&serde_json::json!({"unexpected": "shape"})).is_none());
    }

    #[test]
    fn parse_usage_json_tolerates_one_missing_field() {
        // 片方だけ欠けているケースは（実運用でまず起きないが）従来通り 0.0 埋めで通す。
        let j = serde_json::json!({ "seven_day": { "utilization": 5.0 } });
        let u = parse_usage_json(&j).expect("one present field must still parse");
        assert_eq!(u.five_hour, 0.0);
        assert_eq!(u.seven_day, 5.0);
    }
}
