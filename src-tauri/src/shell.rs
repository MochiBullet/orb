use std::path::PathBuf;
use std::sync::OnceLock;

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
///
/// 複数ペインを同時に起動しても temp への書き込みは一度だけ（OnceLock::get_or_init
/// が最初の1回しかクロージャを走らせない＝同一ファイルへの同時書き込みレースを排除）。
/// 書き込み失敗時もパスは返す（dot-source が失敗しても OSC が出ないだけで端末は動く）。
fn write_integration_script() -> Result<PathBuf> {
    static INTEGRATION_PATH: OnceLock<PathBuf> = OnceLock::new();
    let path = INTEGRATION_PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("orb");
        let path = dir.join("shell-integration.ps1");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, SHELL_INTEGRATION);
        path
    });
    Ok(path.clone())
}

/// orb の既定シェル起動コマンドを組み立てる。
///
/// - `-NoProfile` は付けない → ユーザーの profile.ps1（starship/zoxide/fzf/eza/
///   bat/lazygit 等）を読ませる。profile が starship prompt を定義した「後」に
///   shell-integration.ps1 を dot-source することで、見た目を壊さず OSC を注入する。
/// - 起動直後に出力エンコーディングを UTF-8（BOM なし）に統一して CP932 化けを防ぐ。
pub fn build_pwsh(initial_cmd: Option<&str>) -> Result<CommandBuilder> {
    let pwsh = find_pwsh().ok_or_else(|| AppError::ShellNotFound("pwsh.exe".into()))?;
    let integration = write_integration_script()?;

    // profile → integration の後に、案件ランチャー由来の初期コマンド（claude --continue
    // / npm run dev / lg 等）を続ける。-NoExit なので実行後も対話シェルが残る。
    // パスのシングルクオートを '' へエスケープ（temp パスに ' が含まれても壊れないよう）。
    let integration_arg = integration.display().to_string().replace('\'', "''");
    let mut script = format!(
        "$OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); . '{}'",
        integration_arg
    );
    if let Some(c) = initial_cmd {
        if !c.is_empty() {
            script.push_str("; ");
            script.push_str(c);
        }
    }

    let mut cmd = CommandBuilder::new(pwsh);
    cmd.arg("-NoExit");
    cmd.arg("-Command");
    cmd.arg(script);
    cmd.env("TERM", "xterm-256color");
    // 24bit truecolor を有効化。xterm.js(WebGL) は truecolor を描画できるが、
    // bat/eza/starship/vim 等は COLORTERM を見て truecolor を出すか決めるため明示する。
    cmd.env("COLORTERM", "truecolor");
    // orb 内で動いている目印。子プロセス（pwsh→claude→statusline.ps1）が継承し、
    // Claude Code のステータスラインがサイドバーと重複する情報を省略できる。
    cmd.env("ORB", "1");

    if let Some(home) = std::env::var_os("USERPROFILE") {
        cmd.cwd(home);
    }

    Ok(cmd)
}
