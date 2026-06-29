use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread::JoinHandle;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::Channel;

use crate::error::{AppError, Result};

/// 1 ペイン分の PTY ライフサイクルを保持する。
///
/// - reader は専用 std::thread（portable-pty の read はブロッキングなので
///   tokio ワーカーを塞がない。1 PTY = 1 reader OS スレッド）。
/// - 出力は JSON 経由せず raw バイトで Channel に流す（フロントは Uint8Array の
///   まま term.write。マルチバイト UTF-8 がチャンク境界で割れても xterm が継ぐ
///   ＝日本語化けを根絶する）。
pub struct PtyHandle {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    reader: Option<JoinHandle<()>>,
}

impl PtyHandle {
    /// PTY を開き、コマンド（pwsh 等）を spawn し、reader スレッドを起こす。
    pub fn spawn(
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        on_output: Channel<Vec<u8>>,
    ) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| AppError::Pty(e.to_string()))?;
        // slave はもう不要（spawn 済み）。落としておく。
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| AppError::Pty(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| AppError::Pty(e.to_string()))?;

        let reader_handle = std::thread::spawn(move || {
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF（子プロセス終了）
                    Ok(n) => {
                        // Channel が閉じられたら（フロント側破棄）ループ終了。
                        if on_output.send(buf[..n].to_vec()).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(PtyHandle {
            master: pair.master,
            writer: Mutex::new(writer),
            child: Mutex::new(child),
            reader: Some(reader_handle),
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock().unwrap();
        w.write_all(data)?;
        w.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| AppError::Pty(e.to_string()))
    }

    /// 子プロセスを kill → reader スレッドを join（リーク防止）。
    pub fn kill(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        // close_pty を経由しない経路（アプリ終了等）でも確実に後始末する。
        self.kill();
    }
}
