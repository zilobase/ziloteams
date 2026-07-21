import { EventEmitter } from "node:events";
import { stdin, stdout } from "node:process";

type MouseMode = { mouse?: "button" } | false;

class NativeTerminal extends EventEmitter {
  private inputBuffer = "";
  private listening = false;
  private escapeTimer?: NodeJS.Timeout;

  get width(): number {
    return stdout.columns ?? 80;
  }

  get height(): number {
    return stdout.rows ?? 24;
  }

  readonly write = (value: string): void => {
    stdout.write(value);
  };

  readonly hideCursor = (hidden: boolean): void => {
    stdout.write(hidden ? "\x1b[?25l" : "\x1b[?25h");
  };

  readonly showCursor = (): void => {
    stdout.write("\x1b[?25h");
  };

  readonly clear = (): void => {
    stdout.write("\x1b[2J\x1b[H");
  };

  readonly moveTo = (x: number, y: number): void => {
    stdout.write(`\x1b[${y};${x}H`);
  };

  readonly grabInput = (mode: MouseMode): void => {
    if (mode === false) {
      if (!this.listening) return;
      this.listening = false;
      stdin.off("data", this.onData);
      stdout.off("resize", this.onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdout.write("\x1b[?1000l\x1b[?1006l");
      return;
    }

    if (this.listening) return;
    this.listening = true;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", this.onData);
    stdout.on("resize", this.onResize);
    if (mode.mouse === "button") stdout.write("\x1b[?1000h\x1b[?1006h");
  };

  private readonly onResize = (): void => {
    this.emit("resize", "RESIZE");
  };

  private readonly onData = (chunk: string | Buffer): void => {
    this.inputBuffer += chunk.toString();
    this.parseInput();
  };

  private parseInput(): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer);
      this.escapeTimer = undefined;
    }

    while (this.inputBuffer.length > 0) {
      const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(this.inputBuffer);
      if (mouse) {
        this.inputBuffer = this.inputBuffer.slice(mouse[0].length);
        if (mouse[1] === "0" && mouse[4] === "M") {
          this.emit("mouse", "MOUSE_LEFT_BUTTON_PRESSED", {
            x: Number(mouse[2]),
            y: Number(mouse[3])
          });
        }
        continue;
      }

      const keys: Array<[string, string]> = [
        ["\x1b[A", "UP"], ["\x1b[B", "DOWN"], ["\x1b[C", "RIGHT"], ["\x1b[D", "LEFT"]
      ];
      const key = keys.find(([sequence]) => this.inputBuffer.startsWith(sequence));
      if (key) {
        this.inputBuffer = this.inputBuffer.slice(key[0].length);
        this.emit("key", key[1], undefined, {});
        continue;
      }

      if (this.inputBuffer === "\x1b" || this.inputBuffer.startsWith("\x1b[") && this.inputBuffer.length < 3) {
        this.escapeTimer = setTimeout(() => {
          this.escapeTimer = undefined;
          if (this.inputBuffer.startsWith("\x1b")) {
            this.inputBuffer = this.inputBuffer.slice(1);
            this.emit("key", "ESCAPE", undefined, {});
            this.parseInput();
          }
        }, 30);
        return;
      }

      const first = Array.from(this.inputBuffer)[0] ?? "";
      this.inputBuffer = this.inputBuffer.slice(first.length);
      if (first === "\u0003") this.emit("key", "CTRL_C", undefined, {});
      else if (first === "\r" || first === "\n") this.emit("key", "ENTER", undefined, {});
      else if (first === "\u007f" || first === "\b") this.emit("key", "BACKSPACE", undefined, {});
      else if (first >= " ") this.emit("key", first, undefined, { isCharacter: true });
    }
  }
}

export const terminal = new NativeTerminal();
