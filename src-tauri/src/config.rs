use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 案件ランチャー1件分。warp の gen-warp-launch-configs.ps1 の $projects に対応。
/// slug/name/dir にも #[serde(default)] を付け、1エントリだけ欠損フィールドがあっても
/// Vec<Project> 全体のパースが失敗しないようにする（load_projects 参照＝壊れたエントリだけ
/// 弾いて他の正常なエントリは活かすための前提）。
#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    #[serde(default)]
    pub slug: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub dir: String,
    #[serde(default)]
    pub dev_cmd: String,
    /// モノレポ等で dev サーバの cwd が dir と異なる場合のみ。空なら dir を使う。
    #[serde(default)]
    pub dev_cwd: String,
    /// #82: 外部インボックス機能用のラベル。`Some` なら起動時に AI ペインの spawn_pty へ
    /// 渡り、`%TEMP%\orb-queue\inbox\` 経由でそのペインへテキストを注入できるようになる。
    /// 利用者がローカルの projects.toml に任意で追加する値で、orb 既定の案件一覧には含めない。
    #[serde(default)]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct ProjectsFile {
    #[serde(default, rename = "project")]
    project: Vec<Project>,
}

fn default_font_size() -> u16 {
    13
}
fn default_font_family() -> String {
    "\"Cascadia Code\", \"FiraCode Nerd Font\", \"Consolas\", monospace".into()
}
fn default_scrollback() -> u32 {
    1000
}
fn default_accent() -> String {
    "#2dd4bf".into()
}
/// AI ペインの識別色の既定。--violet と同じ値（Settings で独立に変更可能にする前の固定値）。
fn default_ai_accent() -> String {
    "#a78bfa".into()
}
fn default_ligatures() -> bool {
    true
}
/// 既定背景センチネル。可搬な既定値として config.toml に永続化し、実行時に
/// ensure_default_bg() が config_dir 下へ展開した実パスへフロントが解決する（＝マシン非依存。
/// 実パスを直に既定へ焼くと再インストール/別マシンで陳腐化するので、文字列センチネルにする）。
pub const DEFAULT_BG_SENTINEL: &str = "__default__";

fn default_bg_image() -> String {
    DEFAULT_BG_SENTINEL.into()
}
fn default_bg_dim() -> f32 {
    0.5
}
fn default_bg_size() -> String {
    "cover".into()
}
fn default_bg_pos_x() -> f32 {
    65.0
}
fn default_bg_pos_y() -> f32 {
    100.0
}
fn default_bg_zoom() -> f32 {
    1.0
}
fn default_show_info_on_startup() -> bool {
    true
}

/// Crew の1枠。sprite が空なら既定の SVG キャラを描く。
/// Project と同じく全フィールドに serde(default) を付け、1つ欠けても枠ごと落ちないようにする。
#[derive(Serialize, Deserialize, Clone)]
pub struct CrewSlot {
    #[serde(default)]
    pub name: String,
    #[serde(default = "default_crew_color")]
    pub color: String,
    /// config_dir() からの相対パス。空 = 既定 SVG。
    #[serde(default)]
    pub sprite: String,
}

fn default_crew_color() -> String {
    "#4fb3a4".into()
}

fn default_crew_slots() -> Vec<CrewSlot> {
    vec![
        CrewSlot { name: String::new(), color: "#4fb3a4".into(), sprite: String::new() },
        CrewSlot { name: String::new(), color: "#9b7fd4".into(), sprite: String::new() },
    ]
}

