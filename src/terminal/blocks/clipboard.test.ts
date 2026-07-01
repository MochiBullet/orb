import { describe, it, expect, vi } from "vitest";
import type { ClipboardSelectionType } from "@xterm/addon-clipboard";
import { orbClipboardProvider } from "./clipboard";

const C = "c" as ClipboardSelectionType; // SYSTEM clipboard

describe("orbClipboardProvider (#35: OSC 52 default-deny read)", () => {
  it("readText は常に空文字を返す（OS クリップボード読み出しを許さない）", () => {
    expect(orbClipboardProvider.readText(C)).toBe("");
    expect(orbClipboardProvider.readText("p" as ClipboardSelectionType)).toBe("");
  });

  it("writeText は OS クリップボード（navigator.clipboard）へ転送する", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await orbClipboardProvider.writeText(C, "hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    vi.unstubAllGlobals();
  });
});
