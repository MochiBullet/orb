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
    /// コマンド行のみ（#33: OSC 633;E＋nonce 検証で確定）。マーカー不在は null。
    #[serde(default)]
    pub command: Option<String>,
    /// 出力本文のみ（#33: OSC 633;C の出力開始マーカーで確定）。マーカー不在は null。
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
///
/// 既知の割り切り: 書き込みバイト数に上限は無い（MAX_DAY_FILE_BYTES は読み取り側の tail cap
/// のみで、追記自体は無制限）。暴走ループが起きれば 1 日分の JSONL が際限なく肥大しうるが、
/// 1 ブロックの text は最大 8000 文字（capText, blocks-log.ts）＝現実的な操作回数では
/// この上限に遠く及ばない規模であり、書き込み側にもローテーション/切り詰めを足すと
/// 「追記順=時系列」という読み取り側の前提が崩れやすくなる。歯止めは追加せず、この
/// 割り切りとして明文化するに留める。
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

/// 1 日分の JSONL を読む際の上限バイト数。append_block_event が暴走ループ等で
/// 1 日分を数百MBまで肥大させても、毎回全文字列化してパースしないための歯止め
/// （usage_local.rs の `read_tail`/`MAX_TAIL_BYTES` と同じ方針を踏襲）。1 ブロックの
/// text は最大 8000 文字（capText, blocks-log.ts）なので、通常運用の 1 日分ログは
/// この上限に遠く及ばない＝実利用では今までと同じ結果になる。
const MAX_DAY_FILE_BYTES: u64 = 16 * 1024 * 1024;

/// 指定日の JSONL を読み戻す。壊れた行・将来スキーマの行は黙ってスキップ（前方互換・耐障害）。
/// 巨大化したファイルは末尾 `MAX_DAY_FILE_BYTES` のみ読む（古い方のブロックが読み戻し対象から
/// 落ちるのは許容——履歴オーバーレイの再描画では直近が優先）。
fn read_events_from(dir: &Path, day: &str) -> Vec<BlockEvent> {
    let path = day_file(dir, day);
    let Ok(meta) = std::fs::metadata(&path) else { return Vec::new() };
    let text = crate::usage_local::read_tail(&path, meta.len(), MAX_DAY_FILE_BYTES);
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<BlockEvent>(l).ok())
        .collect()
}

/// 保持する日次 JSONL ファイルの最大数（≒日数）。#49 の検索対象もこの範囲に限られる。
/// Fable5 レビュー指摘: retention 方針が未定で `~/.config/orb/blocks/` が無限に肥大する。
const MAX_LOG_DAYS: usize = 90;

/// 新しい方 keep 件（日）を残して古い日次 JSONL を消す（best-effort・失敗は無視）。
/// ファイル名が `YYYY-MM-DD.jsonl` なので文字列ソートがそのまま時系列ソートになる。
fn prune_old_logs(dir: &Path, keep: usize) {
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("jsonl"))
        .filter(|p| {
            p.file_stem()
                .and_then(|s| s.to_str())
                .map(is_valid_day)
                .unwrap_or(false)
        })
        .collect();
    files.sort();
    if files.len() > keep {
        for p in &files[..files.len() - keep] {
            let _ = std::fs::remove_file(p);
        }
    }
}

/// フロントから 1 ブロック分を追記する（#31）。書き込みは専用スレッドへ逃がす。
#[tauri::command]
pub async fn append_block_event(day: String, event: BlockEvent) -> Result<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = blocks_dir();
        let res = write_event_to(&dir, &day, &event);
        if res.is_ok() {
            prune_old_logs(&dir, MAX_LOG_DAYS);
        }
        res
    })
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

// ---- #49 全期間横断検索 -------------------------------------------------------------------
//
// `blocks/*.jsonl` を日付降順に 1 ファイルずつストリーム走査する（全ファイル一括ロードはしない）。
// ファイル内は追記順＝時系列なので逆順に読む＝結果はグローバルに「新しい順」。limit 到達で即打ち切り。