/// orb 本体の設定（config.toml）。
#[derive(Serialize, Deserialize, Clone)]
pub struct Config {
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_scrollback")]
    pub scrollback: u32,
    #[serde(default = "default_accent")]
    pub accent: String,
    /// AI ペインの識別色（枠線・見出し等）。--violet の既定値を独立に変更可能にする。
    #[serde(default = "default_ai_accent")]
    pub ai_accent: String,
    /// プログラミング合字（=> != -> 等）を character joiner で繋げて表示。
    #[serde(default = "default_ligatures")]
    pub ligatures: bool,
    /// 背景画像の絶対パス（空=無し）。asset プロトコルで配信し端末背後に敷く（#21）。
    #[serde(default = "default_bg_image")]
    pub bg_image: String,
    /// 背景画像の上に敷く暗幕の不透明度 0..1（可読性確保）。画像が無ければ無効。
    #[serde(default = "default_bg_dim")]
    pub bg_dim: f32,
    /// 背景画像の表示サイズ（CSS background-size）。"cover"=切り抜いて敷き詰め / "contain"=全体を収める。
    #[serde(default = "default_bg_size")]
    pub bg_size: String,
    /// 背景画像の表示位置 0..100%（cover 時にどこを見せるか＝クロップ位置の調整）。x=水平, y=垂直。
    #[serde(default = "default_bg_pos_x")]
    pub bg_pos_x: f32,
    #[serde(default = "default_bg_pos_y")]
    pub bg_pos_y: f32,
    /// 背景メディアのズーム倍率 1.0..（cover/contain の基準フィットから寄せてクロップを詰める）。
    /// object-fit＋transform:scale で縦横比を保ったまま拡大＝歪まない（#66 で img/video 共通経路）。
    #[serde(default = "default_bg_zoom")]
    pub bg_zoom: f32,
    /// #47: 起動時に info（取扱説明書）タブを開くか。復元セッションに info タブが
    /// 無いとき末尾へ非アクティブで補充する（真の初回起動は設定に依らずアクティブで開く）。
    #[serde(default = "default_show_info_on_startup")]
    pub show_info_on_startup: bool,
    /// Crew ビュー用の2枠（名前・色・差し替えスプライト）。
    #[serde(default = "default_crew_slots")]
    pub crew: Vec<CrewSlot>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font_size: default_font_size(),
            font_family: default_font_family(),
            scrollback: default_scrollback(),
            accent: default_accent(),
            ai_accent: default_ai_accent(),
            ligatures: default_ligatures(),
            bg_image: default_bg_image(),
            bg_dim: default_bg_dim(),
            bg_size: default_bg_size(),
            bg_pos_x: default_bg_pos_x(),
            bg_pos_y: default_bg_pos_y(),
            bg_zoom: default_bg_zoom(),
            show_info_on_startup: default_show_info_on_startup(),
            crew: default_crew_slots(),
        }
    }
}

/// テキストを `dir` 直下の `name` へアトミックに書く。同じディレクトリ内の一時ファイル
/// （`name.tmp`）へ丸ごと書いてから rename で本体に差し替える＝同一ファイルシステム上の
/// rename は原子的なので、書き込み中のクラッシュ・電源断・ディスクフル・AV ロックで
/// 途中切れの `name` が残ることがない（#74 ROB-1）。旧来の create+truncate な
/// `std::fs::write` 直書きだと、書き込みの途中で死ぬと半端なファイルが残り、次回起動時に
/// パース失敗＝全設定がデフォルトへ巻き戻っていた。
fn write_atomic(dir: &Path, name: &str, contents: &str) -> Result<()> {
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, dir.join(name))?;
    Ok(())
}

/// config.toml を書き出す（設定GUI からの保存）。
pub fn save_config(cfg: &Config) -> Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let s = toml::to_string_pretty(cfg).map_err(|e| AppError::Config(e.to_string()))?;
    write_atomic(&dir, "config.toml", &s)?;
    Ok(())
}

/// config.toml を読む（read 専用＝FS を書き換えない。初回の書き出しは seed_defaults）。
pub fn load_config() -> Config {
    match std::fs::read_to_string(config_dir().join("config.toml")) {
        Ok(text) => parse_config_text(&text),
        Err(_) => Config::default(),
    }
}

/// 型が不正、または欠損しているフィールドは `default` にフォールバックする。欠損は
/// 通常 `#[serde(default)]` の高速パスで救われるケースなので黙って許すが、値が存在するのに
/// デシリアライズに失敗した（型違い）場合だけ eprintln! でログする（parse_projects_text と
/// 同じ「実際に壊れているものだけ知らせる」方針）。
fn field_or_default<T: serde::de::DeserializeOwned>(v: &toml::Value, name: &str, default: T) -> T {
    match v.get(name) {
        None => default,
        Some(x) => match T::deserialize(x.clone()) {
            Ok(parsed) => parsed,
            Err(e) => {
                eprintln!(
                    "[orb] config.toml: フィールド '{name}' の型が不正なので既定値にフォールバックします: {e}"
                );
                default
            }
        },
    }
}

