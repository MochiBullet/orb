use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::State;

use crate::config::{self, Config, Project};
use crate::error::{AppError, Result};
use crate::pty::PtyHandle;
use crate::shell;
use crate::state::{AppState, PaneId};

/// projects.toml の案件一覧（案件ランチャー用）。
#[tauri::command]
pub fn list_projects() -> Vec<Project> {
    config::load_projects()
}

/// config.toml（font/scrollback 等）。
#[tauri::command]
pub fn get_config() -> Config {
    config::load_config()
}

/// 設定GUI からの保存。
#[tauri::command]
pub fn save_config(config: Config) -> Result<()> {
    crate::config::save_config(&config)
}

/// Claude のトークン使用率（サイドバー用、ブロッキング HTTP は別スレッドで実行される）。
#[tauri::command]
pub fn get_usage() -> Result<crate::usage::Usage> {
    crate::usage::fetch_usage()
}

/// Claude Code の設定由来ステータス（モデル/エフォート/MCP）。
#[tauri::command]
pub fn get_claude_status(cwd: Option<String>) -> crate::status::ClaudeStatus {
    crate::status::fetch_status(cwd)
}

/// pwsh を spawn し、出力 Channel を結線する。`on_output` はフロントが生成した
/// バイナリ Channel（raw バイトが流れる）。
#[tauri::command]
pub fn spawn_pty(
    state: State<'_, AppState>,
    pane_id: PaneId,
    cols: u16,
    rows: u16,
    on_output: Channel<InvokeResponseBody>,
    initial_cmd: Option<String>,
) -> Result<()> {
    let cmd = shell::build_pwsh(initial_cmd.as_deref())?;
    let handle = PtyHandle::spawn(cmd, cols, rows, on_output)?;
    // ロックは map 更新の間だけ保持し、置き換えられた旧ハンドルの kill(=taskkill/join)
    // はロックの外で行う（ロックを握ったまま join するのを避ける）。
    let previous = {
        let mut ptys = state.ptys.lock().unwrap();
        ptys.insert(pane_id, handle)
    };
    if let Some(mut prev) = previous {
        prev.kill();
    }
    Ok(())
}

#[tauri::command]
pub fn write_pty(state: State<'_, AppState>, pane_id: PaneId, data: Vec<u8>) -> Result<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pane_id).ok_or(AppError::PaneNotFound(pane_id))?;
    handle.write(&data)
}

#[tauri::command]
pub fn resize_pty(state: State<'_, AppState>, pane_id: PaneId, cols: u16, rows: u16) -> Result<()> {
    let ptys = state.ptys.lock().unwrap();
    let handle = ptys.get(&pane_id).ok_or(AppError::PaneNotFound(pane_id))?;
    handle.resize(cols, rows)
}

#[tauri::command]
pub fn close_pty(state: State<'_, AppState>, pane_id: PaneId) -> Result<()> {
    // ロックは remove の間だけ。kill(taskkill/join) はロックの外で。
    let removed = state.ptys.lock().unwrap().remove(&pane_id);
    if let Some(mut handle) = removed {
        handle.kill();
    }
    Ok(())
}

/// フロントの起動/リロード時に呼ぶ。旧ペインの PTY を全破棄して孤児
/// reader スレッド・pwsh を防ぐ（HMR/WebView リロードは Channel を再bind できないため
/// 全 drop が正しい）。kill はロックの外で。
#[tauri::command]
pub fn close_all_ptys(state: State<'_, AppState>) {
    let drained: Vec<_> = state.ptys.lock().unwrap().drain().collect();
    for (_, mut handle) in drained {
        handle.kill();
    }
}
