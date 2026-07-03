//! クロスプラットフォームなプロセス起動ヘルパー。#17 のクロスプラットフォーム対応で、
//! `pty.rs`・`status.rs`・`commands.rs`・`checkpoint.rs` に散っていた「Windows専用の
//! コンソール窓抑制（`CREATE_NO_WINDOW`）」を一箇所に集約する。それ以外の4ファイルは
//! `std::os::windows::process::CommandExt` を直接 import していたため、その import
//! 自体が非Windowsではコンパイルすら通らなかった＝この一元化がクロスプラットフォーム
//! 化の前提条件だった。

use std::process::Command;

/// `program` を子プロセスとして構築する。Windows ではコンソール窓を出さない
/// （`CREATE_NO_WINDOW`、GUI アプリから CLI ツールを呼ぶ時に黒窓が一瞬出るのを防ぐ）。
/// Unix にはこの概念自体が無い（GUI プロセスから spawn した子は元々ターミナルを持たない）
/// ため素通し。
// `mut` は Windows 分岐（creation_flags）でのみ必要。Unix ではその分岐が丸ごと消えるため
// 未使用 mut 警告が出るが、両OSで同じ関数シグネチャを保つためあえて許容する。
#[allow(unused_mut)]
pub(crate) fn new_command(program: &str) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}
