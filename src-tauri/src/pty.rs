use std::io::{Read, Write};
use std::sync::Mutex;
use std::thread::JoinHandle;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, InvokeResponseBody};

use crate::error::{AppError, Result};

/// 子プロセスツリーを倒す。Windows は `taskkill /T /F` でツリーごと、Unix は PTY
/// セッションリーダー（`portable-pty` が spawn 時に setsid する想定＝子の pgid が
/// 自分自身の pid と一致する）のプロセスグループへ `kill -9 -<pid>`（負の PID＝グループ
/// 全体が対象）を送ることで、シェルが起こした孫プロセス（npm run dev / vim 等）も
/// 巻き込んで倒す。**Unix 版は実機未検証**（#17 クロスプラットフォーム対応の一環。
/// setsid の前提が崩れていた場合は直下の子だけが倒れ孫が孤児化しうる＝実機 CI で要確認）。
#[cfg(windows)]
fn kill_tree(pid: u32) {
    let _ = crate::procutil::new_command("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .output();
}

#[cfg(unix)]
fn kill_tree(pid: u32) {
    let _ = crate::procutil::new_command("kill")
        .args(["-9", &format!("-{pid}")])
        .output();
}

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
///
/// 全フィールドが自前で `Mutex` を持つ＝`write`/`resize`/`kill` は全て `&self` で
/// 呼べる。これにより呼び出し側（commands.rs）は `Arc<PtyHandle>` として他ペインとは
/// 独立にロックでき、あるペインの PTY 操作（ブロッキング write 等）が他ペインの
/// 操作を待たせない。
pub struct PtyHandle {
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    child_pid: Mutex<Option<u32>>,
    reader: Mutex<Option<JoinHandle<()>>>,
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
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
            child: Mutex::new(child),
            child_pid: Mutex::new(child_pid),
            reader: Mutex::new(Some(reader_handle)),
        })
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        // poisoning は kill() 等と同じ方針で復旧する（このロックが一度でも poison すると、
        // 素の unwrap() では以後の毎キー入力が abort する致命的な経路になり得るため）。
        let mut guard = self.writer.lock().unwrap_or_else(|p| p.into_inner());
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
        // poisoning は write() と同じ方針で復旧する（理由は write() のコメント参照）。
        let guard = self.master.lock().unwrap_or_else(|p| p.into_inner());
        match guard.as_ref() {
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

    /// 子プロセスツリーを倒し、ConPTY を閉じ、reader を join する（冪等・`&self` で呼べる）。
    ///
    /// 各ロックは値を取り出す/操作するその場だけで手放す。`if let Some(x) = mutex.lock()...`
    /// の形は scrutinee の一時値（MutexGuard）がブロック終端まで生き、kill_tree/join という
    /// 重い呼び出しの間ロックを握ったままになる＝ `Arc<PtyHandle>` 経由で複数箇所（他ペインの
    /// write_pty/resize_pty や kill_all_ptys）から並行に触れるようにした今回のリファクタの
    /// 意味が失われる（#69 followup で発見）。poisoning は checkpoint.rs 等と同じ方針
    /// （`unwrap_or_else(|p| p.into_inner())` で復旧）に揃える。
    pub fn kill(&self) {
        // 1. プロセスツリーごと強制終了。pwsh が起こした子・孫(npm run dev / vim 等)も
        //    巻き込んで倒し、孤児プロセス化を防ぐ。
        let pid = self.child_pid.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(pid) = pid {
            kill_tree(pid);
        }
        {
            let mut child = self.child.lock().unwrap_or_else(|p| p.into_inner());
            let _ = child.kill();
        }
        // 2. stdin/stdout 端を閉じる。master(=ConPTY/HPCON) を drop すると
        //    ClosePseudoConsole が走り conout が EOF になる。これを join の前に行う。
        {
            let mut w = self.writer.lock().unwrap_or_else(|p| p.into_inner());
            *w = None;
        }
        {
            let mut m = self.master.lock().unwrap_or_else(|p| p.into_inner());
            *m = None;
        }
        // 3. reader を join（master drop で read が EOF を返すので即復帰する）。
        let reader = self.reader.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(handle) = reader {
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
