use std::path::PathBuf;

use portable_pty::CommandBuilder;

use crate::error::{AppError, Result};

/// shell-integration.ps1 をバイナリに埋め込む（dev/本番でパス解決の差が出ないよう、
/// リソースバンドルではなく include_str! で持ち、起動時に temp へ展開する）。
const SHELL_INTEGRATION: &str = include_str!("../resources/shell-integration.ps1");

/// pwsh.exe（PowerShell 7+）を探す。まず PATH、次に標準インストール先。
/// （legacy powershell.exe へはフォールバックしない＝IME/UTF-8 の都合で pwsh 必須）
fn find_pwsh() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let cand = dir.join("pwsh.exe");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(key) {
            let cand = PathBuf::from(pf)
                .join("PowerShell")
                .join("7")
                .join("pwsh.exe");
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    None
}

/// 埋め込んだ shell-integration.ps1 を %TEMP%\orb\ に展開し、そのパスを返す。
fn write_integration_script() -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("orb");
    std::fs::create_dir_all(&dir)?;
    let path = dir.join("shell-integration.ps1");
    std::fs::write(&path, SHELL_INTEGRATION)?;
    Ok(path)
}

/// orb の既定シェル起動コマンドを組み立てる。
///
/// - `-NoProfile` は付けない → ユーザーの profile.ps1（starship/zoxide/fzf/eza/
///   bat/lazygit 等）を読ませる。profile が starship prompt を定義した「後」に
///   shell-integration.ps1 を dot-source することで、見た目を壊さず OSC を注入する。
/// - 起動直後に出力エンコーディングを UTF-8（BOM なし）に統一して CP932 化けを防ぐ。
pub fn build_pwsh() -> Result<CommandBuilder> {
    let pwsh = find_pwsh().ok_or_else(|| AppError::ShellNotFound("pwsh.exe".into()))?;
    let integration = write_integration_script()?;

    let mut cmd = CommandBuilder::new(pwsh);
    cmd.arg("-NoExit");
    cmd.arg("-Command");
    cmd.arg(format!(
        "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); . '{}'",
        integration.display()
    ));
    cmd.env("TERM", "xterm-256color");

    if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.cwd(home);
    }

    Ok(cmd)
}
