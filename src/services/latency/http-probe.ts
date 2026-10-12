// One latency measurement: an HTTP GET through a local xray HTTP inbound, timed
// until the response headers arrive (v2rayN's "real delay"). That covers the
// proxy handshake, the server's own connection to the target, and its reply.
import { request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const LOCALHOST = "127.0.0.1";
const SAMPLE_TIMEOUT_MS = 5000;
const SAMPLES = 2;
const SAMPLE_GAP_MS = 100;
const HTTP_OK_MIN = 200;
const HTTP_ERROR_MIN = 400;

/**
 * Targets that answer 204 instantly over plain HTTP. Plain HTTP is enough: the
 * hop that matters (to the proxy server) is encrypted by the proxy protocol.
 */
export const PROBE_TARGETS: readonly string[] = ["http://cp.cloudflare.com/generate_204", "http://www.gstatic.com/generate_204"];

export interface Sample {
  readonly ok: boolean;
  readonly ms: number;
  readonly timedOut: boolean;
  readonly error: string;
}

const hostOf = (url: string): string => {
  const start = url.indexOf("://") + 3;
  const end = url.indexOf("/", start);
  return end === -1 ? url.slice(start) : url.slice(start, end);
};

/** Holds a timeout created after the callbacks that must clear it. */
interface TimerSlot {
  handle?: NodeJS.Timeout;
}

/** One GET of `url` through the HTTP proxy listening on `proxyPort`. Never rejects. */
export const sampleOnce = (proxyPort: number, url: string): Promise<Sample> =>
  new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    // Filled in below; `settle` must clear the timeout so it never holds the process open.
    const pendingTimer: TimerSlot = {};
    const settle = (sample: Sample): void => {
      if (!settled) {
        settled = true;
        if (pendingTimer.handle !== undefined) {
          clearTimeout(pendingTimer.handle);
        }
        resolve(sample);
      }
    };

    // Absolute-URI request line: the standard way to ask an HTTP proxy for a URL.
    const req = request(
      { headers: { Connection: "close", Host: hostOf(url) }, host: LOCALHOST, method: "GET", path: url, port: proxyPort },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        // xray's HTTP inbound answers 503 itself when the outbound fails, so
        // only a real answer from the target counts.
        if (status >= HTTP_OK_MIN && status < HTTP_ERROR_MIN) {
          settle({ error: "", ms: Date.now() - started, ok: true, timedOut: false });
        } else {
          settle({ error: `HTTP ${status}`, ms: 0, ok: false, timedOut: false });
        }
      }
    );
    pendingTimer.handle = setTimeout(() => {
      settle({ error: "timeout", ms: 0, ok: false, timedOut: true });
      req.destroy();
    }, SAMPLE_TIMEOUT_MS);
    req.on("error", (error: Error) => settle({ error: error.message, ms: 0, ok: false, timedOut: false }));
    req.end();
  });

export interface Measurement {
  readonly ok: boolean;
  readonly ms: number;
  readonly timedOut: boolean;
  readonly error: string;
}

/**
 * Best of `SAMPLES` tries against the first target; the first sample includes
 * connection setup, so the minimum is the steadier number. A failed sample
 * skips to the next target (the first may be blocked where the proxy exits),
 * and a timeout ends the measurement: a dead proxy will not answer the next
 * target either, and the user is watching a spinner.
 */
export const measureLatency = async (proxyPort: number): Promise<Measurement> => {
  let last: Sample = { error: "no target", ms: 0, ok: false, timedOut: false };
  for (const url of PROBE_TARGETS) {
    let best: number | null = null;
    for (let i = 0; i < SAMPLES; i += 1) {
      if (i > 0) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await sleep(SAMPLE_GAP_MS);
      }
      // oxlint-disable-next-line eslint/no-await-in-loop
      const sample = await sampleOnce(proxyPort, url);
      last = sample;
      if (sample.ok && (best === null || sample.ms < best)) {
        best = sample.ms;
      }
      // A second sample only refines a success; after a failure move on.
      if (!sample.ok) {
        break;
      }
    }
    if (best !== null) {
      return { error: "", ms: best, ok: true, timedOut: false };
    }
    if (last.timedOut) {
      break;
    }
  }
  return { error: last.error, ms: 0, ok: false, timedOut: last.timedOut };
};
