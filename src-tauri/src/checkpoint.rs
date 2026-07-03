//! #54: ターン毎チェックポイント（`git stash create` による非破壊スナップショット）＋
//! 明示確認を挟んだロールバック。
//!
//! - **捕捉**: AI ペインへの入力送信（ターン開始）を合図に `git stash create` を叩く。
//!   このコマンドは stash リストにも作業ツリー/インデックスにも触れず、「今の index+worktree
//!   の状態」を表す commit オブジェクトを作って hash を返すだけ＝完全に非破壊。捕捉タイミング
//!   が「AI が動き出す直前」なので、そのまま「直前のターンに巻き戻す」の基準点になる。
//! - 直前チェックポイントと tree が同一（＝実質変化なし）なら記録しない。連打・無変更の
//!   ターンで保持枠を無駄に消費しない。
//! - **ロールバック**は `git reset --hard <checkpoint>` のみ＝この関数だけが破壊的操作。
//!   呼ばれたら問答無用で実行する単純な形にし、diff プレビュー＋確認は UI 層の責務とする
//!   （BlockHistory 等の再実行系と同じ「実行するのは明示操作」契約）。
//! - git 未導入・非リポジトリ・コミット無しリポ（unborn HEAD）は静かに無効（false/空を返すだけ）。
//! - 状態はプロセスメモリのみ（永続化しない）。再起動を跨いだ巻き戻しは対象外＝シンプルさ優先。

use std::collections::HashMap;
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::Command;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// リポジトリごとに保持するチェックポイントの上限。古いものから捨てる。
const MAX_CHECKPOINTS: usize = 20;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Checkpoint {
    pub hash: String,
    /// 捕捉時刻（epoch ms）。一覧表示用。
    pub created_at: i64,
    /// dedupe 専用（直前チェックポイントとの tree 比較）。フロントへは送らない。
    #[serde(skip)]
    tree: String,
    /// 捕捉時点で untracked だったファイル（相対パス、`git ls-files --others --exclude-standard`）。
    /// `git stash create` は untracked を一切拾えない（`git add -N` を挟んでも
    /// "Entry not uptodate. Cannot merge." で失敗することを実機で確認済み）ため、
    /// 内容までは追跡しない既知の割り切り。代わりにロールバック時、この集合に**無い**のに
    /// 「今は untracked」なファイル＝このチェックポイント以降に新規作成されたファイルとして
    /// 削除し、「新規ファイル作成」を伴うターンの巻き戻しでもゴミを残さないようにする。
    #[serde(skip)]
    untracked: Vec<String>,
}