/// 横断検索のフィルタ。フロントの `parseSearchQuery`（blocks-log.ts）が組む・snake_case 1:1。
#[derive(Deserialize, Clone, Debug)]
pub struct SearchFilters {
    /// AND 検索語（大文字小文字は無視）。空なら全件（他フィルタのみで絞る）。
    #[serde(default)]
    pub terms: Vec<String>,
    /// "ok"（exit 0）| "fail"（exit ≠ 0）| 終了コードの数値文字列。不明な値は無視。
    #[serde(default)]
    pub exit: Option<String>,
    /// cwd の部分一致（大文字小文字は無視）。
    #[serde(default)]
    pub cwd: Option<String>,
    /// 検索対象: "all"（既定）| "command" | "output"。
    #[serde(default)]
    pub field: Option<String>,
    /// 日付範囲（YYYY-MM-DD・両端含む）。不正な形式は無視。
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    /// 最大ヒット件数（1..=1000 に clamp）。
    #[serde(default = "default_search_limit")]
    pub limit: usize,
}

fn default_search_limit() -> usize {
    200
}

/// 1 ヒット。UI の日付見出し用に、由来ファイルの日付を添える。
#[derive(Serialize, Debug)]
pub struct SearchHit {
    pub day: String,
    pub event: BlockEvent,
}

#[derive(Serialize, Debug)]
pub struct SearchResult {
    pub hits: Vec<SearchHit>,
    /// 実際に読んだ日数（範囲外スキップ・打ち切り後は数えない）。
    pub scanned_days: u32,
    /// limit で打ち切った（＝まだ古い方にヒットが残っている可能性がある）。
    pub limit_hit: bool,
}

enum ExitFilter {
    Any,
    Ok,
    Fail,
    Code(i64),
}

enum SearchField {
    All,
    Command,
    Output,
}

/// 検索前に一度だけ正規化したフィルタ（小文字化・clamp・プリフィルタ可否の判定）。
struct NormFilters {
    terms: Vec<String>,
    exit: ExitFilter,
    cwd: Option<String>,
    field: SearchField,
    from: Option<String>,
    to: Option<String>,
    limit: usize,
    /// 生行プリフィルタを使ってよいか。serde_json が生のまま書く文字だけで構成された語
    /// （`"` `\` 制御文字を含まない）なら、パース前の行 contains は「含まない＝不一致」の
    /// 高速棄却として安全（一致判定そのものはパース後の matches が行う）。
    prefilter: bool,
}

fn normalize_filters(f: &SearchFilters) -> NormFilters {
    let terms: Vec<String> = f
        .terms
        .iter()
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let prefilter = !terms.is_empty()
        && terms
            .iter()
            .all(|t| !t.chars().any(|c| c == '"' || c == '\\' || c.is_control()));
    let exit = match f.exit.as_deref() {
        Some("ok") => ExitFilter::Ok,
        Some("fail") => ExitFilter::Fail,
        Some(s) => s.parse::<i64>().map(ExitFilter::Code).unwrap_or(ExitFilter::Any),
        None => ExitFilter::Any,
    };
    let valid_day = |d: &Option<String>| d.as_deref().filter(|s| is_valid_day(s)).map(String::from);
    NormFilters {
        terms,
        exit,
        cwd: f.cwd.as_deref().map(|c| c.to_lowercase()).filter(|c| !c.is_empty()),
        field: match f.field.as_deref() {
            Some("command") => SearchField::Command,
            Some("output") => SearchField::Output,
            _ => SearchField::All,
        },
        from: valid_day(&f.from),
        to: valid_day(&f.to),
        limit: f.limit.clamp(1, 1000),
        prefilter,
    }
}

/// blocks ディレクトリの日付ファイル（YYYY-MM-DD.jsonl）を新しい日付順で列挙する。
fn list_days(dir: &Path) -> Vec<String> {
    let mut days: Vec<String> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                let day = name.strip_suffix(".jsonl")?.to_string();
                is_valid_day(&day).then_some(day)
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    days.sort_unstable_by(|a, b| b.cmp(a));
    days
}

