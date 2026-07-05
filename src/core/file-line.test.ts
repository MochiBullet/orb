import { describe, it, expect } from "vitest";
import { matchFileLine } from "./file-line";

const tokens = (text: string) => matchFileLine(text).map((m) => m.token);

describe("matchFileLine (#37/#Theme-F: file:line 検出・URL 権威部の誤検知除外)", () => {
  it("素の path/file.ext:line を検出（token と index）", () => {
    const text = "  at src/foo.ts:42 in build";
    const [m] = matchFileLine(text);
    expect(m.token).toBe("src/foo.ts:42");
    expect(m.index).toBe(text.indexOf("src/foo.ts:42"));
  });

  it("line:col 形も検出", () => {
    expect(tokens("error app/main.rs:120:5 here")).toEqual(["app/main.rs:120:5"]);
  });

  it("Windows パス区切り(\\)も検出（ディレクトリ接頭辞ごと拾う）", () => {
    // 先頭の `C:` はドライブ指定でマッチ対象外（: が [\w.\-] 外）＝`proj\lib.ts:7` から拾う。
    expect(tokens("C:\\proj\\lib.ts:7 ok")).toEqual(["proj\\lib.ts:7"]);
  });

  it("#Theme-F: スキーム付き URL の host:port は除外（http://app.example.com:8080/x）", () => {
    expect(tokens("open http://app.example.com:8080/x now")).toEqual([]);
  });

  it("#Theme-F: https でも除外", () => {
    expect(tokens("see https://api.service.io:3000/v1 here")).toEqual([]);
  });

  it("#Theme-F: プロトコル相対 //host.tld:port/ も TLD+スラッシュで除外", () => {
    expect(tokens("//cdn.example.net:9000/a.js")).toEqual([]);
  });

  it("#Theme-F: 既知 TLD でも直後がスラッシュでなければ file:line として残す（取りこぼし防止）", () => {
    // command.com:12（末尾・スラッシュ無し）は実ファイル参照として扱う。
    expect(tokens("command.com:12")).toEqual(["command.com:12"]);
  });

  it("#Theme-F: URL 混在行でも実ファイルの file:line は拾い、URL 権威部だけ落とす", () => {
    const text = "GET http://host.com:8080/p failed at src/net.ts:88";
    expect(tokens(text)).toEqual(["src/net.ts:88"]);
  });

  it("非拡張子的な host（TLD 非該当・スラッシュ無し）は元々マッチ対象＝そのまま", () => {
    // localhost:3000 は拡張子(.ext)を持たないので FILE_LINE_RE 自体が拾わない。
    expect(tokens("serving localhost:3000")).toEqual([]);
  });

  it("複数の file:line を検出", () => {
    expect(tokens("a/x.ts:1 and b/y.js:2")).toEqual(["a/x.ts:1", "b/y.js:2"]);
  });
});