/// 捕捉時点で untracked（かつ .gitignore 対象外）のファイル一覧を相対パスで返す。
fn list_untracked(root: &str) -> Vec<String> {
    run_git(root, &["ls-files", "--others", "--exclude-standard"])
        .map(|s| s.lines().map(str::to_string).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

fn checkpoints_state() -> &'static Mutex<HashMap<String, Vec<Checkpoint>>> {
    static STATE: OnceLock<Mutex<HashMap<String, Vec<Checkpoint>>>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn run_git(repo_root: &str, args: &[&str]) -> Result<String> {
    let out = Command::new("git")
        .args(args)
        .current_dir(repo_root)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| AppError::Config(format!("git spawn failed: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Config(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// cwd から git リポジトリのルートを解決する。git 未導入・非リポジトリは None（静かに無効）。
fn repo_root(cwd: &str) -> Option<String> {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let root = String::from_utf8_lossy(&out.stdout).trim().replace('/', "\\");
    if root.is_empty() {
        None
    } else {
        Some(root)
    }
}

/// リポジトリキー（大小文字を無視した正規化パス）。Windows パスの比較用。
fn repo_key(root: &str) -> String {
    root.to_lowercase()
}

/// 7〜64桁の16進のみ許可（下限は git の省略 hash の実用的な最小長に合わせた defense-in-depth。
/// 呼び出し元は常にフルhashを渡す設計だが、reset --hard の直前に立つ唯一の安全弁なので
/// 短すぎる/フラグ様文字列（`--upload-pack=...` 等）を早期に弾く）。
fn is_valid_hash(h: &str) -> bool {
    (7..=64).contains(&h.len()) && h.chars().all(|c| c.is_ascii_hexdigit())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// tree hash 取得（dedupe とターゲット確認の両方で使う）。
fn rev_parse_tree(root: &str, hash: &str) -> Result<String> {
    run_git(root, &["rev-parse", &format!("{hash}^{{tree}}")])
}

/// #54: AI ペインのターン開始時に呼ぶ。変化が無ければ何もしない（tree hash 一致で dedupe）。
/// 戻り値は捕捉できたか（テスト用・呼び出し側は結果を待たない fire-and-forget）。
pub fn capture(cwd: &str) -> bool {
    let Some(root) = repo_root(cwd) else { return false };
    // stash create は index+worktree の差分がゼロなら空文字を返す（非破壊・no-op）。
    let Ok(hash) = run_git(&root, &["stash", "create"]) else { return false };
    if hash.is_empty() {
        return false;
    }
    let Ok(tree) = rev_parse_tree(&root, &hash) else { return false };
    let untracked = list_untracked(&root);

    let key = repo_key(&root);
    let mut state = checkpoints_state().lock().unwrap_or_else(|p| p.into_inner());
    let list = state.entry(key).or_default();
    if let Some(last) = list.first() {
        // tracked 側の tree だけでなく untracked の集合も見る＝「新規ファイルを作っただけ」の
        // ターン（tree は不変）も別のチェックポイントとして記録できるようにする。
        if last.tree == tree && last.untracked == untracked {
            return false; // 直前と同じ内容＝実質変化なし
        }
    }
    list.insert(0, Checkpoint { hash, created_at: now_ms(), tree, untracked });
    list.truncate(MAX_CHECKPOINTS);
    true
}

/// 指定チェックポイントが記録している untracked スナップショットを取り出す（restore 専用）。
fn checkpoint_untracked(root: &str, hash: &str) -> Vec<String> {
    checkpoints_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&repo_key(root))
        .and_then(|list| list.iter().find(|c| c.hash == hash))
        .map(|c| c.untracked.clone())
        .unwrap_or_default()
}

pub fn list(cwd: &str) -> Vec<Checkpoint> {
    let Some(root) = repo_root(cwd) else { return Vec::new() };
    checkpoints_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&repo_key(&root))
        .cloned()
        .unwrap_or_default()
}

pub fn diff(cwd: &str, hash: &str) -> Result<String> {
    let root = repo_root(cwd).ok_or_else(|| AppError::Config("not a git repository".into()))?;
    if !is_valid_hash(hash) {
        return Err(AppError::Config("invalid checkpoint hash".into()));
    }
    run_git(&root, &["diff", hash])
}

pub fn restore(cwd: &str, hash: &str) -> Result<()> {
    let root = repo_root(cwd).ok_or_else(|| AppError::Config("not a git repository".into()))?;
    if !is_valid_hash(hash) {
        return Err(AppError::Config("invalid checkpoint hash".into()));
    }
    // reset --hard 前に基準集合を取得（記録が無ければ空＝安全側＝以後の untracked を全部消す）。
    let baseline = checkpoint_untracked(&root, hash);
    run_git(&root, &["reset", "--hard", hash])?;
    // reset --hard は tracked ファイルの index/worktree しか戻さず untracked には触れないため、
    // このチェックポイント以降に新規作成された untracked ファイル（＝巻き戻したいターンが
    // 作ったファイル）を明示的に削除する。捕捉時から存在した untracked ファイルはそのまま残す
    // （内容の巻き戻しまでは対応しない既知の割り切り）。
    for path in list_untracked(&root) {
        if !baseline.contains(&path) {
            let _ = std::fs::remove_file(Path::new(&root).join(&path)); // best-effort
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// テスト用の使い捨てリポジトリを作る（本物の orb リポジトリには一切触れない）。
    fn init_repo(dir: &Path) {
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        let root = dir.to_str().unwrap();
        run_git(root, &["init", "-q"]).unwrap();
        // CI/未設定環境でも commit できるよう、リポジトリローカルに author を設定する。
        run_git(root, &["config", "user.email", "test@orb.local"]).unwrap();
        run_git(root, &["config", "user.name", "orb-test"]).unwrap();
        // Windows の core.autocrlf=true（Git for Windows の既定）だとチェックアウト時に
        // LF→CRLF変換され、素朴な `\n` 文字列比較が環境依存で壊れる。テストの決定性のため
        // このリポジトリだけ明示的に無効化する（グローバル設定は変更しない）。
        run_git(root, &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(dir.join("a.txt"), "v0\n").unwrap();
        run_git(root, &["add", "-A"]).unwrap();
        run_git(root, &["commit", "-q", "-m", "init"]).unwrap();
    }

    #[test]
    fn is_valid_hash_rejects_flags_and_garbage() {
        assert!(is_valid_hash("a1b2c3d4"));
        assert!(is_valid_hash(&"f".repeat(64)));
        assert!(!is_valid_hash(""));
        assert!(!is_valid_hash(&"a".repeat(65))); // 長すぎ
        assert!(!is_valid_hash("--upload-pack=evil")); // フラグ様文字列
        assert!(!is_valid_hash("HEAD~1")); // 16進以外の revision 表記も拒否
        assert!(!is_valid_hash("g1b2c3")); // 16進じゃない文字混入
        assert!(!is_valid_hash("a")); // 短すぎる（省略hashとしても曖昧すぎる下限未満）
        assert!(is_valid_hash("a1b2c3d")); // 下限ちょうど7桁は許可
    }

    #[test]
    fn repo_root_resolves_git_dir_and_none_for_non_git() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-root");
        init_repo(&dir);
        let root = repo_root(dir.to_str().unwrap());
        assert!(root.is_some());
        // サブディレクトリからでもリポジトリルートを解決できる。
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        assert_eq!(repo_root(sub.to_str().unwrap()), root);

        let non_git = std::env::temp_dir().join("orb-checkpoint-test-nongit");
        let _ = std::fs::remove_dir_all(&non_git);
        std::fs::create_dir_all(&non_git).unwrap();
        assert!(repo_root(non_git.to_str().unwrap()).is_none());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&non_git);
    }

    #[test]
    fn capture_is_noop_on_clean_tree_and_dedupes_unchanged_repeats() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-capture");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        // クリーンな作業ツリーでは stash create が空を返す＝捕捉しない。
        assert!(!capture(cwd));
        assert!(list(cwd).is_empty());

        // 変更を入れれば捕捉される。
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        assert!(capture(cwd));
        assert_eq!(list(cwd).len(), 1);

        // 同じ変更のまま連打しても増えない（tree hash 一致で dedupe）。
        assert!(!capture(cwd));
        assert!(!capture(cwd));
        assert_eq!(list(cwd).len(), 1);

        // さらに変更すれば増える。
        std::fs::write(dir.join("a.txt"), "v2\n").unwrap();
        assert!(capture(cwd));
        assert_eq!(list(cwd).len(), 2);
        // 新しい方が先頭（newest-first）。
        assert_ne!(list(cwd)[0].hash, list(cwd)[1].hash);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn capture_is_silently_disabled_for_non_git_and_unborn_head() {
        let non_git = std::env::temp_dir().join("orb-checkpoint-test-nogit2");
        let _ = std::fs::remove_dir_all(&non_git);
        std::fs::create_dir_all(&non_git).unwrap();
        std::fs::write(non_git.join("x.txt"), "hi").unwrap();
        assert!(!capture(non_git.to_str().unwrap()));
        assert!(list(non_git.to_str().unwrap()).is_empty());

        // git init 直後・コミット0件（unborn HEAD）でもクラッシュせず false。
        let unborn = std::env::temp_dir().join("orb-checkpoint-test-unborn");
        let _ = std::fs::remove_dir_all(&unborn);
        std::fs::create_dir_all(&unborn).unwrap();
        run_git(unborn.to_str().unwrap(), &["init", "-q"]).unwrap();
        std::fs::write(unborn.join("y.txt"), "hi").unwrap();
        run_git(unborn.to_str().unwrap(), &["add", "-A"]).unwrap();
        assert!(!capture(unborn.to_str().unwrap()));

        let _ = std::fs::remove_dir_all(&non_git);
        let _ = std::fs::remove_dir_all(&unborn);
    }

    #[test]
    fn diff_and_restore_roundtrip() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-restore");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        std::fs::write(dir.join("a.txt"), "checkpoint-state\n").unwrap();
        assert!(capture(cwd));
        let hash = list(cwd)[0].hash.clone();

        // capture 直後は作業ツリー＝チェックポイント内容なので diff は空。
        assert_eq!(diff(cwd, &hash).unwrap(), "");

        // さらに変更を重ねる（AIがもう1ターン作業した想定）。
        std::fs::write(dir.join("a.txt"), "after-more-changes\n").unwrap();
        let after_diff = diff(cwd, &hash).unwrap();
        assert!(after_diff.contains("checkpoint-state") || after_diff.contains("after-more-changes"));

        // ロールバック: 作業ツリーがチェックポイント時点の内容に戻る。
        restore(cwd, &hash).unwrap();
        let content = std::fs::read_to_string(dir.join("a.txt")).unwrap();
        assert_eq!(content, "checkpoint-state\n");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// レビュー指摘の再現: `git stash create` は untracked ファイルを一切拾わないため、
    /// 「tracked ファイルを直しつつ新規ファイルも作る」ターンを巻き戻すと、素朴な実装では
    /// 新規ファイルだけ生き残ってしまう。untracked スナップショット差分で削除されることを確認。
    #[test]
    fn restore_removes_untracked_files_created_after_the_checkpoint() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-untracked");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        // チェックポイント時点で既にあった untracked ファイル（内容までは戻せない既知の
        // 割り切りだが、少なくとも「消してはいけない」ことを確認する）。
        std::fs::write(dir.join("pre_existing_scratch.txt"), "keep-me\n").unwrap();

        // 1ターン分の変更: tracked ファイル修正 + 新規ファイル作成（最も典型的な「AIがファイルを
        // 追加した」パターン）。
        std::fs::write(dir.join("a.txt"), "v1\n").unwrap();
        std::fs::write(dir.join("new_file.rs"), "fn new() {}\n").unwrap();
        assert!(capture(cwd));
        let hash = list(cwd)[0].hash.clone();
        assert!(dir.join("new_file.rs").exists()); // capture 自体は作業ツリーを一切変更しない

        // さらにもう1ターン（別の新規ファイルも作る）。
        std::fs::write(dir.join("a.txt"), "v2\n").unwrap();
        std::fs::write(dir.join("another_new_file.rs"), "fn another() {}\n").unwrap();

        restore(cwd, &hash).unwrap();

        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "v1\n");
        assert!(dir.join("new_file.rs").exists(), "チェックポイント時点で既にあった新規ファイルは残る");
        assert!(
            !dir.join("another_new_file.rs").exists(),
            "チェックポイント以降に作られたファイルは削除される"
        );
        assert!(
            dir.join("pre_existing_scratch.txt").exists(),
            "チェックポイントより前から存在した untracked ファイルは消さない"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_and_restore_reject_invalid_hash_and_non_git_dir() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-invalid");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        assert!(diff(cwd, "--not-a-hash").is_err());
        assert!(restore(cwd, "--not-a-hash").is_err());
        // 実在しないが形式は正しい hash（git 側が拒否する）。
        assert!(diff(cwd, &"0".repeat(40)).is_err());

        let non_git = std::env::temp_dir().join("orb-checkpoint-test-invalid-nogit");
        let _ = std::fs::remove_dir_all(&non_git);
        std::fs::create_dir_all(&non_git).unwrap();
        assert!(diff(non_git.to_str().unwrap(), &"a".repeat(40)).is_err());
        assert!(restore(non_git.to_str().unwrap(), &"a".repeat(40)).is_err());

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&non_git);
    }

    #[test]
    fn list_truncates_at_retention_cap() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-cap");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        // i+1 から始める: init_repo の初期コミット内容が "v0\n" のため、i=0 のままだと
        // 1周目が「変化なし」になり capture が false を返す（過去に踏んだテストバグ）。
        for i in 0..(MAX_CHECKPOINTS + 3) {
            std::fs::write(dir.join("a.txt"), format!("v{}\n", i + 1)).unwrap();
            assert!(capture(cwd));
        }
        let got = list(cwd);
        assert_eq!(got.len(), MAX_CHECKPOINTS);
        // 最新（最後に書いた v{MAX_CHECKPOINTS+3}）が先頭に残っている。
        let latest_hash = &got[0].hash;
        assert_eq!(diff(cwd, latest_hash).unwrap(), "");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
