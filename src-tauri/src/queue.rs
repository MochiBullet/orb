use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::commands::write_pty_impl;
use crate::state::AppState;

/// ポーリング間隔。`notify` crate 等のファイルシステム監視は依存が重いため使わず、
/// シンプルなポーリングループで十分（#82 受け入れ条件: 1秒程度以内に注入できればよい）。
const POLL_INTERVAL: Duration = Duration::from_millis(500);

/// フロント（`src/layout/external-launch.ts`）が listen するイベント名。両者で一致させること。
const LAUNCH_EVENT: &str = "orb://launch-request";

/// `%TEMP%\orb-queue\inbox\*.json` に置かれる1メッセージ分。2形（untagged）:
/// - 既存ペインへのテキスト注入（#82）: `{"label":"...","text":"..."}`
/// - 複数案件を1画面レイアウトで新規起動する要求（#82 followup）: `{"launch":["slug1","slug2"]}`
///   ペイン新規起動はレイアウトツリーを持つフロント側の責務のため、Rust はイベントを emit
///   するだけで、実際の起動処理（`launchAiRow`）はフロントが担う。
#[derive(Deserialize)]
#[serde(untagged)]
enum InboxMessage {
    Inject { label: String, text: String },
    Launch { launch: Vec<String> },
}

fn inbox_dir() -> PathBuf {
    std::env::temp_dir().join("orb-queue").join("inbox")
}

fn failed_dir() -> PathBuf {
    std::env::temp_dir().join("orb-queue").join("failed")
}

/// 外部インボックス監視スレッドを起動する（`lib.rs` の `run()` から一度だけ呼ぶ）。
/// ディレクトリが存在しない（＝この機能を使っていない）間はポーリングが no-op を繰り返すだけで、
/// orb 自体の動作には一切影響しない。`app` は `Launch` メッセージをフロントへ emit するために持つ。
/// `R: Runtime` はテストで `tauri::test::MockRuntime` を差し込めるようにするための総称化。
pub fn spawn_watcher<R: Runtime>(app: AppHandle<R>, state: AppState) {
    std::thread::spawn(move || loop {
        poll_once(&app, &state);
        std::thread::sleep(POLL_INTERVAL);
    });
}

fn poll_once<R: Runtime>(app: &AppHandle<R>, state: &AppState) {
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
        process_file(app, state, &path);
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

fn process_file<R: Runtime>(app: &AppHandle<R>, state: &AppState, path: &Path) {
    let raw = match std::fs::read_to_string(path) {
        Ok(s) => s,
        // 書き込み途中でロックされている等の可能性。ファイルは消さず次回ポーリングで再試行する。
        Err(_) => return,
    };
    let msg: InboxMessage = match parse_message(&raw) {
        Ok(m) => m,
        Err(_) => {
            move_to_failed(path);
            return;
        }
    };
    match msg {
        // AppHandle を必要としない部分は `inject` へ抽出（ユニットテストで AppHandle
        // 無しに検証できるようにするため——実アプリの `AppHandle` は本物の Tauri app が
        // 起動していないと得られず、この crate では headless に用意する手段が無い）。
        InboxMessage::Inject { label, text } => inject(state, &label, &text, path),
        InboxMessage::Launch { launch } => {
            // 実際の起動処理（レイアウトツリー構築・PTY spawn）はフロントの責務。ここは
            // emit するだけで best-effort（ウィンドウ未初期化等での失敗でも orb は落とさない）。
            let _ = app.emit(LAUNCH_EVENT, serde_json::json!({ "slugs": launch }));
            let _ = std::fs::remove_file(path);
        }
    }
}

/// JSON テキストを `InboxMessage` へパースする薄いラッパー。AppHandle/ファイルI/O 抜きの
/// 純粋な形でテストできるよう `process_file` から切り出した。
fn parse_message(raw: &str) -> Result<InboxMessage, serde_json::Error> {
    serde_json::from_str(raw)
}

fn inject(state: &AppState, label: &str, text: &str, path: &Path) {
    match state.pane_for_label(label) {
        Some(pane_id) => {
            // 注入自体が失敗しても（ペインが直後に閉じた等）orb は落とさない。best-effort。
            let _ = write_pty_impl(state, pane_id, &with_trailing_enter(text));
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

    // `process_file` 自体は `AppHandle<R>` を要求する（Launch メッセージの emit に使うため）。
    // この crate には実 Tauri app 無しに `AppHandle` を用意する手段が無い（`tauri::test` の
    // `mock_app()` はこの環境ではテストバイナリ自体がロードできなくなる既知の相性問題があり
    // 不採用——本質的でない env DLL の話であり、コード側の欠陥ではない）。そのため
    // AppHandle を必要としない部分（`parse_message`/`inject`/`move_to_failed`）を直接テストし、
    // Launch 分岐（`app.emit` を呼ぶだけの1行）は実機（orb 起動＋実際の label 付きペイン）で
    // 検証する方針にする。

    #[test]
    fn parse_message_recognizes_inject_and_launch_shapes() {
        match parse_message(r#"{"label":"worker:a","text":"hi"}"#).unwrap() {
            InboxMessage::Inject { label, text } => {
                assert_eq!(label, "worker:a");
                assert_eq!(text, "hi");
            }
            InboxMessage::Launch { .. } => panic!("expected Inject"),
        }
        match parse_message(r#"{"launch":["project-a","project-b"]}"#).unwrap() {
            InboxMessage::Launch { launch } => assert_eq!(launch, vec!["project-a", "project-b"]),
            InboxMessage::Inject { .. } => panic!("expected Launch"),
        }
    }

    #[test]
    fn parse_message_rejects_malformed_json() {
        assert!(parse_message("not json").is_err());
    }

    #[test]
    fn inject_moves_unknown_label_to_failed() {
        let base = std::env::temp_dir().join("orb-queue-test-unknown-label");
        let _ = std::fs::remove_dir_all(&base);
        let inbox = base.join("orb-queue").join("inbox");
        std::fs::create_dir_all(&inbox).unwrap();
        let file = inbox.join("1.json");
        std::fs::write(&file, "irrelevant").unwrap();

        let state = AppState::default();
        inject(&state, "no-such-label", "hi", &file);

        assert!(!file.exists());
        assert!(base.join("orb-queue").join("failed").join("1.json").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
