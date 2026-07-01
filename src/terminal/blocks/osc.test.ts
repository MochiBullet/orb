import { describe, it, expect } from "vitest";
import { parseExitCode } from "./osc";

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
