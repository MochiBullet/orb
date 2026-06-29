use std::path::PathBuf;

use portable_pty::CommandBuilder;

use crate::error::{AppError, Result};

/// PATH から pwsh.exe（PowerShell 7+）を探す。
fn find_pwsh() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join("pwsh.exe");
        if cand.is_file() {
            return Some(cand);
        }
    }
    None
}

/// orb の既定シェル起動コマンドを組み立てる。
///
/// - `-NoProfile` は付けない → ユーザーの profile.ps1（starship/zoxide/fzf/eza/
///   bat/lazygit 等）を読ませる。
/// - 起動直後に出力エンコーディングを UTF-8（BOM なし）に統一して CP932 化けを防ぐ。
/// - shell-integration.ps1（OSC133/633 注入）は P1 で追加する。
pub fn build_pwsh() -> Result<CommandBuilder> {
    let pwsh = find_pwsh().ok_or_else(|| AppError::ShellNotFound("pwsh.exe".into()))?;

    let mut cmd = CommandBuilder::new(pwsh);
    cmd.arg("-NoExit");
    cmd.arg("-Command");
    cmd.arg("$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new()");
    cmd.env("TERM", "xterm-256color");

    if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.cwd(home);
    }

    Ok(cmd)
}
