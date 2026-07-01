//! #31 ブロックイベントの耐久ログ（append-only JSONL）。
//!
//! ログを source of truth に据える設計（EPIC #29）の基盤。フロント（osc.ts）が
//! ブロック境界（OSC 133/633 の A / D）を解釈して「1 ブロック 1 レコード」を送り、
//! ここでは `~/.config/orb/blocks/YYYY-MM-DD.jsonl` へ 1 行ずつ追記するだけの激薄層。
//!
//! - 書き込みは spawn_blocking（専用スレッド）へ逃がし、UI スレッドを固めない。
//! - 複数ペインからの同時追記は WRITE_LOCK で直列化（行の混線を防ぐ）。
//! - スキーマは v1 で freeze。フィールド追加は serde default で後方互換、破壊的変更は `v` を上げる。
//! - `command` / `output_body` は #33（OSC 133 B/C マーカー）で埋める予約フィールド。
//!   マーカーが無い現状で「嘘の分割」を書かないため null のまま置く（#41 の「嘘をつかない」精神）。

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 1 ブロック分の確定レコード（v1・freeze）。フロントの BlockEvent(TS) と 1:1。
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct BlockEvent {
    /// スキーマ版。破壊的変更で上げる。
    pub v: u32,
    /// orb 起動ごとの一意 ID（同一起動のブロックを束ねる）。
    pub session_id: String,
    /// ペイン ID（フロント採番）。
    pub pane_id: u64,
    /// ブロック ID（プロンプト開始時に採番）。
    pub block_id: String,
    /// 実行時の作業ディレクトリ（OSC P;Cwd）。
    #[serde(default)]
    pub cwd: String,
    /// 起動シェル（現状 "pwsh" 固定）。
    #[serde(default)]
    pub shell: String,
    /// プロンプト種別（OSC P;PromptType、例 "starship"）。
    #[serde(default)]
    pub prompt_type: String,
    /// 終了コード。-1 = 不明/中断（D 欠落・Ctrl-C・破損 D）。内訳は aborted で判別する。
    pub exit_code: i64,
    /// true = D を受け取らず次プロンプト/破棄で閉じた（中断/クラッシュ）。false = D で正常終了。
    #[serde(default)]
    pub aborted: bool,
    /// プロンプト開始時刻（epoch ms）。
    pub started_at: i64,
    /// 終了時刻（epoch ms）。
    pub ended_at: i64,
    /// 実行時間（ms）。
    pub duration_ms: i64,
    /// ブロック全文（プロンプト＋コマンド＋出力、フロントで上限 cap 済み）。
    #[serde(default)]
    pub text: String,
    /// text が上限で切り詰められたか。
    #[serde(default)]
    pub truncated: bool,
    /// 予約: コマンド行のみ（#33 の B/C マーカーで確定）。現状 null。
    #[serde(default)]
    pub command: Option<String>,
    /// 予約: 出力本文のみ（#33 の B/C マーカーで確定）。現状 null。
    #[serde(default)]
    pub output_body: Option<String>,
}

/// ブロックログのディレクトリ（`~/.config/orb/blocks/`）。config.toml と同じ基準の下。
fn blocks_dir() -> PathBuf {
    crate::config::config_dir().join("blocks")
}

/// day が `YYYY-MM-DD` 形式か。ファイル名に使う前の検証（パストラバーサル防止）。
fn is_valid_day(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10
        && b.iter().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                *c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
}

/// `<dir>/<day>.jsonl`。不正な day は "unknown" に落とす（ファイル名を必ず安全に保つ）。
fn day_file(dir: &Path, day: &str) -> PathBuf {
    let safe = if is_valid_day(day) { day } else { "unknown" };
    dir.join(format!("{safe}.jsonl"))
}

/// 同時追記を直列化して行の混線を防ぐ。Mutex::new は const なので static で持てる。
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// 1 レコードを JSONL へ追記する（dir を引数に取り、テストが temp を差し込めるようにする）。
fn write_event_to(dir: &Path, day: &str, event: &BlockEvent) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    // serde_json::to_string は 1 行 JSON（内部の改行は \n へエスケープ）＝JSONL 不変条件を保つ。
    let mut line = serde_json::to_string(event).map_err(|e| AppError::Config(e.to_string()))?;
    line.push('\n');
    // ロック中毒（他スレッドの panic）でも追記は続けたいので into_inner で回収する。
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(day_file(dir, day))?;
    f.write_all(line.as_bytes())?;
    Ok(())
}

