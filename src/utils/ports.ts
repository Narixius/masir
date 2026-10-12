import { createServer } from "node:http";
import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const LOCALHOST = "127.0.0.1";
const PORT_MAX = 65_535;
/** Ephemeral-ish range for throwaway listeners (probe inbounds). */
const SCAN_BASE_MIN = 20_000;
const SCAN_BASE_SPAN = 20_000;
const WAIT_POLL_MS = 50;

export const isPortFree = (port: number, host = LOCALHOST): Promise<boolean> =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });

/** The first free port in `[initialPort, initialPort + count)`. */
export const getFreePort = async (initialPort: number, host = LOCALHOST, count = 50): Promise<number> => {
  const ports: number[] = [];
  for (let port = initialPort; port < initialPort + count && port <= PORT_MAX; port += 1) {
    ports.push(port);
  }
  const results = await Promise.all(ports.map((p) => isPortFree(p, host)));
  const index = results.indexOf(true);
  if (index === -1) {
    throw new Error("no free port in range");
  }
  return ports[index] as number;
};

/** `count` distinct free localhost ports, scanned from a random base so concurrent callers rarely collide. */
export const findFreePorts = async (count: number): Promise<number[]> => {
  const found: number[] = [];
  let port = SCAN_BASE_MIN + Math.floor(Math.random() * SCAN_BASE_SPAN);
  while (found.length < count) {
    if (port > PORT_MAX) {
      throw new Error(`could not find ${count} free ports`);
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (await isPortFree(port)) {
      found.push(port);
    }
    port += 1;
  }
  return found;
};

const canConnect = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: LOCALHOST, port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Resolve `true` once something accepts connections on `port`, `false` after `timeoutMs`. */
export const waitForPort = async (port: number, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    if (await canConnect(port)) {
      return true;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop
    await sleep(WAIT_POLL_MS);
  }
  return false;
};