fn event_matches(e: &BlockEvent, f: &NormFilters) -> bool {
    match f.exit {
        ExitFilter::Any => {}
        ExitFilter::Ok => {
            if e.exit_code != 0 {
                return false;
            }
        }
        ExitFilter::Fail => {
            if e.exit_code == 0 {
                return false;
            }
        }
        ExitFilter::Code(c) => {
            if e.exit_code != c {
                return false;
            }
        }
    }
    if let Some(c) = &f.cwd {
        if !e.cwd.to_lowercase().contains(c.as_str()) {
            return false;
        }
    }
    if f.terms.is_empty() {
        return true;
    }
    let hay = match f.field {
        // command のみ: #33 で確定した行だけが対象（マーカー不在＝候補にしない。嘘をつかない）。
        SearchField::Command => match &e.command {
            Some(c) => c.clone(),
            None => return false,
        },
        // output のみ: 確定 output_body の無い旧レコードは全文へフォールバック（取りこぼし優先で回収）。
        SearchField::Output => e.output_body.clone().unwrap_or_else(|| e.text.clone()),
        SearchField::All => format!("{} {} {}", e.command.as_deref().unwrap_or(""), e.text, e.cwd),
    }
    .to_lowercase();
    f.terms.iter().all(|t| hay.contains(t.as_str()))
}

/// 横断検索の本体（dir 注入でテスト可能）。日付降順・ファイル内逆順＝新しい順、limit で有界。
fn search_events_in(dir: &Path, filters: &SearchFilters) -> SearchResult {
    let f = normalize_filters(filters);
    let mut hits: Vec<SearchHit> = Vec::new();
    let mut scanned_days = 0u32;
    let mut limit_hit = false;
    'days: for day in list_days(dir) {
        // 降順走査なので from 未満に達したら以降はすべて範囲外＝打ち切り。to 超えはスキップして続行。
        if let Some(from) = &f.from {
            if day.as_str() < from.as_str() {
                break;
            }
        }
        if let Some(to) = &f.to {
            if day.as_str() > to.as_str() {
                continue;
            }
        }
        let path = day_file(dir, &day);
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        // 巨大化した日次ファイルは末尾 MAX_DAY_FILE_BYTES のみ読む（read_events_from と同じ
        // 歯止め）。検索は新しい順ヒットを優先するので、末尾＝最新側だけ見る打ち切りは自然。
        let text = crate::usage_local::read_tail(&path, meta.len(), MAX_DAY_FILE_BYTES);
        scanned_days += 1;
        for line in text.lines().rev() {
            if line.trim().is_empty() {
                continue;
            }
            if f.prefilter {
                let low = line.to_lowercase();
                if !f.terms.iter().all(|t| low.contains(t.as_str())) {
                    continue;
                }
            }
            let e = match serde_json::from_str::<BlockEvent>(line) {
                Ok(e) => e,
                Err(_) => continue, // 壊れた行・将来スキーマは読み戻し同様スキップ
            };
            if !event_matches(&e, &f) {
                continue;
            }
            hits.push(SearchHit { day: day.clone(), event: e });
            if hits.len() >= f.limit {
                limit_hit = true;
                break 'days;
            }
        }
    }
    SearchResult { hits, scanned_days, limit_hit }
}

/// #49: 全期間のブロックログを横断検索する（日付降順ストリーム・limit で有界）。
#[tauri::command]
pub async fn search_block_events(filters: SearchFilters) -> SearchResult {
    tauri::async_runtime::spawn_blocking(move || search_events_in(&blocks_dir(), &filters))
        .await
        .unwrap_or_else(|_| SearchResult { hits: Vec::new(), scanned_days: 0, limit_hit: false })
}

// ---- #55 セッション要約の引き継ぎファイル出力 ---------------------------------------------

