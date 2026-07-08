use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use crate::pty::PtyHandle;

/// ペイン識別子。フロント（レイアウトツリー権威）が採番する。
pub type PaneId = u64;

/// Rust 側は「重い/危険なものだけ」を持つ激薄コア。
/// レイアウトツリーはフロントが権威で、Rust は PaneId -> PTY の対応だけ持つ。
///
/// 値は `Arc<PtyHandle>`。write_pty/resize_pty はこの Mutex を Arc を1回 clone
/// する間だけ握り、実際の（ブロッキングしうる）PTY I/O はロックの外で行う。
/// これである1ペインの write が詰まっても他ペインの PTY 操作を道連れにしない。
///
/// `ptys` 自体も `Arc` で包む（＝ `AppState` は `Clone` 可能）。tauri の `.manage()` に
/// 渡す実体と、panic hook 用に static へ登録する実体を同じ Mutex/HashMap を指す
/// clone にできるようにするため（後述 `install_panic_hook`）。
#[derive(Default, Clone)]
pub struct AppState {
    pub ptys: Arc<Mutex<HashMap<PaneId, Arc<PtyHandle>>>>,
    /// #82: 外部インボックス機能用のペインラベル（例: "worker:a"）。`ptys` とは別の
    /// Mutex にする＝ラベル検索（queue watcher の定期ポーリング）が PTY I/O のロックを
    /// 巻き込まない。
    pub pane_labels: Arc<Mutex<HashMap<PaneId, String>>>,
}

impl AppState {
    /// #82: ラベルから対応する pane_id を探す（queue watcher 用）。同じラベルが複数ペインに
    /// 付いていた場合は先勝ち（運用上ラベルは一意に付ける前提のため、通常は起こらない）。
    pub fn pane_for_label(&self, label: &str) -> Option<PaneId> {
        let labels = self.pane_labels.lock().unwrap_or_else(|p| p.into_inner());
        labels
            .iter()
            .find(|(_, v)| v.as_str() == label)
            .map(|(k, _)| *k)
    }

    /// 全 PTY をツリーごと kill する（drain はしない＝呼び出し直後にプロセスが
    /// 終了する想定の後始末なので、map から取り除く必要はない）。通常終了
    /// （`ExitRequested`）専用＝ブロッキングで確実に取得し、全 PTY を必ず kill する。
    ///
    /// panic hook からはこちらを呼ばない（下の `kill_all_ptys_best_effort` 参照）:
    /// panic したスレッド自身がこの `ptys` ロックを保持したままパニックした場合、
    /// ブロッキング `lock()` は自己デッドロックする（#69 followup で発見。以前は
    /// 両経路が同じ try_lock 版を共有しており、通常終了側の「必ず kill する」保証が
    /// 意図せず「取れなければ諦める」ベストエフォートに弱められていた）。
    pub fn kill_all_ptys(&self) {
        let handles: Vec<Arc<PtyHandle>> = {
            let ptys = self.ptys.lock().unwrap_or_else(|p| p.into_inner());
            ptys.values().cloned().collect()
        };
        for handle in handles {
            handle.kill();
        }
    }

    /// panic hook 専用のベストエフォート版。panic したスレッド自身がこの `ptys` ロックを
    /// 保持したままパニックした、というレアケースがありえる。`std::sync::Mutex` は非再入
    /// なので、同じスレッドから `lock()` で待つと即デッドロック（＝ abort が永遠に起きず
    /// 後始末どころかプロセスも死なない）になる。`try_lock` で「取れなければ諦める」
    /// ベストエフォートにすることで、その最悪ケースだけは避ける
    /// （"できれば救う"以上を保証しない＝通常終了の保証を弱めないよう `kill_all_ptys` とは
    /// 意図的に分離してある）。
    pub fn kill_all_ptys_best_effort(&self) {
        // map ロックは Arc を clone で集める間だけ保持し、ブロッキングしうる kill() は
        // ロックの外で呼ぶ（write_pty/resize_pty と同じ理由）。
        let handles: Vec<Arc<PtyHandle>> = {
            let ptys = match self.ptys.try_lock() {
                Ok(g) => g,
                Err(std::sync::TryLockError::Poisoned(p)) => p.into_inner(),
                Err(std::sync::TryLockError::WouldBlock) => return,
            };
            ptys.values().cloned().collect()
        };
        for handle in handles {
            handle.kill();
        }
    }
}

/// panic hook からこの `AppState`（＝ tauri が管理するのと同じ ptys 実体）を辿るための
/// グローバル参照。`install_panic_hook` で起動時に一度だけ設定する。
static PANIC_STATE: OnceLock<AppState> = OnceLock::new();

/// リリースビルドは `panic = "abort"`（Cargo.toml）。panic は unwind せず即 `abort()` し、
/// `Drop`（`PtyHandle::drop` → `kill_tree`/`taskkill`）も lib.rs の `ExitRequested` ハンドラも
/// 一切走らない。**panic hook 自体は unwind の有無・panic 戦略に関係なく必ず abort の前に
/// 一度呼ばれる**ため、ここに「全 PTY を kill する」後始末を仕込む。これを怠ると、シェルが
/// 起こした子孫プロセス（npm run dev / vite / cargo build / editor 等）が taskkill されずに
/// 孤児化し、orb.exe 終了後もバックグラウンドで動き続けてしまう。
///
/// **注意（この hook ではカバーできない範囲）**: allocator の OOM abort（無制限ファイル読み込み等
/// で起こりうる）は `std::alloc::handle_alloc_error` が直接 `abort()` を呼ぶ経路で、
/// `std::panic::set_hook` は経由しない＝この hook は一切呼ばれない。OOM 自体への対策は
/// このファイルではなく、原因側（blocks.rs の `MAX_DAY_FILE_BYTES` 等の読み込み上限）で
/// 行う；ここは「panic 経由の異常終了」だけをカバーするベストエフォートである。
///
/// 呼び出しは起動シーケンスで一度だけ（lib.rs の `run()` 冒頭、Tauri の `.manage()` に
/// 渡すのと同じ `AppState` の clone を渡す）。
pub fn install_panic_hook(state: AppState) {
    if PANIC_STATE.set(state).is_err() {
        return; // 二重登録は起動シーケンス上ありえないが、念のため無視（既定 hook のまま）
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(state) = PANIC_STATE.get() {
            state.kill_all_ptys_best_effort();
        }
        default_hook(info);
    }));
}