/// `Config` 全体としてのパースが失敗した場合に、`toml::Value` からフィールド単位で救済して
/// 組み立てる。1フィールドの型違い（例: `font_size = "big"`）が他の正常なフィールドまで
/// 巻き添えにして消し飛ばすのを防ぐ（#74 ROB-2。parse_projects_text で [[project]] エントリ
/// 単位に適用したのと同じ考え方を、トップレベルの Config フィールドに適用する）。
fn config_from_value(v: &toml::Value) -> Config {
    Config {
        font_size: field_or_default(v, "font_size", default_font_size()),
        font_family: field_or_default(v, "font_family", default_font_family()),
        scrollback: field_or_default(v, "scrollback", default_scrollback()),
        accent: field_or_default(v, "accent", default_accent()),
        ai_accent: field_or_default(v, "ai_accent", default_ai_accent()),
        ligatures: field_or_default(v, "ligatures", default_ligatures()),
        bg_image: field_or_default(v, "bg_image", default_bg_image()),
        bg_dim: field_or_default(v, "bg_dim", default_bg_dim()),
        bg_size: field_or_default(v, "bg_size", default_bg_size()),
        bg_pos_x: field_or_default(v, "bg_pos_x", default_bg_pos_x()),
        bg_pos_y: field_or_default(v, "bg_pos_y", default_bg_pos_y()),
        bg_zoom: field_or_default(v, "bg_zoom", default_bg_zoom()),
        show_info_on_startup: field_or_default(v, "show_info_on_startup", default_show_info_on_startup()),
        crew: field_or_default(v, "crew", default_crew_slots()),
    }
}

/// config.toml のテキストを Config へパースする。高速パス＝構造体全体としてそのままパース
/// できればそれを返す（既存の挙動のまま）。失敗した場合は toml::Value に一度パースし直し、
/// config_from_value でフィールド単位に救済する。TOML として構文的に壊れていて Value にすら
/// ならない場合（真の構文エラー）のみ Config::default()。
fn parse_config_text(text: &str) -> Config {
    if let Ok(cfg) = toml::from_str::<Config>(text) {
        return cfg;
    }
    match toml::from_str::<toml::Value>(text) {
        Ok(v) => config_from_value(&v),
        Err(_) => Config::default(),
    }
}

/// 初回起動時、設定ファイルが無ければ既定を書き出す（書き込みは起動時の一度だけ）。
/// 「読み取りコマンドが FS を書き換える」副作用を load_* から切り離すための seed。
pub fn seed_defaults() {
    let dir = config_dir();
    let _ = std::fs::create_dir_all(&dir);
    let pp = dir.join("projects.toml");
    if !pp.exists() {
        if let Ok(s) = toml::to_string_pretty(&ProjectsFile {
            project: default_projects(),
        }) {
            let _ = write_atomic(&dir, "projects.toml", &s);
        }
    }
    let cp = dir.join("config.toml");
    if !cp.exists() {
        if let Ok(s) = toml::to_string_pretty(&Config::default()) {
            let _ = write_atomic(&dir, "config.toml", &s);
        }
    }
}

/// home が空（USERPROFILE/HOME 未設定）の場合のフォールバックを適用する。相対パス
/// `.config\orb`（プロセスの cwd 次第で書き込み先がブレる＝#74 ROB-5）にならないよう、
/// 常に絶対パスを返す（shell.rs の非空ガードと同じ考え方）。home を注入で受け取り、
/// テストで env に触らず分岐を検証できるようにする。
fn config_dir_with_home(home: PathBuf) -> PathBuf {
    if home.as_os_str().is_empty() {
        std::env::temp_dir().join("orb")
    } else {
        home.join(".config").join("orb")
    }
}

/// $XDG_CONFIG_HOME/orb（未設定なら ~/.config/orb）。
/// blocks.rs（#31 耐久ログ）も同じ基準ディレクトリを使うため pub(crate)。
pub(crate) fn config_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(x).join("orb");
    }
    config_dir_with_home(crate::status::home_dir())
}