/// 指定日の JSONL を読み戻す。壊れた行・将来スキーマの行は黙ってスキップ（前方互換・耐障害）。
fn read_events_from(dir: &Path, day: &str) -> Vec<BlockEvent> {
    let text = match std::fs::read_to_string(day_file(dir, day)) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<BlockEvent>(l).ok())
        .collect()
}

/// フロントから 1 ブロック分を追記する（#31）。書き込みは専用スレッドへ逃がす。
#[tauri::command]
pub async fn append_block_event(day: String, event: BlockEvent) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || write_event_to(&blocks_dir(), &day, &event))
        .await
        .map_err(|e| AppError::Config(format!("block log task: {e}")))?
}

/// 指定日のブロックログを読み戻す（履歴オーバーレイの再描画＝#31 の受け入れ条件）。
#[tauri::command]
pub async fn read_block_events(day: String) -> Vec<BlockEvent> {
    tauri::async_runtime::spawn_blocking(move || read_events_from(&blocks_dir(), &day))
        .await
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(block_id: &str, code: i64) -> BlockEvent {
        BlockEvent {
            v: 1,
            session_id: "sess".into(),
            pane_id: 1,
            block_id: block_id.into(),
            cwd: r"C:\proj".into(),
            shell: "pwsh".into(),
            prompt_type: "starship".into(),
            exit_code: code,
            aborted: code < 0,
            started_at: 1000,
            ended_at: 2000,
            duration_ms: 1000,
            text: "echo hi\nhi".into(),
            truncated: false,
            command: None,
            output_body: None,
        }
    }

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("orb-blocktest-{name}"))
    }

    #[test]
    fn append_then_read_roundtrip() {
        let dir = temp("roundtrip");
        let _ = std::fs::remove_dir_all(&dir);
        write_event_to(&dir, "2026-07-01", &ev("b1", 0)).unwrap();
        write_event_to(&dir, "2026-07-01", &ev("b2", 137)).unwrap();
        let got = read_events_from(&dir, "2026-07-01");
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].block_id, "b1");
        assert_eq!(got[0].exit_code, 0);
        assert_eq!(got[1].exit_code, 137);
        // 予約フィールドは往復しても null のまま。
        assert_eq!(got[1].command, None);
        assert_eq!(got[1].output_body, None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_missing_day_is_empty() {
        let dir = temp("missing");
        let _ = std::fs::remove_dir_all(&dir);
        assert!(read_events_from(&dir, "2026-01-01").is_empty());
    }

    #[test]
    fn malformed_and_future_lines_are_skipped_not_fatal() {
        let dir = temp("malformed");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let good = serde_json::to_string(&ev("ok", 0)).unwrap();
        // 壊れた行 / 空行 / 必須欠落 / 正常 / 未知フィールド付き（前方互換）を混ぜる。
        let future = r#"{"v":2,"session_id":"s","pane_id":2,"block_id":"future","exit_code":0,"started_at":1,"ended_at":2,"duration_ms":1,"brand_new_field":123}"#;
        let content = format!("not json\n\n{{\"partial\":true}}\n{good}\n{future}\n");
        std::fs::write(day_file(&dir, "2026-07-01"), content).unwrap();
        let got = read_events_from(&dir, "2026-07-01");
        // "not json" と {"partial":true}（必須欠落）はスキップ、good と future（未知フィールド無視）は通る。
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].block_id, "ok");
        assert_eq!(got[1].block_id, "future");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn invalid_day_is_rejected_and_falls_back() {
        assert!(is_valid_day("2026-07-01"));
        assert!(!is_valid_day("2026-7-1"));
        assert!(!is_valid_day("2026-07-01x"));
        assert!(!is_valid_day("../etc/pw"));
        assert!(!is_valid_day("2026/07/01"));
        assert_eq!(
            day_file(Path::new("base"), "../evil").file_name().unwrap(),
            "unknown.jsonl"
        );
    }

    #[test]
    fn large_text_survives_roundtrip() {
        let dir = temp("bigtext");
        let _ = std::fs::remove_dir_all(&dir);
        let mut e = ev("big", 0);
        e.text = "x\ny\n".repeat(20_000); // 埋め込み改行が JSONL を壊さないことも兼ねて検証
        e.truncated = true;
        write_event_to(&dir, "2026-07-01", &e).unwrap();
        let got = read_events_from(&dir, "2026-07-01");
        assert_eq!(got.len(), 1);
        assert!(got[0].truncated);
        assert_eq!(got[0].text, e.text);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
