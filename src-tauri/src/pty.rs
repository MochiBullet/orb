use std::io::{Read, Write};
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::thread::JoinHandle;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{AppError, Result};

/// taskkill をコンソール窓なしで起動するためのフラグ。
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 1 ペイン分の PTY ライフサイクルを保持する。
///
/// - reader は専用 std::thread（portable-pty の read はブロッキングなので
///   tokio ワーカーを塞がない）。
/// - 出力は Tauri Channel に **raw バイト**（`InvokeResponseBody::Raw`）で流す。
///   JSON 数値配列化を避け、フロントは ArrayBuffer→Uint8Array のまま term.write。
///   マルチバイト UTF-8 がチャンク境界で割れても xterm が継ぐ＝日本語化けを根絶。
/// - kill 時は (1) プロセスツリーごと taskkill → (2) writer/master を drop して
///   ConPTY を ClosePseudoConsole → conout を EOF にし → (3) reader を join する。
///   master を生かしたまま join すると ConPTY が EOF にならず永久ハングするため、
///   **join の前に必ず master を drop** するのが要点。
pub struct PtyHandle {
    master: Option<Box<dyn MasterPty + Send>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_pid: Option<u32>,
    reader: Option<JoinHandle<()>>,
}

impl PtyHandle {
    pub fn spawn(
        cmd: CommandBuilder,
        cols: u16,
        rows: u16,
        on_output: Channel<InvokeResponseBody>,
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
        let child_pid = child.process_id();
        // slave はもう不要（spawn 済み）。
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
                    Ok(0) => break, // EOF（ConPTY クローズ or 子プロセス終了）
                    Ok(n) => {
                        if on_output
                            .send(InvokeResponseBody::Raw(buf[..n].to_vec()))
                            .is_err()
                        {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(PtyHandle {
            master: Some(pair.master),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(child),
            child_pid,
            reader: Some(reader_handle),
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut guard = self.writer.lock().unwrap();
        match guard.as_mut() {
            Some(w) => {
                w.write_all(data)?;
                w.flush()?;
                Ok(())
            }
            None => Err(AppError::Pty("pty already closed".into())),
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        match self.master.as_ref() {
            Some(m) => m
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| AppError::Pty(e.to_string())),
            None => Err(AppError::Pty("pty already closed".into())),
        }
    }

    /// 子プロセスツリーを倒し、ConPTY を閉じ、reader を join する（冪等）。
    pub fn kill(&mut self) {
        // 1. プロセスツリーごと強制終了。pwsh が起こした子・孫(npm run dev / vim 等)も
        //    巻き込んで倒し、孤児プロセス化を防ぐ。
        if let Some(pid) = self.child_pid.take() {
            let _ = std::process::Command::new("taskkill")
                .args(["/T", "/F", "/PID", &pid.to_string()])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        // 2. stdin/stdout 端を閉じる。master(=ConPTY/HPCON) を drop すると
        //    ClosePseudoConsole が走り conout が EOF になる。これを join の前に行う。
        if let Ok(mut w) = self.writer.lock() {
            *w = None;
        }
        self.master = None;
        // 3. reader を join（master drop で read が EOF を返すので即復帰する）。
        if let Some(handle) = self.reader.take() {
            let _ = handle.join();
        }
    }
}

impl Drop for PtyHandle {
    fn drop(&mut self) {
        // close_pty を経由しない経路（アプリ終了等）でも確実に後始末する。kill は冪等。
        self.kill();
    }
}