/// 既定背景動画をバイナリへ埋め込む（shell-integration.ps1 と同じ方針＝Tauri の
/// bundle.resources ではなく include_bytes! で実体を持ち、dev/本番でパス解決の差を無くす）。
/// ただし shell スクリプトは毎回 temp へ捨てる transient なのに対し、bg_image は config.toml に
/// 永続化されるパス文字列なので、毎回ランダムパスへ展開すると再起動で保存パスが陳腐化する。
/// そのため config_dir 下の固定パスへ「既存かつ内容が一致すればスキップ」する冪等展開にする。
const BG_DEFAULT: &[u8] = include_bytes!("../resources/bg-default.mp4");

/// 既定背景動画の展開先（config_dir 下の固定名＝決定的・再起動後も同じパス）。
fn default_bg_dst() -> PathBuf {
    config_dir().join("bg-default.mp4")
}

/// バイト列を dst へ冪等に書く。既存かつ内容が完全一致ならスキップ。バイナリ更新で動画が
/// 差し替われば（同じ長さでも）検知して再展開＝古い動画が残らない。`bytes`（BG_DEFAULT）は
/// include_bytes! で既にプロセスのメモリ上に丸ごとある数MBの定数で、この関数自体も起動時に
/// 一度しか呼ばれないため、部分サンプルで妥協する理由がない＝全体比較の方が単純かつ正確
/// （長さ＋先頭/末尾サンプルだけの比較だと中間部分だけの差し替えを見逃す）。
/// dir 注入でテスト可能にするため分離。
fn ensure_bytes_at(dst: &Path, bytes: &[u8]) -> Result<()> {
    let need_write = match std::fs::read(dst) {
        Ok(existing) => existing != bytes,
        Err(_) => true,
    };
    if need_write {
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(dst, bytes)?;
    }
    Ok(())
}

/// 埋め込んだ既定背景動画を config_dir 下へ冪等に展開し、その絶対パスを返す
/// （フロントは "__default__" センチネルをこのパスへ解決して asset プロトコルで再生する）。
pub fn ensure_default_bg() -> Result<PathBuf> {
    let dst = default_bg_dst();
    ensure_bytes_at(&dst, BG_DEFAULT)?;
    Ok(dst)
}

/// projects.toml を読む（read 専用＝FS を書き換えない。初回 seed は seed_defaults）。
/// 空リストは「意図的に空」として尊重、パース失敗・ファイル無しのみメモリ既定を返す。
/// 一部の [[project]] エントリが壊れていても（parse_projects_text 参照）、他の正常な
/// エントリはフォールバックさせず活かす。
pub fn load_projects() -> Vec<Project> {
    match std::fs::read_to_string(config_dir().join("projects.toml")) {
        Ok(text) => parse_projects_text(&text).unwrap_or_else(default_projects),
        Err(_) => default_projects(),
    }
}

/// projects.toml のテキストを Vec<Project> にパースし、有効なエントリだけ残す。
/// 1エントリだけ壊れていても他の正常なエントリを道連れにしないのが目的（load_projects
/// 冒頭の comment にある「1件の typo で全滅」を防ぐ）。
///
/// `toml::Value` へ一度パースしてから `[[project]]` 配列をエントリ単位で `Project` へ
/// deserialize する（構造体レベルで `toml::from_str::<ProjectsFile>` を丸ごと呼ぶと、
/// 1エントリでも型違い（例: `dir = 42`）があるだけで配列全体の deserialize が失敗し、
/// `#[serde(default)]`（フィールド欠損のみ救う）では防げない全滅が再発する＝
/// フィールド欠損・型違いのどちらでも同じように該当エントリだけスキップする）。
///
/// - TOML 自体が構文的に壊れている（Err）→ None（呼び出し側で既定にフォールバック）。
/// - `project` キーが元から無い → Some(空 Vec)（意図的な空リストとして尊重）。
/// - `project` キーはあるが配列でない（例: `[[project]]` の打ち間違いで `[project]` に
///   なっている、`project = "x"` 等）→ None（キー欠損と区別する。配列でない=壊れているのを
///   「意図的な空リスト」と誤認して黙って全滅させないため。#69 followup で発見）。
/// - 生エントリが 1 件以上あるのに有効なものが 1 件も残らない（全滅）→ None（同上。実質
///   パース不能に近い破損とみなす）。
fn parse_projects_text(text: &str) -> Option<Vec<Project>> {
    let raw = toml::from_str::<toml::Value>(text).ok()?;
    let raw_projects: Vec<toml::Value> = match raw.get("project") {
        None => Vec::new(),
        Some(v) => v.as_array()?.clone(),
    };
    let raw_count = raw_projects.len();
    let valid: Vec<Project> = raw_projects
        .into_iter()
        .filter_map(|entry| match Project::deserialize(entry) {
            Ok(p) if !p.slug.is_empty() && !p.dir.is_empty() => Some(p),
            Ok(p) => {
                eprintln!(
                    "[orb] projects.toml: slug/dir が空の [[project]] エントリをスキップします（name={:?}）",
                    p.name
                );
                None
            }
            Err(e) => {
                eprintln!("[orb] projects.toml: 壊れた [[project]] エントリをスキップします: {e}");
                None
            }
        })
        .collect();
    if raw_count > 0 && valid.is_empty() {
        None
    } else {
        Some(valid)
    }
}

