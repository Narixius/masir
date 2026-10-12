import pc from "picocolors";

export interface SpinnerInstance {
  readonly clear: () => void;
  readonly error: (msg?: string) => void;
  readonly message: (msg: string) => void;
  readonly start: (msg: string) => void;
  readonly stop: (msg?: string) => void;
}

export const createSpinner = (): SpinnerInstance => {
  const frames = ["◒", "◐", "◓", "◑"];
  let timer: NodeJS.Timeout | undefined;
  let frameIdx = 0;
  let currentMsg = "";

  const render = (): void => {
    if (process.stdout.isTTY) {
      process.stdout.write(`\r${pc.cyan(frames[frameIdx])}  ${currentMsg}`);
    }
  };

  return {
    clear(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (process.stdout.isTTY) {
        process.stdout.write("\r\u001B[2K");
      }
    },
    error(msg: string | undefined): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      const finalMsg = msg ?? currentMsg;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${pc.red("■")}  ${finalMsg}\n`);
      } else {
        console.log(`■  ${finalMsg}`);
      }
    },
    message(msg: string): void {
      currentMsg = msg;
      if (!process.stdout.isTTY) {
        console.log(`●  ${currentMsg}`);
      }
    },
    start(msg: string): void {
      currentMsg = msg;
      if (process.stdout.isTTY) {
        render();
        timer = setInterval(() => {
          frameIdx = (frameIdx + 1) % frames.length;
          render();
        }, 80);
      } else {
        console.log(`│\n●  ${currentMsg}`);
      }
    },
    stop(msg: string | undefined): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      const finalMsg = msg ?? currentMsg;
      if (process.stdout.isTTY) {
        process.stdout.write(`\r${pc.green("◇")}  ${finalMsg}\n`);
      } else {
        console.log(`◇  ${finalMsg}`);
      }
    },
  };
};
