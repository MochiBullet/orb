import { invoke, Channel } from "@tauri-apps/api/core";

/**
 * 1 ペイン分の PTY をフロントから操作するクライアント。
 * Rust の spawn_pty / write_pty / resize_pty / close_pty に橋渡しする。
 *
 * 出力は Tauri のバイナリ Channel（Rust 側は InvokeResponseBody::Raw を送る）。
 * 受信は ArrayBuffer なので Uint8Array に直して term.write へ流す。
 */
export class PtyClient {
  private channel: Channel<ArrayBuffer> | null = null;

  constructor(public readonly paneId: number) {}

  async spawn(
    cols: number,
    rows: number,
    onData: (bytes: Uint8Array) => void,
    initialCmd?: string,
  ): Promise<void> {
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (msg) => onData(new Uint8Array(msg));
    this.channel = channel;
    await invoke("spawn_pty", {
      paneId: this.paneId,
      cols,
      rows,
      onOutput: channel,
      initialCmd: initialCmd ?? null,
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
