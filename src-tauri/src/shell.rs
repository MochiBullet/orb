use std::path::PathBuf;
use std::sync::OnceLock;

use portable_pty::CommandBuilder;

use crate::error::Result;

/// orb の既定シェル起動コマンドを組み立てる（OS ごとにディスパッチ）。
/// Windows は pwsh、Unix（Linux/macOS）は bash（#17 クロスプラットフォーム対応、v1 は
/// bash のみ——shell-integration.sh が bash 専用構文に依るため zsh/fish は今後別途）。
pub fn build_shell(initial_cmd: Option<&str>, nonce: Option<&str>) -> Result<CommandBuilder> {
    #[cfg(windows)]
    {
        build_pwsh(initial_cmd, nonce)
    }
    #[cfg(unix)]
    {
        build_bash(initial_cmd, nonce)
    }
}

/// CLAUDECODE 系の子セッション印を除去する（多重防御。run() 冒頭の
/// sanitize_inherited_env が将来のリファクタで消えても、ここで必ず止める）。
/// portable-pty の env_remove は base env（std::env から継承した分）のエントリも
/// 確実に削除する。
fn strip_claude_code_env(cmd: &mut CommandBuilder) {
    for key in std::env::vars_os().map(|(k, _)| k).filter(|k| {
        k.to_str()
            .is_some_and(|s| s == "CLAUDECODE" || s.starts_with("CLAUDE_CODE_"))
    }) {
        cmd.env_remove(key);
    }
}

// ============================== Windows (pwsh) ==============================

/// shell-integration.ps1 をバイナリに埋め込む（dev/本番でパス解決の差が出ないよう、
/// リソースバンドルではなく include_str! で持ち、起動時に temp へ展開する）。
#[cfg(windows)]
const SHELL_INTEGRATION_PS1: &str = include_str!("../resources/shell-integration.ps1");

/// pwsh.exe（PowerShell 7+）を探す。まず PATH、次に標準インストール先。
/// （legacy powershell.exe へはフォールバックしない＝IME/UTF-8 の都合で pwsh 必須）
#[cfg(windows)]
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
#[cfg(windows)]
fn write_integration_script_ps1() -> Result<PathBuf> {
    static INTEGRATION_PATH: OnceLock<PathBuf> = OnceLock::new();
    let path = INTEGRATION_PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("orb");
        let path = dir.join("shell-integration.ps1");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, SHELL_INTEGRATION_PS1);
        path
    });
    Ok(path.clone())
}

/// orb の既定シェル起動コマンドを組み立てる（Windows / pwsh）。
///
/// - `-NoProfile` は付けない → ユーザーの profile.ps1（starship/zoxide/fzf/eza/
///   bat/lazygit 等）を読ませる。profile が starship prompt を定義した「後」に
///   shell-integration.ps1 を dot-source することで、見た目を壊さず OSC を注入する。
/// - 起動直後に出力エンコーディングを UTF-8（BOM なし）に統一して CP932 化けを防ぐ。
#[cfg(windows)]
fn build_pwsh(initial_cmd: Option<&str>, nonce: Option<&str>) -> Result<CommandBuilder> {
    let pwsh =
        find_pwsh().ok_or_else(|| crate::error::AppError::ShellNotFound("pwsh.exe".into()))?;
    let integration = write_integration_script_ps1()?;

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
    // #33: OSC 633;E（コマンドライン）の偽造防止 nonce。shell-integration.ps1 が
    // E マーカーに埋め、フロント（osc.ts）が照合する。無ければ E は emit されない。
    if let Some(n) = nonce {
        if !n.is_empty() {
            cmd.env("ORB_NONCE", n);
        }
    }

    strip_claude_code_env(&mut cmd);

    let home = crate::status::home_dir();
    if !home.as_os_str().is_empty() {
        cmd.cwd(home);
    }

    Ok(cmd)
}

// ================================ Unix (bash) ================================

/// shell-integration.sh をバイナリに埋め込む（PS1 版と同じ理由で include_str! + temp 展開）。
#[cfg(unix)]
const SHELL_INTEGRATION_SH: &str = include_str!("../resources/shell-integration.sh");

