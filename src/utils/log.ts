import pc from "picocolors";

const bar = pc.gray("│");

export const log = {
  message: (msg = ""): void => {
    console.log(`${bar}  ${msg}`);
  },
  info: (msg = ""): void => {
    console.log(`${bar}\n${pc.blue("●")}  ${msg}`);
  },
  success: (msg = ""): void => {
    console.log(`${bar}\n${pc.green("◆")}  ${msg}`);
  },
  step: (msg = ""): void => {
    console.log(`${bar}\n${pc.green("◇")}  ${msg}`);
  },
  warn: (msg = ""): void => {
    console.log(`${bar}\n${pc.yellow("▲")}  ${msg}`);
  },
  error: (msg = ""): void => {
    console.log(`${bar}\n${pc.red("■")}  ${msg}`);
  },
};

export const note = (message = "", title = ""): void => {
  const titleLine = title ? ` ${title} ` : "";
  const lineWidth = Math.max(0, 52 - titleLine.length);
  const border = "─".repeat(lineWidth);
  console.log(bar);
  console.log(`${pc.green("◇")} ${titleLine}${pc.gray(border)}╮`);
  console.log(`${bar}                                                       │`);
  for (const line of message.split("\n")) {
    console.log(`${bar}  ${line}`);
  }
  console.log(`${bar}                                                       │`);
  console.log(`${pc.gray(`├${"─".repeat(55)}╯`)}`);
};
