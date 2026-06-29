use tauri::ipc::Channel;
use tauri::State;

use crate::error::{AppError, Result};
use crate::pty::PtyHandle;
use crate::shell;
use crate::state::{AppState, PaneId};

/// pwsh を spawn し、出力 Channel を結線する。`on_output` はフロントが生成した
/// `Channel`（生バイトが流れる）。
#[tauri::command]
pub fn spawn_pty(
    state: State<'_, AppState>,
    pane_id: PaneId,
    cols: u16,
    rows: u16,
    on_output: Channel<Vec<u8>>,
) -> Result<()> {
    let cmd = shell::build_pwsh()?;
    let handle = PtyHandle::spawn(cmd, cols, rows, on_output)?;
    state.ptys.lock().unwrap().insert(pane_id, handle);
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
    if let Some(mut handle) = state.ptys.lock().unwrap().remove(&pane_id) {
        handle.kill();
    }
    Ok(())
}
