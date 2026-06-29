use std::collections::HashMap;
use std::sync::Mutex;

use crate::pty::PtyHandle;

/// ペイン識別子。フロント（レイアウトツリー権威）が採番する。
pub type PaneId = u64;

/// Rust 側は「重い/危険なものだけ」を持つ激薄コア。
/// レイアウトツリーはフロントが権威で、Rust は PaneId -> PTY の対応だけ持つ。
#[derive(Default)]
pub struct AppState {
    pub ptys: Mutex<HashMap<PaneId, PtyHandle>>,
}