/// 埋め込んだ shell-integration.sh を $TMPDIR/orb/（既定 /tmp/orb/）に展開し、パスを返す。
/// PS1 版と同じく OnceLock で複数ペイン同時起動時の書き込みレースを排除する。
#[cfg(unix)]
fn write_integration_script_sh() -> Result<PathBuf> {
    static INTEGRATION_PATH: OnceLock<PathBuf> = OnceLock::new();
    let path = INTEGRATION_PATH.get_or_init(|| {
        let dir = std::env::temp_dir().join("orb");
        let path = dir.join("shell-integration.sh");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, SHELL_INTEGRATION_SH);
        path
    });
    Ok(path.clone())
}

/// `bash --rcfile` 用の一時 rcfile を書く。bash の `--rcfile FILE` は対話シェルの通常の
/// `~/.bashrc` 読み込みを FILE で完全に置き換えるため、この rcfile 自身の先頭で
/// `~/.bashrc` を明示的に source する（PS1 版の「-NoProfile を付けない」と同じ意図＝
/// ユーザーの profile（starship/zoxide 等）を先に読ませ、その後に orb integration を注入）。
/// nonce をファイル名に含めて複数ペイン同時起動時の書き込み衝突を避ける（初期コマンドは
/// ペインごとに異なるため、PS1 版の integration スクリプト自体と違い OnceLock で共有できない）。
#[cfg(unix)]
fn write_rcfile(integration: &std::path::Path, initial_cmd: Option<&str>, nonce: Option<&str>) -> Result<PathBuf> {
    let dir = std::env::temp_dir().join("orb");
    let _ = std::fs::create_dir_all(&dir);
    let suffix = nonce.filter(|n| !n.is_empty()).unwrap_or("default");
    let path = dir.join(format!("rcfile-{suffix}.sh"));

    let integration_arg = integration.display().to_string().replace('\'', "'\\''");
    let mut script = format!(
        "if [ -r ~/.bashrc ]; then . ~/.bashrc; fi\n. '{integration_arg}'\n"
    );
    if let Some(c) = initial_cmd {
        if !c.is_empty() {
            script.push_str(c);
            script.push('\n');
        }
    }
    let _ = std::fs::write(&path, script);
    Ok(path)
}

/// orb の既定シェル起動コマンドを組み立てる（Unix / bash）。
/// `--rcfile` + `-i` で対話シェルとして起動し、rcfile 側で `~/.bashrc` → orb integration
/// → 初期コマンド、の順に読ませる（PS1 版の「profile → integration → 初期コマンド」と
/// 同じ順序）。
#[cfg(unix)]
fn build_bash(initial_cmd: Option<&str>, nonce: Option<&str>) -> Result<CommandBuilder> {
    let integration = write_integration_script_sh()?;
    let rcfile = write_rcfile(&integration, initial_cmd, nonce)?;

    let mut cmd = CommandBuilder::new("bash");
    cmd.arg("--rcfile");
    cmd.arg(rcfile);
    cmd.arg("-i");
    cmd.env("TERM", "xterm-256color");
    // 24bit truecolor を有効化。xterm.js(WebGL) は truecolor を描画できるが、
    // bat/eza/starship/vim 等は COLORTERM を見て truecolor を出すか決めるため明示する。
    cmd.env("COLORTERM", "truecolor");
    // orb 内で動いている目印（PS1 版と同じ）。
    cmd.env("ORB", "1");
    // #33 相当: OSC 633;E（コマンドライン）の偽造防止 nonce。shell-integration.sh が
    // E マーカーに埋め、フロント（osc.ts）が照合する。無ければ E は emit されない。
    if let Some(n) = nonce {
        if !n.is_empty() {
            cmd.env("ORB_NONCE", n);
        }
    }

    strip_claude_code_env(&mut cmd);

    let home = crate::status::home_dir();
    if !home.as_os_str().is_empty() {
        cmd.cwd(home);
    }

    Ok(cmd)
}
