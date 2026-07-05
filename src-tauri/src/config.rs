use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 案件ランチャー1件分。warp の gen-warp-launch-configs.ps1 の $projects に対応。
#[derive(Serialize, Deserialize, Clone)]
pub struct Project {
    pub slug: String,
    pub name: String,
    pub dir: String,
    #[serde(default)]
    pub dev_cmd: String,
    /// モノレポ等で dev サーバの cwd が dir と異なる場合のみ。空なら dir を使う。
    #[serde(default)]
    pub dev_cwd: String,
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
}

impl Default for Config {
    fn default() -> Self {
        Config {
            font_size: default_font_size(),
            font_family: default_font_family(),
            scrollback: default_scrollback(),
            accent: default_accent(),
            ligatures: default_ligatures(),
            bg_image: default_bg_image(),
            bg_dim: default_bg_dim(),
            bg_size: default_bg_size(),
            bg_pos_x: default_bg_pos_x(),
            bg_pos_y: default_bg_pos_y(),
            bg_zoom: default_bg_zoom(),
            show_info_on_startup: default_show_info_on_startup(),
        }
    }
}

/// config.toml を書き出す（設定GUI からの保存）。
pub fn save_config(cfg: &Config) -> Result<()> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir)?;
    let s = toml::to_string_pretty(cfg).map_err(|e| AppError::Config(e.to_string()))?;
    std::fs::write(dir.join("config.toml"), s)?;
    Ok(())
}

/// config.toml を読む（read 専用＝FS を書き換えない。初回の書き出しは seed_defaults）。
pub fn load_config() -> Config {
    match std::fs::read_to_string(config_dir().join("config.toml")) {
        Ok(text) => toml::from_str::<Config>(&text).unwrap_or_default(),
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
            let _ = std::fs::write(pp, s);
        }
    }
    let cp = dir.join("config.toml");
    if !cp.exists() {
        if let Ok(s) = toml::to_string_pretty(&Config::default()) {
            let _ = std::fs::write(cp, s);
        }
    }
}

/// $XDG_CONFIG_HOME/orb（未設定なら ~/.config/orb）。
/// blocks.rs（#31 耐久ログ）も同じ基準ディレクトリを使うため pub(crate)。
pub(crate) fn config_dir() -> PathBuf {
    if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
        return PathBuf::from(x).join("orb");
    }
    crate::status::home_dir().join(".config").join("orb")
}

/// 既定背景動画をバイナリへ埋め込む（shell-integration.ps1 と同じ方針＝Tauri の
/// bundle.resources ではなく include_bytes! で実体を持ち、dev/本番でパス解決の差を無くす）。
/// ただし shell スクリプトは毎回 temp へ捨てる transient なのに対し、bg_image は config.toml に
/// 永続化されるパス文字列なので、毎回ランダムパスへ展開すると再起動で保存パスが陳腐化する。
/// そのため config_dir 下の固定パスへ「既存かつ同サイズならスキップ」する冪等展開にする。
const BG_DEFAULT: &[u8] = include_bytes!("../resources/bg-default.mp4");

/// 既定背景動画の展開先（config_dir 下の固定名＝決定的・再起動後も同じパス）。
fn default_bg_dst() -> PathBuf {
    config_dir().join("bg-default.mp4")
}

/// バイト列を dst へ冪等に書く。既存かつサイズ一致ならスキップ（バイナリ更新で動画が
/// 差し替われば長さ差で再展開＝古い動画が残らない）。dir 注入でテスト可能にするため分離。
fn ensure_bytes_at(dst: &Path, bytes: &[u8]) -> Result<()> {
    let need_write = match std::fs::metadata(dst) {
        Ok(m) => m.len() != bytes.len() as u64,
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
pub fn load_projects() -> Vec<Project> {
    match std::fs::read_to_string(config_dir().join("projects.toml")) {
        Ok(text) => match toml::from_str::<ProjectsFile>(&text) {
            Ok(pf) => pf.project,
            Err(_) => default_projects(),
        },
        Err(_) => default_projects(),
    }
}

fn default_projects() -> Vec<Project> {
    let p = |slug: &str, name: &str, dir: &str, dev_cwd: &str| Project {
        slug: slug.into(),
        name: name.into(),
        dir: dir.into(),
        dev_cmd: "npm run dev".into(),
        dev_cwd: dev_cwd.into(),
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
    fn ensure_bytes_writes_when_missing_and_is_size_idempotent() {
        let dir = std::env::temp_dir().join("orb-bg-ensure-test");
        let _ = std::fs::remove_dir_all(&dir);
        let dst = dir.join("bg-default.mp4");

        // 無ければ書く。
        ensure_bytes_at(&dst, b"AAAA").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"AAAA");

        // 既存かつ同サイズ＝スキップ（同サイズ・別内容を置き、書き換わらないことで冪等を検証）。
        std::fs::write(&dst, b"BBBB").unwrap();
        ensure_bytes_at(&dst, b"AAAA").unwrap();
        assert_eq!(std::fs::read(&dst).unwrap(), b"BBBB");

        // サイズが違えば再展開（更新版の動画へ差し替わるケース）。
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
    }
}
