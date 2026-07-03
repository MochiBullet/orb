//! #52: 案件（cwd）別のローカル token 消費集計。
//!
//! 公式 usage API（org 全体の 5h/7d %）とは別に、「この案件で直近どれだけ使ったか」を
//! Claude Code 自身のセッション記録（`~/.claude/projects/*/​*.jsonl`）から出す。
//! ネットワークもトークンも消費しない、ただのローカル集計。
//!
//! **ディレクトリ名（`~/.claude/projects/<sanitized-cwd>/`）では絞り込まない**——
//! Claude Code のプロジェクトディレクトリは「セッション起動時の cwd」で固定され、
//! セッション中に `cd` しても追従しない。orb はまさに `cd` を多用する vibe-coding
//! ターミナルなので、「home で起動して cd で案件に入る」が常態＝ディレクトリ名一致では
//! ほぼ常に空振りする（実データで確認済み）。代わりに **全プロジェクトを横断し、
//! 各行が実際に記録している `cwd` フィールドを対象パスの prefix と突き合わせる**。
//!
//! 集計窓はローカル暦日ではなく**ローリング24時間**（直近1hのburnも同様にローリング）。
//! タイムゾーン変換は追加クレート無しでは正確に組めず、雑に組むと「今日」の意味を
//! 静かに壊す（#41の「嘘をつかない」精神に反する）。ローリング窓なら深夜跨ぎでも
//! 破綻せず、依存も増えない。
//!
//! 既知の割り切り: サブエージェント/workflow の transcript は各セッションディレクトリの
//! さらに下（`<uuid>/subagents/**`）に置かれ、本スキャンは非再帰なので対象外＝
//! サブエージェント経由の消費が多い案件では「案件24h」が実コストを過小表示する。
//! 深いネストを追うと巨大ファイル群を再帰的に踏むことになり性能リスクが増すため見送り。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// サイドバー表示用の集計結果。取得不能（プロジェクト未作成・読み取り失敗等）は
/// 黙って全 0（既存の get_mcp_health 等と同じ「取れなければ従来表示」方針）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct LocalUsage {
    /// 直近24時間のトークン消費合計（input + output + cache_creation_input。
    /// cache_read はほぼ無視できるコストなので体感の「使った量」から除外）。
    pub last_24h_tokens: u64,
    /// 直近1時間のトークン消費合計。burn rate の分子。
    pub last_hour_tokens: u64,
}

/// 巨大ファイルでも末尾だけ読めば直近24hの集計には十分。16MB は実マシンで観測された
/// 最大級のトランスクリプト（~28MB）でも直近24h分を十分カバーする余裕を持たせた値。
const MAX_TAIL_BYTES: u64 = 16 * 1024 * 1024;

/// `YYYY-MM-DDTHH:MM:SS[.sss]Z` を epoch ms に変換する（Claude Code の transcript 形式専用の
/// 最小パーサ。タイムゾーン付き外部クレートを増やさないための自前実装）。
fn parse_iso8601_ms(s: &str) -> Option<i64> {
    if s.len() < 20 {
        return None;
    }
    let year: i64 = s.get(0..4)?.parse().ok()?;
    let month: u32 = s.get(5..7)?.parse().ok()?;
    let day: u32 = s.get(8..10)?.parse().ok()?;
    let hour: i64 = s.get(11..13)?.parse().ok()?;
    let min: i64 = s.get(14..16)?.parse().ok()?;
    let sec: i64 = s.get(17..19)?.parse().ok()?;
    let ms: i64 = if s.as_bytes().get(19) == Some(&b'.') { s.get(20..23)?.parse().ok()? } else { 0 };
    let days = days_from_civil(year, month, day);
    Some((days * 86_400 + hour * 3600 + min * 60 + sec) * 1000 + ms)
}

/// Howard Hinnant の `days_from_civil`。1970-01-01 からの日数（負値も正しく扱う）。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// OS 固有のパス区切り文字。Windows は `\`、Unix は `/`（Claude Code の transcript の
/// `cwd` フィールドは実行時の OS ネイティブな形式で記録されるため、比較側もそれに合わせる）。
#[cfg(windows)]
const PATH_SEP: char = '\\';
#[cfg(not(windows))]
const PATH_SEP: char = '/';