fn default_projects() -> Vec<Project> {
    let p = |slug: &str, name: &str, dir: &str, dev_cwd: &str| Project {
        slug: slug.into(),
        name: name.into(),
        dir: dir.into(),
        dev_cmd: "npm run dev".into(),
        dev_cwd: dev_cwd.into(),
        label: None,
    };
    vec![
        p("plimal-ms", "PLIMAL-Ms", r"C:\Users\hiyok\PLIMAL-Ms", ""),
        p("plimal", "PLIMAL", r"C:\Users\hiyok\PLIMAL", ""),
        p(
            "ms-kintai",
            "Ms-kintai",
            r"C:\Users\hiyok\Ms-kintai-app",
            r"C:\Users\hiyok\Ms-kintai-app\frontend",
        ),
        p("creft", "CREFT", r"C:\Users\hiyok\client-creft-cojp-website", ""),
        p("dev-division", "dev-division", r"C:\Users\hiyok\dev-division-site", ""),
        p("kokoronomori", "kokoronomori", r"C:\Users\hiyok\kokoronomori-web", ""),
        p("level88", "level88", r"C:\Users\hiyok\Client-level88-site", ""),
        p(
            "mochibullet",
            "mochibullet",
            r"C:\Users\hiyok\projects\corporate-website-template-cloudflare",
            "",
        ),
        p("beat-beasts", "beat-beasts", r"C:\Users\hiyok\Desktop\beat-beasts", ""),
        p("ms-garage", "ms-garage", r"C:\Users\hiyok\projects\ms-garage-app", ""),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_bytes_writes_when_missing_and_is_content_idempotent() {
        let dir = std::env::temp_dir().join("orb-bg-ensure-test");
        let _ = std::fs::remove_dir_all(&dir);
        let dst = dir.join("bg-default.mp4");

        // 無ければ書く。
        ensure_bytes_at(&dst, b"AAAA").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"AAAA");

        // 既存かつ内容一致＝スキップ。読み取り専用にしておき、もし書き込みを試みたら
        // 失敗するはずの状態を作って、Ok が返る＝実際に書き込みが起きていないことを検証する。
        let mut perms = std::fs::metadata(&dst).unwrap().permissions();
        perms.set_readonly(true);
        std::fs::set_permissions(&dst, perms).unwrap();
        ensure_bytes_at(&dst, b"AAAA").unwrap();
        let mut perms = std::fs::metadata(&dst).unwrap().permissions();
        perms.set_readonly(false);
        std::fs::set_permissions(&dst, perms).unwrap();

        // 同じ長さでも内容が違えば再展開する（バグ修正の確認：長さだけの比較だと
        // 同サイズの差し替えを見逃していた）。
        ensure_bytes_at(&dst, b"BBBB").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"BBBB");

        // 長さが違えば当然再展開する（更新版の動画へ差し替わるケース）。
        ensure_bytes_at(&dst, b"CCCCCC").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"CCCCCC");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bundled_default_bg_is_embedded() {
        // include_bytes! で実体が埋め込まれている（空リソースを掴む事故の早期検出）。
        assert!(BG_DEFAULT.len() > 1000);
    }

    #[test]
    fn default_config_uses_bg_sentinel_and_dialed_in_values() {
        // 既定は可搬なセンチネル＋開発機で詰めた値。旧保存 config も serde default で復元される。
        let c = Config::default();
        assert_eq!(c.bg_image, DEFAULT_BG_SENTINEL);
        assert_eq!(c.bg_dim, 0.5);
        assert_eq!(c.bg_size, "cover");
        assert_eq!(c.bg_pos_x, 65.0);
        assert_eq!(c.bg_pos_y, 100.0);
        assert_eq!(c.bg_zoom, 1.0);
        assert_eq!(c.ai_accent, "#a78bfa");
    }

    #[test]
    fn parse_projects_text_keeps_valid_entries_when_one_entry_is_malformed() {
        // 2件目に dir（と slug）を欠いた壊れたエントリを混ぜる。
        // 1件の typo で全滅していた旧バグの再発防止テスト。
        let text = r#"
[[project]]
slug = "a"
name = "A"
dir = "C:/a"

[[project]]
name = "typo entry missing slug and dir"

[[project]]
slug = "b"
name = "B"
dir = "C:/b"
"#;
        let projects = parse_projects_text(text).expect("parse should succeed");
        let slugs: Vec<&str> = projects.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(slugs, vec!["a", "b"]);
    }

    #[test]
    fn parse_projects_text_respects_intentional_empty_list() {
        // [[project]] が元から無い＝意図的な空リストとして尊重（既定へフォールバックしない）。
        let projects = parse_projects_text("").expect("empty file parses to empty list");
        assert!(projects.is_empty());
    }

    #[test]
    fn parse_projects_text_falls_back_when_all_entries_are_malformed() {
        // 生エントリはあるが全部 slug/dir 欠損＝実質パース不能に近い破損として None
        // （load_projects 側で default_projects() にフォールバックする）。
        let text = r#"
[[project]]
name = "no slug or dir"
"#;
        assert!(parse_projects_text(text).is_none());
    }

    #[test]
    fn parse_projects_text_returns_none_on_unparseable_toml() {
        // TOML として構文が壊れている場合は None（フォールバック対象）。
        assert!(parse_projects_text("[[project\nslug = \"a\"").is_none());
    }

    #[test]
    fn parse_projects_text_keeps_valid_entries_when_one_entry_has_wrong_type() {
        // 2件目の dir が文字列でなく数値（型違い）。#[serde(default)] は「フィールド欠損」
        // しか救わないため、構造体レベルで toml::from_str::<ProjectsFile> を丸ごと呼ぶ実装だと
        // ここでも全滅していた（型違いは #69 followup レビューで発見された残存ギャップ）。
        let text = r#"
[[project]]
slug = "a"
name = "A"
dir = "C:/a"

[[project]]
slug = "typo"
name = "typo entry"
dir = 42

[[project]]
slug = "b"
name = "B"
dir = "C:/b"
"#;
        let projects = parse_projects_text(text).expect("parse should succeed");
        let slugs: Vec<&str> = projects.iter().map(|p| p.slug.as_str()).collect();
        assert_eq!(slugs, vec!["a", "b"]);
    }

    #[test]
    fn write_atomic_round_trips_and_leaves_no_temp_file() {
        // save→load が同じ値を復元し、成功後に .tmp が残らないことを確認する（#74 ROB-1）。
        let dir = std::env::temp_dir().join("orb-config-write-atomic-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let cfg = Config {
            font_size: 21,
            accent: "#123456".into(),
            ..Config::default()
        };
        let s = toml::to_string_pretty(&cfg).unwrap();
        write_atomic(&dir, "config.toml", &s).unwrap();

        let text = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        let loaded = parse_config_text(&text);
        assert_eq!(loaded.font_size, 21);
        assert_eq!(loaded.accent, "#123456");
        assert!(!dir.join("config.toml.tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_overwrites_existing_file_without_leaving_temp() {
        // 既存ファイルがある状態からの上書きでも rename が本体を差し替え、.tmp が残らない。
        let dir = std::env::temp_dir().join("orb-config-write-atomic-overwrite-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        write_atomic(&dir, "config.toml", "font_size = 10\n").unwrap();
        write_atomic(&dir, "config.toml", "font_size = 22\n").unwrap();

        let text = std::fs::read_to_string(dir.join("config.toml")).unwrap();
        assert!(text.contains("22"));
        assert!(!dir.join("config.toml.tmp").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_config_text_keeps_other_fields_when_one_field_has_wrong_type() {
        // font_size が型違い（文字列）でも、accent など他の正常なフィールドは維持される
        // （#74 ROB-2。旧実装は toml::from_str::<Config>(&text).unwrap_or_default() で
        // 構造体全体が失敗し、accent を含む全フィールドがデフォルトへ巻き戻っていた）。
        let text = r##"
font_size = "big"
accent = "#abcdef"
"##;
        let cfg = parse_config_text(text);
        assert_eq!(cfg.font_size, default_font_size());
        assert_eq!(cfg.accent, "#abcdef");
    }

    #[test]
    fn parse_config_text_falls_back_to_defaults_on_unparseable_toml() {
        // TOML として構文的に壊れている（toml::Value にすらならない）場合は
        // Config::default() へフォールバックする。
        let cfg = parse_config_text("accent = \"unterminated");
        assert_eq!(cfg.font_size, default_font_size());
        assert_eq!(cfg.accent, default_accent());
    }

    #[test]
    fn config_dir_with_home_falls_back_to_absolute_path_when_home_is_empty() {
        // USERPROFILE/HOME 未設定（home_dir() が空 PathBuf を返す）場合に相対パス
        // `.config\orb` へ化けない（#74 ROB-5）。常に絶対パスを返すことを確認する。
        let dir = config_dir_with_home(PathBuf::new());
        assert!(dir.is_absolute());
        assert!(dir.ends_with("orb"));
    }

    #[test]
    fn config_dir_with_home_joins_dot_config_when_home_is_set() {
        // 通常時（home が非空）の既存挙動は変えない: home/.config/orb。
        // 期待値も同じ join で組む＝区切り文字をハードコードしない。r"...\..." 直書きだと
        // Linux/macOS では `\` が区切りと認識されず 1 コンポーネント化し、コードの `/` 結合と
        // 食い違って cross-platform CI(ubuntu/macos)だけ落ちる（実際に落ちた・OS 非依存化）。
        let home = PathBuf::from(r"C:\Users\someone");
        let dir = config_dir_with_home(home.clone());
        assert_eq!(dir, home.join(".config").join("orb"));
    }

    #[test]
    fn parse_projects_text_falls_back_when_project_key_is_not_an_array() {
        // [[project]] の打ち間違いで [project]（テーブル）になっているケース。「project キー
        // が無い」＝意図的な空リストと誤認して黙って全滅させず、既定へフォールバックさせる
        // （#69 followup レビューで発見: as_array() が None を返す場合を無視すると
        // unwrap_or_default() で空 Vec に化けてしまい、キー欠損と区別できなかった）。
        assert!(parse_projects_text("[project]\nslug = \"a\"\ndir = \"C:/a\"\n").is_none());
        assert!(parse_projects_text("project = \"oops\"\n").is_none());
    }

    #[test]
    fn crew_defaults_to_two_slots() {
        let c: Config = toml::from_str("").expect("empty config parses");
        assert_eq!(c.crew.len(), 2);
        assert!(c.crew[0].sprite.is_empty());
        assert!(!c.crew[0].color.is_empty());
    }

    #[test]
    fn crew_slots_round_trip() {
        // r#"..."# だと本文中の `"#123456"` の `"#` がデリミタと衝突して早期終了する
        // （parse_config_text_keeps_other_fields_when_one_field_has_wrong_type と同じ罠）。
        // ハッシュを1つ増やして r##"..."## にする。
        let src = r##"
[[crew]]
name = "枠A"
color = "#123456"
sprite = "crew/slot0.png"
"##;
        let c: Config = toml::from_str(src).expect("parses");
        assert_eq!(c.crew.len(), 1);
        assert_eq!(c.crew[0].name, "枠A");
        assert_eq!(c.crew[0].sprite, "crew/slot0.png");
    }
}
