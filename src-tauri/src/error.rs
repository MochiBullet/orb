use serde::{Serialize, Serializer};

/// orb 全体の共通エラー。Tauri command が返せるよう Serialize（メッセージ文字列化）する。
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("pty error: {0}")]
    Pty(String),

    #[error("pane {0} not found")]
    PaneNotFound(u64),

    #[error("io error: {0}")]
    Io(#[from] std::io::Error),

    #[error("shell not found: {0}")]
    ShellNotFound(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