/// パス比較用に正規化する（末尾セパレータを落とす。Windows のみ追加で小文字化＋
/// `/` を `\` に統一——大小文字を区別しないファイルシステムのため prefix 一致もそれに
/// 合わせる。Unix は ext4 等の大小文字を区別するファイルシステムが標準のため素通し）。
fn normalize_path(p: &str) -> String {
    #[cfg(windows)]
    let s = p.trim().to_lowercase().replace('/', "\\");
    #[cfg(not(windows))]
    let s = p.trim().to_string();
    s.strip_suffix(PATH_SEP).map(str::to_string).unwrap_or(s)
}

/// `line_cwd` が `target`（正規化済み）配下（＝ target 自身、または target の子孫）かを判定する。
/// 単純な `starts_with` だとディレクトリ境界を無視して `.../orb` が `.../orb2` にも
/// マッチしてしまうため、次の文字が区切り or 終端であることまで確認する。
fn cwd_under(line_cwd: &str, target_norm: &str) -> bool {
    let line_norm = normalize_path(line_cwd);
    if line_norm == target_norm {
        return true;
    }
    line_norm
        .strip_prefix(target_norm)
        .is_some_and(|rest| rest.starts_with(PATH_SEP))
}

/// 1 JSONL 行から (発生時刻ms, トークン数, cwd) を取り出す。`type:"assistant"` 以外・
/// cwd 欠落・壊れた行は None（cwd で prefix 一致を取るため、cwd 無しの行は集計しようがない）。
fn parse_usage_line(line: &str) -> Option<(i64, u64, String)> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    if v.get("type")?.as_str()? != "assistant" {
        return None;
    }
    let ts_ms = parse_iso8601_ms(v.get("timestamp")?.as_str()?)?;
    let cwd = v.get("cwd")?.as_str()?.to_string();
    // usage は message.usage（実運用の transcript）と usage 直下（互換のため）の両方を見る。
    let usage = v.get("message").and_then(|m| m.get("usage")).or_else(|| v.get("usage"))?;
    let input = usage.get("input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let output = usage.get("output_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    let cache_creation = usage.get("cache_creation_input_tokens").and_then(|x| x.as_u64()).unwrap_or(0);
    Some((ts_ms, input + output + cache_creation, cwd))
}

/// ファイル末尾 `max_bytes` バイトだけ読む。境界で千切れた先頭の壊れ行は 1 行分捨てる。
fn read_tail(path: &Path, len: u64, max_bytes: u64) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut f) = std::fs::File::open(path) else { return String::new() };
    let start = len.saturating_sub(max_bytes);
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if start > 0 {
        match text.find('\n') {
            Some(idx) => text = text[idx + 1..].to_string(),
            None => text.clear(), // max_bytes丸ごとが1行未満の異常系は諦める
        }
    }
    text
}

/// `~/.claude/projects/` 直下の全プロジェクトディレクトリを横断し、`target_cwd` 配下の
/// 行だけを集計する（dir を引数に取り、テストが temp を差し込める）。
fn scan_all_projects(projects_root: &Path, target_cwd: &str, now_ms: i64) -> LocalUsage {
    let day_ago_ms = now_ms - 24 * 3600 * 1000;
    let hour_ago_ms = now_ms - 3600 * 1000;
    let target_norm = normalize_path(target_cwd);
    let mut out = LocalUsage::default();

    let Ok(project_dirs) = std::fs::read_dir(projects_root) else { return out };
    for pdir_entry in project_dirs.filter_map(|e| e.ok()) {
        let pdir = pdir_entry.path();
        if !pdir.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&pdir) else { continue };
        for entry in files.filter_map(|e| e.ok()) {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Ok(meta) = entry.metadata() else { continue };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            // 24h より前に最終更新されたファイルは、直近24h分のデータを含みようがない（追記のみのログ）。
            if modified_ms < day_ago_ms {
                continue;
            }
            let text = read_tail(&path, meta.len(), MAX_TAIL_BYTES);
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                let Some((ts_ms, tokens, cwd)) = parse_usage_line(line) else { continue };
                if !cwd_under(&cwd, &target_norm) {
                    continue;
                }
                if ts_ms >= day_ago_ms {
                    out.last_24h_tokens += tokens;
                }
                if ts_ms >= hour_ago_ms {
                    out.last_hour_tokens += tokens;
                }
            }
        }
    }
    out
}

fn claude_projects_dir() -> PathBuf {
    crate::status::home_dir().join(".claude").join("projects")
}

