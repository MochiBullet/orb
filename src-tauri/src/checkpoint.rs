//! #54: ターン毎チェックポイント（`git stash create` による非破壊スナップショット）＋
//! 明示確認を挟んだロールバック。
//!
//! - **捕捉**: AI ペインへの入力送信（ターン開始）を合図に `git stash create` を叩く。
//!   このコマンドは stash リストにも作業ツリー/インデックスにも触れず、「今の index+worktree
//!   の状態」を表す commit オブジェクトを作って hash を返すだけ＝完全に非破壊。捕捉タイミング
//!   が「AI が動き出す直前」なので、そのまま「直前のターンに巻き戻す」の基準点になる。
//! - 直前チェックポイントと tree が同一（＝実質変化なし）なら記録しない。連打・無変更の
//!   ターンで保持枠を無駄に消費しない。
//! - **ロールバック**は `git restore --source=<checkpoint> --staged --worktree -- .`（この関数
//!   だけが破壊的操作）。呼ばれたら問答無用で実行する単純な形にし、diff プレビュー＋確認は
//!   UI 層の責務とする（BlockHistory 等の再実行系と同じ「実行するのは明示操作」契約）。
//!   Fable5 レビュー指摘: 以前は `git reset --hard <checkpoint>` を使っていたが、これは
//!   作業ツリーだけでなく**ブランチの参照（HEAD）ごと**チェックポイント時点へ動かしてしまう。
//!   チェックポイント取得後に本物のコミットをしていた場合、そのコミットがブランチから
//!   外れて reflog 経由でしか復旧できなくなる（実機で再現・確認済み）。`git restore` は
//!   ブランチ参照に触れず、作業ツリー/インデックスの内容だけをチェックポイント時点に戻す
//!   ため、この事故が起きない。
//! - git 未導入・非リポジトリ・コミット無しリポ（unborn HEAD）は静かに無効（false/空を返すだけ）。
//! - 状態はプロセスメモリのみ（永続化しない）。再起動を跨いだ巻き戻しは対象外＝シンプルさ優先。

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::procutil::new_command;

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
    let out = new_command("git")
        .args(args)
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Config(format!("git spawn failed: {e}")))?;
    if !out.status.success() {
        return Err(AppError::Config(String::from_utf8_lossy(&out.stderr).trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// diff プレビューの捕捉上限。`git diff <hash>` はブロック単位の上限が無く（blocks.rs /
/// usage_local.rs は末尾バイト上限を持つ）、生成物・ロックファイル・コミット済みデータセット
/// 等を `git add` したターンのプレビューでは ± の全文が流れてくる。`Command::output()` は
/// stdout 全体を Vec に貯め、`from_utf8_lossy` がさらにもう一度全コピーする＝二重確保で
/// 16GB 機では allocator OOM-abort に到達しうる（state.rs: この経路は panic hook を迂回し
/// PTY 子プロセスを孤児化する）。ここは restore 前に人間が眺めるプレビューなので、上限で
/// 打ち切って注記を添えれば十分＝OOM より遥かにマシ。
const MAX_DIFF_BYTES: usize = 3 * 1024 * 1024;

/// diff 専用の上限付き git 実行。stdout を先頭 `MAX_DIFF_BYTES` までしか読まず、超過分は
/// 捨てて注記を付ける。`run_git`（全 stdout を Vec に貯める）と違い、巨大 diff でもメモリは
/// 上限で頭打ちになる。捕捉/一覧/restore の git 出力は hash や status で小さいため対象外。
fn run_git_diff_bounded(repo_root: &str, args: &[&str]) -> Result<String> {
    use std::io::Read;
    let mut child = new_command("git")
        .args(args)
        .current_dir(repo_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| AppError::Config(format!("git spawn failed: {e}")))?;
    let mut stdout = child.stdout.take().expect("stdout is piped");
    // 上限＋1バイトだけ読む＝超過を検知しつつ、確保するバッファ自体を上限で頭打ちにする。
    let mut buf = Vec::new();
    (&mut stdout)
        .take(MAX_DIFF_BYTES as u64 + 1)
        .read_to_end(&mut buf)
        .map_err(|e| AppError::Config(format!("git diff read failed: {e}")))?;

    if buf.len() > MAX_DIFF_BYTES {
        buf.truncate(MAX_DIFF_BYTES);
        // これ以上読まない＝git が満杯のパイプでブロックし続けないよう、子を落としてから回収する。
        let _ = child.kill();
        let _ = child.wait();
        let mut s = String::from_utf8_lossy(&buf).into_owned();
        s.push_str(&format!(
            "\n... (diff truncated at {} MB — restore preview only)\n",
            MAX_DIFF_BYTES / (1024 * 1024)
        ));
        return Ok(s);
    }

    // 全部読めた（EOF）＝通常サイズ。終了コードを見て、失敗なら run_git と同様に stderr を返す。
    let status = child
        .wait()
        .map_err(|e| AppError::Config(format!("git wait failed: {e}")))?;
    if !status.success() {
        let mut err = String::new();
        if let Some(mut se) = child.stderr.take() {
            let _ = se.read_to_string(&mut err);
        }
        return Err(AppError::Config(err.trim().to_string()));
    }
    Ok(String::from_utf8_lossy(&buf).trim().to_string())
}

/// #3: リポジトリごとの「git 操作」直列化ロック。`checkpoints_state` の Mutex は HashMap
/// （メモリ状態）だけを守り、実際の `git stash create`(capture) / `git restore`(restore) は
/// spawn_blocking 経由でロック外を走る。同一リポで restore と capture が同時発火すると、
/// 両者が `.git/index.lock` を掴んで一方が失敗、または半分 restore した worktree を捕捉して
/// 壊れたチェックポイントを黙って記録しうる。repo_key ごとの Mutex で直列化し、別リポは
/// 引き続き並列に動けるようにする。ロック順序は必ず「op-lock → state-lock」で統一する
/// （capture/restore とも op-lock を先に取ってから state を触る）＝デッドロックしない。
fn repo_git_lock(root: &str) -> Arc<Mutex<()>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    let map = LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut m = map.lock().unwrap_or_else(|p| p.into_inner());
    m.entry(repo_key(root))
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// cwd から git リポジトリのルートを解決する。git 未導入・非リポジトリは None（静かに無効）。
fn repo_root(cwd: &str) -> Option<String> {
    let out = new_command("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(cwd)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    // git は常に `/` 区切りで返す。Windows のパス表記に合わせるのはそちら側だけでよく、
    // Unix は既に正しい形（そもそも `\` は区切り文字ではなくファイル名に使える文字）。
    #[cfg(windows)]
    let root = String::from_utf8_lossy(&out.stdout).trim().replace('/', "\\");
    #[cfg(not(windows))]
    let root = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if root.is_empty() {
        None
    } else {
        Some(root)
    }
}

/// リポジトリキー（HashMap のキーとして安定していればよい）。Windows は大小文字を
/// 区別しないファイルシステムのため小文字化して比較、Unix（特に ext4 等）は大小文字を
/// 区別するファイルシステムが標準のため、小文字化すると別ディレクトリを誤って同一視
/// しうる＝素通しにする（macOS の既定 APFS は大小文字非区別だが、Unix 全体で安全側に
/// 倒すため一律で区別する）。
fn repo_key(root: &str) -> String {
    #[cfg(windows)]
    {
        root.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        root.to_string()
    }
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
    // #3: 同一リポの restore と index.lock を奪い合わないよう、git 操作は op-lock で直列化する。
    let op_lock = repo_git_lock(&root);
    let _op = op_lock.lock().unwrap_or_else(|p| p.into_inner());
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
/// `Some(list)` = 記録あり（捕捉時に untracked が0件なら空 Vec）。`None` = このハッシュの
/// 記録がそもそも無い＝「何が既存で何が新規か判別できない」ため、呼び出し側は untracked に
/// 一切触れないこと（Fable5 指摘: 空 Vec と未記録を同一視すると、未記録時に「安全側」のつもり
/// で untracked を全削除してしまう——逆に何もしないのが安全側）。
fn checkpoint_untracked(root: &str, hash: &str) -> Option<Vec<String>> {
    checkpoints_state()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(&repo_key(root))
        .and_then(|list| list.iter().find(|c| c.hash == hash))
        .map(|c| c.untracked.clone())
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
    // #1: 巨大 diff で OOM しないよう上限付きで捕捉する（run_git_diff_bounded の doc 参照）。
    run_git_diff_bounded(&root, &["diff", hash])
}

/// #2: 進行中のマージ/リベースを best-effort で中断する。AI のターンが `git merge`/`git rebase`
/// で衝突したまま止まった状態で restore すると、restore は worktree/index を戻すが
/// `.git/MERGE_HEAD`・`.git/rebase-merge`(-apply) は残る＝`git status` は「まだマージ中」と言い、
/// 次の `git commit` が黙ってチェックポイント tree のマージコミットを作ってしまう。これを避ける。
/// **restore の前に**呼ぶこと: `git merge --abort` は worktree をマージ前(HEAD)へ戻すため、
/// その後の restore で確実にチェックポイント tree で上書きし直せる（後に呼ぶと restore 内容を
/// 潰す）。進行中でなければ git は "no merge/rebase in progress" 等で非ゼロ終了するが、それは
/// 想定内なので握り潰す（＝何も進行していなければ完全に no-op）。
fn abort_in_progress_merge_or_rebase(root: &str) {
    let _ = run_git(root, &["merge", "--abort"]);
    let _ = run_git(root, &["rebase", "--abort"]);
}

/// #4: チェックポイント以降に新規作成された untracked ファイル（baseline に無い＝巻き戻したい
/// ターンが作ったもの）を削除し、実際に消したパスを返す。呼び出し側でログ等に surface する
/// 前提＝サイレント削除（out-of-band でユーザ/ビルドツールが作った `secret.env`・`dist/` 等も
/// 巻き込みうる data-loss footgun）にしないための純ロジック（テスト可能なよう分離）。
fn remove_post_checkpoint_untracked(root: &str, baseline: &[String]) -> Vec<String> {
    let mut removed = Vec::new();
    for path in list_untracked(root) {
        if !baseline.contains(&path) && std::fs::remove_file(Path::new(root).join(&path)).is_ok() {
            removed.push(path);
        }
    }
    removed
}

pub fn restore(cwd: &str, hash: &str) -> Result<()> {
    let root = repo_root(cwd).ok_or_else(|| AppError::Config("not a git repository".into()))?;
    if !is_valid_hash(hash) {
        return Err(AppError::Config("invalid checkpoint hash".into()));
    }
    // #3: 同一リポの capture と index.lock を奪い合わないよう、git 操作は op-lock で直列化する。
    let op_lock = repo_git_lock(&root);
    let _op = op_lock.lock().unwrap_or_else(|p| p.into_inner());
    // restore 前に基準集合を取得。
    let baseline = checkpoint_untracked(&root, hash);
    // #2: restore の前に進行中のマージ/リベースを畳んで単一親のクリーンな状態にする（doc 参照）。
    abort_in_progress_merge_or_rebase(&root);
    // git restore はブランチ参照（HEAD）に触れず、作業ツリー/インデックスの内容だけを
    // チェックポイント時点へ戻す（reset --hard との違いは冒頭の doc comment 参照）。
    run_git(&root, &["restore", "--source", hash, "--staged", "--worktree", "--", "."])?;
    // git restore は untracked ファイルには触れないため、このチェックポイント以降に新規作成
    // された untracked ファイル（＝巻き戻したいターンが作ったファイル）を明示的に削除する。
    // 捕捉時から存在した untracked ファイルはそのまま残す（内容の巻き戻しまでは対応しない
    // 既知の割り切り）。baseline が None（記録なし）なら何が新規か判別できないため触れない。
    if let Some(baseline) = baseline {
        let removed = remove_post_checkpoint_untracked(&root, &baseline);
        // #4: サイレント削除にしない。out-of-band で作られたファイルまで消しうるので必ず surface。
        if !removed.is_empty() {
            eprintln!(
                "checkpoint restore: removed {} untracked file(s): {}",
                removed.len(),
                removed.join(", ")
            );
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

    /// Fable5 レビュー指摘の再現: 旧実装（`git reset --hard <checkpoint>`）は、チェックポイント
    /// 取得後に本物のコミットをしていた場合、そのコミットをブランチ履歴から外してしまう
    /// （reflog 経由でしか復旧できなくなる）。restore はブランチ参照を動かさず、コミットは
    /// 一切失われないことを確認する。
    #[test]
    fn restore_does_not_move_head_or_lose_commits_made_after_the_checkpoint() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-head-safety");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        // チェックポイント時点の変更。
        std::fs::write(dir.join("a.txt"), "checkpoint-state\n").unwrap();
        assert!(capture(cwd));
        let hash = list(cwd)[0].hash.clone();

        // チェックポイント取得後、本物のコミットを2つ重ねる（AIがそのまま確定させた想定）。
        run_git(cwd, &["add", "-A"]).unwrap();
        run_git(cwd, &["commit", "-q", "-m", "real commit after checkpoint"]).unwrap();
        std::fs::write(dir.join("b.txt"), "new file after checkpoint\n").unwrap();
        run_git(cwd, &["add", "-A"]).unwrap();
        run_git(cwd, &["commit", "-q", "-m", "add file after checkpoint"]).unwrap();
        let head_before = run_git(cwd, &["rev-parse", "HEAD"]).unwrap();

        restore(cwd, &hash).unwrap();

        // HEAD（ブランチ参照）は一切動いていない＝本物のコミットは失われていない。
        let head_after = run_git(cwd, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(head_before, head_after, "restore はブランチ参照を動かしてはいけない");
        let log = run_git(cwd, &["log", "--oneline"]).unwrap();
        assert!(log.contains("real commit after checkpoint"));
        assert!(log.contains("add file after checkpoint"));

        // 作業ツリーの内容はチェックポイント時点まで戻る。
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "checkpoint-state\n");
        // チェックポイント後に追加された b.txt（tracked）は消える。
        assert!(!dir.join("b.txt").exists());

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

    /// Fable5 レビュー指摘の再現: `checkpoint_untracked` が記録なしを空 Vec と同一視していた
    /// 頃は、「記録が無い＝安全側で untracked を全削除」という逆の挙動になっていた。restore に
    /// このマップへ登録されていない（が実在する）コミットを渡した時、既存の untracked ファイルに
    /// 一切触れないことを確認する。
    #[test]
    fn restore_leaves_untracked_alone_when_hash_has_no_recorded_baseline() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-no-baseline");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();
        // このマップに一切登録されていない実在コミット（init コミット自身）。
        let untracked_hash = run_git(cwd, &["rev-parse", "HEAD"]).unwrap();

        std::fs::write(dir.join("some_untracked.txt"), "should-survive\n").unwrap();
        restore(cwd, &untracked_hash).unwrap();

        assert!(
            dir.join("some_untracked.txt").exists(),
            "記録の無いハッシュでの restore は untracked に触れてはいけない"
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

    /// #1: 巨大な diff（生成物/データセットを add したターン）でも OOM せず、上限で打ち切って
    /// 注記を付けることを確認する（全文を二重確保しない）。
    #[test]
    fn diff_truncates_huge_output_instead_of_ooming() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-diff-cap");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();

        // MAX_DIFF_BYTES を優に超える tracked テキストファイルを作ってコミット。
        let line = "lorem ipsum dolor sit amet consectetur adipiscing\n"; // 50 bytes
        let reps = (MAX_DIFF_BYTES + 2_000_000) / line.len() + 1;
        std::fs::write(dir.join("big.txt"), line.repeat(reps)).unwrap();
        run_git(cwd, &["add", "-A"]).unwrap();
        run_git(cwd, &["commit", "-q", "-m", "add big"]).unwrap();

        // big.txt を含む状態でチェックポイントを取る（変化を出すため a.txt も触る）。
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        assert!(capture(cwd));
        let hash = list(cwd)[0].hash.clone();

        // big.txt を空にする＝diff に数 MB の削除が出る。
        std::fs::write(dir.join("big.txt"), "").unwrap();
        let d = diff(cwd, &hash).unwrap();
        assert!(
            d.len() <= MAX_DIFF_BYTES + 256,
            "diff は上限＋注記程度に収まる: {} bytes",
            d.len()
        );
        assert!(d.contains("diff truncated"), "打ち切り注記が付く");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #2: マージ衝突で止まった状態から restore すると、MERGE_HEAD が残って次の commit が
    /// 黙ってマージコミットになる。restore が進行中マージを畳んでクリーンな単一親状態に戻す
    /// ことを確認する。
    #[test]
    fn restore_clears_in_progress_merge_state() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-merge-abort");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap();
        let base = run_git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).unwrap();

        // feature 側で a.txt の同じ行を別内容に変更してコミット。
        run_git(cwd, &["checkout", "-q", "-b", "feature"]).unwrap();
        std::fs::write(dir.join("a.txt"), "feature-line\n").unwrap();
        run_git(cwd, &["add", "-A"]).unwrap();
        run_git(cwd, &["commit", "-q", "-m", "feature change"]).unwrap();

        // base 側でも同じ行を別内容に変更してコミット（restore ターゲットにする）。
        run_git(cwd, &["checkout", "-q", &base]).unwrap();
        std::fs::write(dir.join("a.txt"), "base-line\n").unwrap();
        run_git(cwd, &["add", "-A"]).unwrap();
        run_git(cwd, &["commit", "-q", "-m", "base change"]).unwrap();
        let target = run_git(cwd, &["rev-parse", "HEAD"]).unwrap();

        // マージ → 衝突 → MERGE_HEAD が立つ。
        assert!(run_git(cwd, &["merge", "feature"]).is_err(), "衝突でマージは失敗する");
        assert!(dir.join(".git").join("MERGE_HEAD").exists(), "マージ進行中の目印");

        // restore で進行中マージを畳み、worktree をターゲット tree に戻す。
        restore(cwd, &target).unwrap();
        assert!(
            !dir.join(".git").join("MERGE_HEAD").exists(),
            "restore 後は MERGE_HEAD が消える"
        );
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "base-line\n");
        // 次の commit が黙ってマージコミットにならない＝クリーンな単一親状態。
        let status = run_git(cwd, &["status", "--porcelain"]).unwrap();
        assert!(status.is_empty(), "restore 後の作業ツリーはクリーン: {status:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #4: チェックポイント以降に作られた untracked ファイルの削除がサイレントにならず、
    /// 消したパスを返して surface できることを確認する（baseline にある既存ファイルは残す）。
    #[test]
    fn restore_reports_removed_untracked_paths() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-removed-report");
        init_repo(&dir);
        let root = dir.to_str().unwrap().to_string();

        // baseline に含まれる既存 untracked（消してはいけない）。
        std::fs::write(dir.join("keep.txt"), "keep\n").unwrap();
        // baseline に無い新規 untracked（削除対象）。
        std::fs::write(dir.join("new_a.txt"), "a\n").unwrap();
        std::fs::write(dir.join("new_b.txt"), "b\n").unwrap();

        let baseline = vec!["keep.txt".to_string()];
        let mut removed = remove_post_checkpoint_untracked(&root, &baseline);
        removed.sort();
        assert_eq!(removed, vec!["new_a.txt".to_string(), "new_b.txt".to_string()]);
        assert!(dir.join("keep.txt").exists(), "baseline の既存ファイルは残る");
        assert!(!dir.join("new_a.txt").exists());
        assert!(!dir.join("new_b.txt").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #3: 同一リポで capture と restore を多数スレッドから同時に叩いても、op-lock で直列化
    /// されるため index.lock 衝突でパニック/破損せず完走し、記録済みハッシュは常に解決可能な
    /// ままである（＝半分 restore した worktree の壊れたチェックポイントを記録しない）。
    #[test]
    fn concurrent_capture_and_restore_serialize_without_corruption() {
        let dir = std::env::temp_dir().join("orb-checkpoint-test-concurrency");
        init_repo(&dir);
        let cwd = dir.to_str().unwrap().to_string();

        // まず1つチェックポイントを作る（restore ターゲット）。
        std::fs::write(dir.join("a.txt"), "seed\n").unwrap();
        assert!(capture(&cwd));
        let hash = list(&cwd)[0].hash.clone();

        let mut handles = Vec::new();
        for i in 0..6 {
            let c = cwd.clone();
            let d = dir.clone();
            let h = hash.clone();
            handles.push(std::thread::spawn(move || {
                for _ in 0..4 {
                    if i % 2 == 0 {
                        std::fs::write(d.join("a.txt"), format!("t{i}\n")).unwrap();
                        let _ = capture(&c);
                    } else {
                        let _ = restore(&c, &h);
                    }
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }

        // 記録された全チェックポイントの tree が解決できる＝壊れたハッシュを記録していない。
        for cp in list(&cwd) {
            assert!(rev_parse_tree(&cwd, &cp.hash).is_ok(), "記録済みハッシュは解決可能: {}", cp.hash);
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
