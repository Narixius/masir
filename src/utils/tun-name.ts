// macOS only accepts TUN interfaces named `utunN`. Older xray releases default
// to `xray0` there and fail to start, so masir names the interface itself.
import { spawnSync } from "node:child_process";

const FIRST_UTUN = 9;
const MAX_UTUN = 255;

/** The interfaces that exist now (`ifconfig -l`); empty if that can't be read. */
const existingInterfaces = (): Set<string> => {
  const listed = spawnSync("/sbin/ifconfig", ["-l"], { encoding: "utf-8" });
  const text = listed.status === 0 ? String(listed.stdout) : "";
  return new Set(text.split(/\s+/u).filter((name) => name.length > 0));
};

/** A free `utunN` on macOS; `undefined` elsewhere (xray's default name is fine on Linux). */
export const tunInterfaceName = (): string | undefined => {
  if (process.platform !== "darwin") {
    return undefined;
  }
  const used = existingInterfaces();
  for (let n = FIRST_UTUN; n <= MAX_UTUN; n += 1) {
    const name = `utun${n}`;
    if (!used.has(name)) {
      return name;
    }
  }
  return `utun${MAX_UTUN}`;
};
