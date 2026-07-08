use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;

use crate::commands::write_pty_impl;
use crate::state::AppState;

/// ポーリング間隔。`notify` crate 等のファイルシステム監視は依存が重いため使わず、
/// シンプルなポーリングループで十分（#82 受け入れ条件: 1秒程度以内に注入できればよい）。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// `%TEMP%\orb-queue\inbox\*.json` に置かれる1メッセージ分。
#[derive(Deserialize)]
struct InboxMessage {
    label: String,
    text: String,
}

fn inbox_dir() -> PathBuf {
    std::env::temp_dir().join("orb-queue").join("inbox")
}

fn failed_dir() -> PathBuf {
    std::env::temp_dir().join("orb-queue").join("failed")
}

/// 外部インボックス監視スレッドを起動する（`lib.rs` の `run()` から一度だけ呼ぶ）。
/// ディレクトリが存在しない（＝この機能を使っていない）間はポーリングが no-op を繰り返すだけで、
/// orb 自体の動作には一切影響しない。
pub fn spawn_watcher(state: AppState) {
    std::thread::spawn(move || loop {
        poll_once(&state);
        std::thread::sleep(POLL_INTERVAL);
    });
}

fn poll_once(state: &AppState) {
    let entries = match std::fs::read_dir(inbox_dir()) {
        Ok(e) => e,
        Err(_) => return, // ディレクトリ無し＝未使用時の既定状態。ここで作る必要は無い。
    };
    // ファイル名順（連番/タイムスタンプ命名を想定）に処理し、同時到着でも取りこぼさない。
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();
    for path in paths {
        process_file(state, &path);
    }
}

/// `text` の末尾の改行（`\r`/`\n`/`\r\n`）を取り除いた上で、Enter 相当のバイト（`\r`）を
/// 必ず1つ付与する純関数。xterm 側の Enter キー入力が `term.onData` を通じて `\r` として
/// PTY へ渡る経路（`Terminal.svelte`）に合わせている。
///
/// 実機検証（pwsh + PSReadLine）で確認: 末尾が `\n` のみだと Enter 扱いされず、
/// PSReadLine の複数行入力（継続プロンプト `∙`）としてバッファに残ったまま実行されない
/// （`\r\n`/`\r` は実行される）。「末尾に改行が無ければ付与する」だけでは `\n` 単体で
/// 終わるテキスト（呼び出し側が素朴に付けがちな行末）を取りこぼすため、末尾の改行は
/// 種類を問わず正規化してから `\r` を付ける。
fn with_trailing_enter(text: &str) -> Vec<u8> {
    let trimmed = text.trim_end_matches(['\r', '\n']);
    let mut bytes = trimmed.as_bytes().to_vec();
    bytes.push(b'\r');
    bytes
}

fn process_file(state: &AppState, path: &Path) {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        // 書き込み途中でロックされている等の可能性。ファイルは消さず次回ポーリングで再試行する。
        Err(_) => return,
    };
    let msg: InboxMessage = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(_) => {
            move_to_failed(path);
            return;
        }
    };
    match state.pane_for_label(&msg.label) {
        Some(pane_id) => {
            // 注入自体が失敗しても（ペインが直後に閉じた等）orb は落とさない。best-effort。
            let _ = write_pty_impl(state, pane_id, &with_trailing_enter(&msg.text));
            let _ = std::fs::remove_file(path);
        }
        None => move_to_failed(path),
    }
}

/// 該当ペインが見つからない/壊れたメッセージを、`path` と同階層の `inbox/` の隣にある
/// `failed/`（= `inbox/../failed`）へ退避する。無限リトライしない。
/// グローバルな `std::env::temp_dir()` ではなく `path` から相対的に導出する＝
/// テストで環境変数を書き換えずに済む（cargo test はデフォルトでスレッド並列実行するため、
/// プロセス全体に効く `TEMP` 上書きは他テストを巻き込みうる）。
fn move_to_failed(path: &Path) {
    let dir = match path.parent().and_then(|inbox| inbox.parent()) {
        Some(orb_queue_dir) => orb_queue_dir.join("failed"),
        None => failed_dir(), // 想定外の呼び出しへの保険。通常は上のケースで解決する。
    };
    if std::fs::create_dir_all(&dir).is_ok() {
        if let Some(name) = path.file_name() {
            if std::fs::rename(path, dir.join(name)).is_ok() {
                return;
            }
        }
    }
    // 退避先が用意できない場合でも、壊れたファイルを inbox に残してループさせない。
    let _ = std::fs::remove_file(path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn with_trailing_enter_appends_cr_when_missing() {
        assert_eq!(with_trailing_enter("hello"), b"hello\r".to_vec());
    }

    #[test]
    fn with_trailing_enter_normalizes_any_trailing_newline_to_cr() {
        // 実機検証（pwsh + PSReadLine）で `\n` 単体は Enter 扱いされないと判明したため、
        // 末尾の改行の種類によらず必ず `\r` へ正規化する。
        assert_eq!(with_trailing_enter("hello\n"), b"hello\r".to_vec());
        assert_eq!(with_trailing_enter("hello\r"), b"hello\r".to_vec());
        assert_eq!(with_trailing_enter("hello\r\n"), b"hello\r".to_vec());
    }

    #[test]
    fn with_trailing_enter_preserves_internal_newlines() {
        // 途中の改行（複数行ペースト等）はそのまま残し、末尾だけ正規化する。
        assert_eq!(with_trailing_enter("a\nb\n"), b"a\nb\r".to_vec());
    }

    #[test]
    fn process_file_moves_unknown_label_to_failed() {
        let base = std::env::temp_dir().join("orb-queue-test-unknown-label");
        let _ = std::fs::remove_dir_all(&base);
        let inbox = base.join("orb-queue").join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        let file = inbox.join("1.json");
        std::fs::write(&file, r#"{"label":"no-such-label","text":"hi"}"#).unwrap();

        let state = AppState::default();
        process_file(&state, &file);

        assert!(!file.exists());
        assert!(base.join("orb-queue").join("failed").join("1.json").exists());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn process_file_moves_malformed_json_to_failed() {
        let base = std::env::temp_dir().join("orb-queue-test-malformed");
        let _ = std::fs::remove_dir_all(&base);
        let inbox = base.join("orb-queue").join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        let file = inbox.join("1.json");
        std::fs::write(&file, "not json").unwrap();

        let state = AppState::default();
        process_file(&state, &file);

        assert!(!file.exists());
        assert!(base.join("orb-queue").join("failed").join("1.json").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
