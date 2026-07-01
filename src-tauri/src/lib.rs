mod commands;
mod config;
mod error;
mod pty;
mod shell;
mod state;
mod status;
mod usage;

use state::AppState;
use tauri::Manager;

/// orb 自身が過去に Claude Code セッションから起動された等で抱え込んだ Claude Code の
/// 「子セッション」マーカーを、シェルを spawn する前に自分のプロセス環境から除去する。
///
/// `CLAUDECODE=1` / `CLAUDE_CODE_CHILD_SESSION=1` 等が orb の環境に残っていると、orb 内で
/// 起動した claude が「親 claude のサブプロセス」扱い（CHILD_SESSION）になり、会話 transcript を
/// `~/.claude/projects/` に保存しない。結果 `claude --continue` が最後に“まともに”保存された
/// 過去セッションへ戻ってしまう。orb は最上位ターミナルなので、ここで一度きれいにしておく。
///
/// `CLAUDE_CODE_*` は Claude Code 内部のセッション印のみ。`CLAUDE_CONFIG_DIR` 等
/// （`CLAUDE_CODE_` 接頭辞ではない）や `ANTHROPIC_*` は対象外なので巻き込まない。
/// 除去はスレッド spawn 前（run の先頭）で行うため安全。
fn sanitize_inherited_env() {
    let leaked: Vec<std::ffi::OsString> = std::env::vars_os()
        .map(|(k, _)| k)
        .filter(|k| {
            k.to_str()
                .is_some_and(|s| s == "CLAUDECODE" || s.starts_with("CLAUDE_CODE_"))
        })
        .collect();
    for key in leaked {
        std::env::remove_var(key);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 子プロセス（pwsh → claude → statusline）を spawn する前に環境を浄化する。
    sanitize_inherited_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::default())
        .setup(|_app| {
            // 初回のみ設定ファイルを seed（読み取りコマンドから書き込み副作用を分離）。
            config::seed_defaults();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::spawn_pty,
            commands::write_pty,
            commands::resize_pty,
            commands::close_pty,
            commands::close_all_ptys,
            commands::list_projects,
            commands::get_config,
            commands::save_config,
            commands::get_usage,
            commands::get_claude_status,
            commands::get_mcp_health,
            commands::get_git_branch,
            commands::open_in_editor,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // アプリ終了時に全 PTY をツリーごと kill して子 pwsh の孤児化を防ぐ
            // （process::exit で Drop が走らない経路の保険）。
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app_handle.state::<AppState>();
                let mut ptys = state.ptys.lock().unwrap();
                for (_, mut handle) in ptys.drain() {
                    handle.kill();
                }
            }
        });
}