/// 要約 MD を `<cwd>/HANDOFF-<day>.md` へ書き出す（dir 検証込み・上書き可）。戻り値=フルパス。
fn save_handoff_to(cwd: &str, day: &str, content: &str) -> Result<String> {
    if cwd.trim().is_empty() {
        return Err(AppError::Config("handoff: cwd が空です".into()));
    }
    if !is_valid_day(day) {
        return Err(AppError::Config(format!("handoff: 不正な day: {day}")));
    }
    // フロントは信頼しているが、存在しない cwd に書こうとして分かりにくい I/O エラーに
    // なるのを避けるための軽い事前チェック。
    if !Path::new(cwd).is_dir() {
        return Err(AppError::Config(format!("handoff: cwd が存在しません: {cwd}")));
    }
    let path = Path::new(cwd).join(format!("HANDOFF-{day}.md"));
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().into_owned())
}

/// #55: セッション要約を対象プロジェクトの cwd へ HANDOFF ファイルとして保存する。
#[tauri::command]
pub async fn save_handoff_file(cwd: String, day: String, content: String) -> Result<String> {
    tauri::async_runtime::spawn_blocking(move || save_handoff_to(&cwd, &day, &content))
        .await
        .map_err(|e| AppError::Config(format!("handoff task: {e}")))?
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
    fn prune_old_logs_keeps_newest_n_days() {
        let dir = temp("prune-keep");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for day in ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"] {
            write_event_to(&dir, day, &ev("b", 0)).unwrap();
        }
        prune_old_logs(&dir, 2);
        let mut remaining: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        remaining.sort();
        // 文字列ソート＝時系列ソートなので、新しい2日分（06-04・06-05）だけが残る。
        assert_eq!(remaining, vec!["2026-06-04.jsonl", "2026-06-05.jsonl"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_old_logs_is_noop_when_under_the_limit() {
        let dir = temp("prune-under");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_event_to(&dir, "2026-06-01", &ev("b", 0)).unwrap();
        prune_old_logs(&dir, 90);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_old_logs_ignores_non_jsonl_and_malformed_names() {
        let dir = temp("prune-ignore");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_event_to(&dir, "2026-06-01", &ev("b", 0)).unwrap();
        std::fs::write(dir.join("not-a-day.jsonl"), "{}").unwrap();
        std::fs::write(dir.join("README.md"), "hi").unwrap();
        prune_old_logs(&dir, 0); // keep=0 でも不正な名前のファイルは対象外＝消えない
        let remaining: std::collections::HashSet<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(remaining.contains("not-a-day.jsonl"));
        assert!(remaining.contains("README.md"));
        assert!(!remaining.contains("2026-06-01.jsonl")); // 正当な日次ファイルだけ keep=0 で消える
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

    /// Bug: `read_events_from`/`search_events_in` used to `read_to_string` a whole day's
    /// JSONL with no size cap. A runaway `append_block_event` loop (or just heavy sustained
    /// use) can grow a single day's file to hundreds of MB; every subsequent read would then
    /// allocate+parse the whole thing. This proves the MAX_DAY_FILE_BYTES tail cap actually
    /// bounds what gets parsed: the oldest record (written first, now past the cutoff) must
    /// be dropped, while the newest record (at the very end of the file) must still parse.
    #[test]
    fn read_events_from_caps_a_giant_day_file_to_a_bounded_tail() {
        use std::io::Write as _;

        let dir = temp("giant-day-cap");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = day_file(&dir, "2026-07-01");

        let mut file = std::fs::File::create(&path).unwrap();

        // 先頭：cap が効いていれば絶対に読まれてはいけない目印イベント。
        let mut oldest = ev("oldest", 0);
        oldest.text = "x".repeat(1000);
        writeln!(file, "{}", serde_json::to_string(&oldest).unwrap()).unwrap();

        // MAX_DAY_FILE_BYTES を確実に超えるまで埋め草行を詰める（暴走ループの再現）。
        let mut filler = ev("filler", 0);
        filler.text = "y".repeat(1000);
        let filler_line = serde_json::to_string(&filler).unwrap();
        let target_bytes = (MAX_DAY_FILE_BYTES as usize) + 2_000_000;
        let mut written = 0usize;
        while written < target_bytes {
            writeln!(file, "{filler_line}").unwrap();
            written += filler_line.len() + 1;
        }

        // 末尾：cap が効いていても必ず読めるはずの最新イベント。
        let newest = ev("newest", 0);
        writeln!(file, "{}", serde_json::to_string(&newest).unwrap()).unwrap();
        drop(file);

        let file_len = std::fs::metadata(&path).unwrap().len();
        assert!(file_len > MAX_DAY_FILE_BYTES, "test setup must exceed the cap to be meaningful");

        let got = read_events_from(&dir, "2026-07-01");
        assert!(got.iter().any(|e| e.block_id == "newest"), "tail record must survive the cap");
        assert!(!got.iter().any(|e| e.block_id == "oldest"), "record before the cap must be dropped, not parsed");

        // 同じ歯止めを共有する search_events_in でも、末尾の新しいイベントは検索可能なまま。
        let searched = search_events_in(&dir, &filters());
        assert!(searched.hits.iter().any(|h| h.event.block_id == "newest"));
        assert!(!searched.hits.iter().any(|h| h.event.block_id == "oldest"));

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

    /// 検索テスト用のフィルタ（既定＝無条件・limit 200）。
    fn filters() -> SearchFilters {
        SearchFilters {
            terms: vec![],
            exit: None,
            cwd: None,
            field: None,
            from: None,
            to: None,
            limit: 200,
        }
    }

    /// 3 日分のログを作る。各日 2 件（追記順＝古→新）。
    fn seed_days(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
        for (day, ids) in [
            ("2026-06-29", ["a1", "a2"]),
            ("2026-06-30", ["b1", "b2"]),
            ("2026-07-01", ["c1", "c2"]),
        ] {
            for id in ids {
                write_event_to(dir, day, &ev(id, 0)).unwrap();
            }
        }
    }

    #[test]
    fn search_is_newest_first_across_days_and_bounded() {
        let dir = temp("search-order");
        seed_days(&dir);
        let got = search_events_in(&dir, &filters());
        let order: Vec<&str> = got.hits.iter().map(|h| h.event.block_id.as_str()).collect();
        // 日付降順 × ファイル内逆順 ＝ グローバル新しい順。
        assert_eq!(order, ["c2", "c1", "b2", "b1", "a2", "a1"]);
        assert_eq!(got.hits[0].day, "2026-07-01");
        assert!(!got.limit_hit);
        assert_eq!(got.scanned_days, 3);

        let bounded = search_events_in(&dir, &SearchFilters { limit: 3, ..filters() });
        assert_eq!(bounded.hits.len(), 3);
        assert!(bounded.limit_hit);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_filters_exit_cwd_and_terms() {
        let dir = temp("search-filter");
        let _ = std::fs::remove_dir_all(&dir);
        let mut fail = ev("f1", 101);
        fail.text = "cargo build\nerror: expected `;`".into();
        fail.cwd = r"C:\proj\orb".into();
        let mut ok = ev("o1", 0);
        ok.text = "cargo build\nFinished dev".into();
        ok.cwd = r"C:\proj\other".into();
        write_event_to(&dir, "2026-07-01", &fail).unwrap();
        write_event_to(&dir, "2026-07-01", &ok).unwrap();

        // exit:fail ＋ 語 AND（大文字小文字無視）
        let got = search_events_in(
            &dir,
            &SearchFilters { terms: vec!["CARGO".into()], exit: Some("fail".into()), ..filters() },
        );
        assert_eq!(got.hits.len(), 1);
        assert_eq!(got.hits[0].event.block_id, "f1");

        // exit:0 は数値指定でも通る
        let got = search_events_in(&dir, &SearchFilters { exit: Some("0".into()), ..filters() });
        assert_eq!(got.hits.len(), 1);
        assert_eq!(got.hits[0].event.block_id, "o1");

        // cwd 部分一致（小文字化）
        let got = search_events_in(&dir, &SearchFilters { cwd: Some("ORB".into()), ..filters() });
        assert_eq!(got.hits.len(), 1);
        assert_eq!(got.hits[0].event.block_id, "f1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_field_scopes_are_honest() {
        let dir = temp("search-scope");
        let _ = std::fs::remove_dir_all(&dir);
        // command 確定済み（#33 マーカーあり）
        let mut with_cmd = ev("cmd1", 0);
        with_cmd.command = Some("pnpm vitest run".into());
        with_cmd.output_body = Some("62 passed".into());
        // マーカー無しの旧レコード（command/output_body = null）。text にだけ語が居る。
        let mut legacy = ev("old1", 0);
        legacy.text = "pnpm vitest run\n62 passed".into();
        write_event_to(&dir, "2026-07-01", &with_cmd).unwrap();
        write_event_to(&dir, "2026-07-01", &legacy).unwrap();

        // in:command → 確定 command を持つレコードだけ（legacy は候補にしない＝嘘をつかない）
        let got = search_events_in(
            &dir,
            &SearchFilters { terms: vec!["vitest".into()], field: Some("command".into()), ..filters() },
        );
        assert_eq!(got.hits.len(), 1);
        assert_eq!(got.hits[0].event.block_id, "cmd1");

        // in:output → output_body、無ければ text へフォールバック（旧レコードも回収）
        let got = search_events_in(
            &dir,
            &SearchFilters { terms: vec!["passed".into()], field: Some("output".into()), ..filters() },
        );
        assert_eq!(got.hits.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_date_range_bounds_scan() {
        let dir = temp("search-range");
        seed_days(&dir);
        let got = search_events_in(
            &dir,
            &SearchFilters {
                from: Some("2026-06-30".into()),
                to: Some("2026-06-30".into()),
                ..filters()
            },
        );
        assert_eq!(got.hits.len(), 2);
        assert!(got.hits.iter().all(|h| h.day == "2026-06-30"));
        // to で新しい日をスキップ、from 未満に達した時点で走査を打ち切る＝読むのは 1 日分だけ。
        assert_eq!(got.scanned_days, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn search_prefilter_stays_correct_for_escaped_and_unicode_terms() {
        let dir = temp("search-prefilter");
        let _ = std::fs::remove_dir_all(&dir);
        let mut e = ev("jp", 1);
        e.text = "type 日本語のログ.txt\nsay \"hi\" と出た".into();
        write_event_to(&dir, "2026-07-01", &e).unwrap();

        // 非 ASCII 語: serde_json は生 UTF-8 で書くのでプリフィルタ経路でも一致する
        let got =
            search_events_in(&dir, &SearchFilters { terms: vec!["日本語".into()], ..filters() });
        assert_eq!(got.hits.len(), 1);

        // `"` を含む語: JSON では \" にエスケープされる＝プリフィルタ不可と判定され、
        // フルパース経路で正しく一致する（棄却で取りこぼさない）
        let got = search_events_in(
            &dir,
            &SearchFilters { terms: vec![r#"say "hi""#.into()], ..filters() },
        );
        assert_eq!(got.hits.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_writes_and_overwrites_file() {
        let dir = temp("handoff");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        let path = save_handoff_to(&cwd, "2026-07-03", "# 作業ログ v1\n").unwrap();
        assert!(path.ends_with("HANDOFF-2026-07-03.md"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# 作業ログ v1\n");
        // 既存ファイルは上書き。
        save_handoff_to(&cwd, "2026-07-03", "# v2\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# v2\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn handoff_rejects_invalid_day_and_empty_cwd() {
        let dir = temp("handoff-reject");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().into_owned();
        // パストラバーサル級の day はファイル名に使わせない。
        assert!(save_handoff_to(&cwd, "../evil", "x").is_err());
        assert!(save_handoff_to(&cwd, "2026-7-3", "x").is_err());
        assert!(save_handoff_to("", "2026-07-03", "x").is_err());
        assert!(save_handoff_to("   ", "2026-07-03", "x").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 存在しない cwd への書き込みは、分かりにくい I/O エラーではなく明示的な Err にする。
    #[test]
    fn handoff_rejects_nonexistent_cwd_dir() {
        let dir = temp("handoff-nodir");
        let _ = std::fs::remove_dir_all(&dir); // 意図的に作らない＝存在しないディレクトリ
        let cwd = dir.to_string_lossy().into_owned();
        assert!(save_handoff_to(&cwd, "2026-07-03", "x").is_err());
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