/// #52: cwd 配下（＝その案件で作業した全セッション、起動時cwdに関わらず）が直近24hに
/// 消費したローカル token 量を集計する。cwd 未指定・読み取り失敗は全て黙って全 0 を返す。
pub fn fetch_local_usage(cwd: Option<String>) -> LocalUsage {
    let Some(cwd) = cwd.filter(|c| !c.is_empty()) else { return LocalUsage::default() };
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    scan_all_projects(&claude_projects_dir(), &cwd, now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_and_cwd_under_are_case_insensitive_and_boundary_safe() {
        assert_eq!(normalize_path(r"C:\Users\hiyok\Orb\"), r"c:\users\hiyok\orb");
        assert_eq!(normalize_path("C:/Users/hiyok/orb"), r"c:\users\hiyok\orb");

        // 完全一致・子孫はマッチ
        assert!(cwd_under(r"C:\Users\hiyok\orb", r"c:\users\hiyok\orb"));
        assert!(cwd_under(r"C:\Users\hiyok\orb\src-tauri", r"c:\users\hiyok\orb"));
        // 大小文字違いでもマッチ（Windows パス）
        assert!(cwd_under(r"c:\USERS\HIYOK\ORB\src", r"c:\users\hiyok\orb"));
        // 兄弟ディレクトリ（orb2）や無関係パスは誤マッチしない（境界チェック）
        assert!(!cwd_under(r"C:\Users\hiyok\orb2", r"c:\users\hiyok\orb"));
        assert!(!cwd_under(r"C:\Users\hiyok", r"c:\users\hiyok\orb"));
        assert!(!cwd_under(r"C:\Users\hiyok\other", r"c:\users\hiyok\orb"));
    }

    #[test]
    fn parse_iso8601_ms_matches_known_epoch_constants() {
        assert_eq!(parse_iso8601_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso8601_ms("2000-01-01T00:00:00.000Z"), Some(946_684_800_000));
        assert_eq!(parse_iso8601_ms("2024-01-01T00:00:00.000Z"), Some(1_704_067_200_000));
        assert_eq!(parse_iso8601_ms("2026-01-01T00:00:00.000Z"), Some(1_767_225_600_000));
        // 実データの形（ミリ秒つき）
        assert_eq!(
            parse_iso8601_ms("2026-07-03T14:29:50.407Z"),
            Some(1_767_225_600_000 + (31 + 28 + 31 + 30 + 31 + 30 + 2) * 86_400_000 + 14 * 3_600_000 + 29 * 60_000 + 50_000 + 407)
        );
        assert_eq!(parse_iso8601_ms("not-a-date"), None);
        assert_eq!(parse_iso8601_ms("2026-07-03"), None); // 短すぎる
    }

    #[test]
    fn parse_usage_line_extracts_assistant_rows_with_cwd_only() {
        let assistant = r#"{"type":"assistant","cwd":"C:\\Users\\hiyok\\orb","timestamp":"2026-07-03T14:29:50.407Z","message":{"usage":{"input_tokens":2,"output_tokens":297,"cache_creation_input_tokens":367,"cache_read_input_tokens":635646}}}"#;
        let (ts, tok, cwd) = parse_usage_line(assistant).unwrap();
        assert_eq!(tok, 2 + 297 + 367); // cache_read は含めない
        assert!(ts > 0);
        assert_eq!(cwd, r"C:\Users\hiyok\orb");

        // user 行・system 行は無視
        let user = r#"{"type":"user","cwd":"C:\\Users\\hiyok\\orb","timestamp":"2026-07-03T14:29:50.407Z","message":{"content":"hi"}}"#;
        assert!(parse_usage_line(user).is_none());

        // 壊れた行・欠落フィールド（cwd 無しも含む）は None（クラッシュしない）
        assert!(parse_usage_line("not json").is_none());
        assert!(parse_usage_line(r#"{"type":"assistant"}"#).is_none());
        assert!(parse_usage_line(r#"{"type":"assistant","timestamp":"2026-07-03T14:29:50.407Z"}"#).is_none());

        // 互換: usage が直下にあるケースも拾う
        let flat = r#"{"type":"assistant","cwd":"C:\\Users\\hiyok","timestamp":"2026-07-03T14:29:50.407Z","usage":{"input_tokens":5,"output_tokens":10}}"#;
        let (_, tok2, _) = parse_usage_line(flat).unwrap();
        assert_eq!(tok2, 15);
    }

    fn write_line(dir: &Path, file: &str, day: &str, cwd: &str, input: u64, output: u64) {
        std::fs::create_dir_all(dir).unwrap();
        let line = format!(
            r#"{{"type":"assistant","cwd":"{cwd}","timestamp":"{day}","message":{{"usage":{{"input_tokens":{input},"output_tokens":{output},"cache_creation_input_tokens":0}}}}}}"#,
            cwd = cwd.replace('\\', "\\\\"),
        );
        std::fs::write(dir.join(file), line + "\n").unwrap();
    }

    /// #52 レビュー指摘の再現: セッション起動時 cwd（ホーム）配下のファイルに、
    /// 実際は子ディレクトリ（orb）で行った作業の行が記録されているケース。
    /// ディレクトリ名一致方式なら拾えなかったが、cwd フィールド一致なら拾える。
    #[test]
    fn scan_all_projects_finds_usage_recorded_under_a_different_project_dir_name() {
        let root = std::env::temp_dir().join("orb-usage-local-test-crossdir");
        let _ = std::fs::remove_dir_all(&root);
        let home_project = root.join("C--Users-hiyok"); // セッション起動時 cwd = home
        let orb_project = root.join("C--Users-hiyok-orb"); // orb 用ディレクトリは存在するが空
        std::fs::create_dir_all(&orb_project).unwrap();

        let now = parse_iso8601_ms("2026-07-03T20:00:00.000Z").unwrap();
        // home 配下のセッションファイルに、cwd="...\orb" の行が記録されている（cd した後）
        write_line(&home_project, "session.jsonl", "2026-07-03T19:30:00.000Z", r"C:\Users\hiyok\orb", 10, 20);
        // 兄弟プロジェクト（orb2）の行は拾わない（境界チェックの回帰防止）
        write_line(&home_project, "sibling.jsonl", "2026-07-03T19:31:00.000Z", r"C:\Users\hiyok\orb2", 100, 100);

        let got = scan_all_projects(&root, r"C:\Users\hiyok\orb", now);
        assert_eq!(got.last_hour_tokens, 30);
        assert_eq!(got.last_24h_tokens, 30);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_all_projects_windows_by_age_and_ignores_non_jsonl() {
        let root = std::env::temp_dir().join("orb-usage-local-test-scan");
        let _ = std::fs::remove_dir_all(&root);
        let pdir = root.join("C--Users-hiyok-orb");
        std::fs::create_dir_all(&pdir).unwrap();

        let now = parse_iso8601_ms("2026-07-03T20:00:00.000Z").unwrap();
        write_line(&pdir, "in_hour.jsonl", "2026-07-03T19:30:00.000Z", r"C:\Users\hiyok\orb", 10, 20); // 30分前
        write_line(&pdir, "in_24h_only.jsonl", "2026-07-03T02:00:00.000Z", r"C:\Users\hiyok\orb", 10, 20); // 18時間前
        write_line(&pdir, "too_old.jsonl", "2026-07-01T00:00:00.000Z", r"C:\Users\hiyok\orb", 999, 999); // 24h超前
        std::fs::write(pdir.join("not_jsonl.txt"), "ignored").unwrap();

        let old_time = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis((now - 25 * 3600 * 1000) as u64);
        // set_modified はメタデータ変更権限が要るため書き込みモードで開く（読み取り専用ハンドルは Windows で PermissionDenied）。
        let f = std::fs::OpenOptions::new().write(true).open(pdir.join("too_old.jsonl")).unwrap();
        f.set_modified(old_time).unwrap();

        let got = scan_all_projects(&root, r"C:\Users\hiyok\orb", now);
        assert_eq!(got.last_hour_tokens, 30); // in_hour のみ
        assert_eq!(got.last_24h_tokens, 60); // in_hour + in_24h_only（too_old は mtime でスキップ）

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn fetch_local_usage_is_all_zero_for_missing_or_empty_cwd() {
        assert_eq!(fetch_local_usage(None).last_24h_tokens, 0);
        assert_eq!(fetch_local_usage(Some("".into())).last_24h_tokens, 0);
        // 実在しないプロジェクト（テスト環境で衝突しない乱数っぽい cwd）
        let got = fetch_local_usage(Some(r"Z:\definitely\not\a\real\claude\project\dir\xyz123".into()));
        assert_eq!(got.last_24h_tokens, 0);
        assert_eq!(got.last_hour_tokens, 0);
    }
}
