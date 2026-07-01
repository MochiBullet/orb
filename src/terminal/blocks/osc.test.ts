import { describe, it, expect } from "vitest";
import { parseExitCode, parseOsc9, parseOsc777 } from "./osc";

describe("parseExitCode (#41: no false success/failure)", () => {
  it('empty rest (D missing / Ctrl-C) => -1 (unknown/aborted, NOT success)', () => {
    expect(parseExitCode("")).toBe(-1);
  });

  it('"0" => 0 (CRITICAL: real success MUST stay 0, not -1)', () => {
    expect(parseExitCode("0")).toBe(0);
  });

  it('"1" => 1 (failure preserved)', () => {
    expect(parseExitCode("1")).toBe(1);
  });

  it('"137" => 137 (SIGKILL-style exit preserved)', () => {
    expect(parseExitCode("137")).toBe(137);
  });

  it('"garbage" => -1 (non-numeric payload is unknown, NOT success)', () => {
    expect(parseExitCode("garbage")).toBe(-1);
  });

  it('"0;extra" => 0 (success with trailing params stays 0)', () => {
    expect(parseExitCode("0;extra")).toBe(0);
  });

  it('";x" (leading semicolon) => -1 (empty code field is unknown)', () => {
    expect(parseExitCode(";x")).toBe(-1);
  });
});

describe("parseOsc9 (#32: iTerm2-style OSC 9 notification)", () => {
  it("plain message => body", () => {
    expect(parseOsc9("Build finished")).toBe("Build finished");
  });

  it("trims surrounding whitespace", () => {
    expect(parseOsc9("  done  ")).toBe("done");
  });

  it("empty => null (nothing to notify)", () => {
    expect(parseOsc9("")).toBeNull();
  });

  it("ConEmu progress (4;...) => null (not a notification)", () => {
    expect(parseOsc9("4;50")).toBeNull();
  });

  it("ConEmu numeric subcommand (1;C:\\path) => null", () => {
    expect(parseOsc9("1;C:\\path")).toBeNull();
  });

  it("message that merely contains a digit is kept", () => {
    expect(parseOsc9("Test 3 passed")).toBe("Test 3 passed");
  });
});

describe("parseOsc777 (#32: OSC 777;notify;title;body)", () => {
  it("full notify => title + body", () => {
    expect(parseOsc777("notify;Claude;Task complete")).toEqual({
      title: "Claude",
      body: "Task complete",
    });
  });

  it("missing body => empty body, title kept", () => {
    expect(parseOsc777("notify;Claude")).toEqual({ title: "Claude", body: "" });
  });

  it("missing title => 'orb' fallback", () => {
    expect(parseOsc777("notify;;just a body")).toEqual({ title: "orb", body: "just a body" });
  });

  it("body containing semicolons is preserved", () => {
    expect(parseOsc777("notify;T;a;b;c")).toEqual({ title: "T", body: "a;b;c" });
  });

  it("non-notify subcommand => null (ignored)", () => {
    expect(parseOsc777("something;else")).toBeNull();
  });

  it("notify with no title and no body => null (no info)", () => {
    expect(parseOsc777("notify;;")).toBeNull();
    expect(parseOsc777("notify")).toBeNull();
  });
});
