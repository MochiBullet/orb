import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * 1 ペイン分の PTY をフロントから操作するクライアント。
 * Rust の spawn_pty / write_pty / resize_pty / close_pty に橋渡しする。
 *
 * 出力は Tauri Channel 経由（Rust は生バイトを送る）。受信側は Uint8Array に
 * 直して term.write へ流すことで、マルチバイト UTF-8 の分断による化けを防ぐ。
 */
export class PtyClient {
  private channel: Channel<number[]> | null = null;

  constructor(public readonly paneId: number) {}

  async spawn(
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
  ): Promise<void> {
    const channel = new Channel<number[]>();
    channel.onmessage = (msg) => onData(Uint8Array.from(msg));
    this.channel = channel;
    await invoke("spawn_pty", {
      paneId: this.paneId,
      cols,
      rows,
      onOutput: channel,
    });
  }

  write(data: Uint8Array): Promise<void> {
    return invoke("write_pty", { paneId: this.paneId, data: Array.from(data) });
  }

  resize(cols: number, rows: number): Promise<void> {
    return invoke("resize_pty", { paneId: this.paneId, cols, rows });
  }

  close(): Promise<void> {
    this.channel = null;
    return invoke("close_pty", { paneId: this.paneId });
  }
}
