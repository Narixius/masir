import { isGenericTag, serverAddress } from "./label.js";
import type { ManagedOutbound } from "./types.js";

const SCORE_EXACT_REMARKS = 1000;
const SCORE_NORMALIZED_REMARKS = 800;
const SCORE_SUBSTRING_REMARKS = 600;
const SCORE_EXACT_HOST = 700;
const SCORE_EXACT_PORT = 200;
const SCORE_TAG = 500;
const SCORE_FLAG = 400;
const SCORE_PROTOCOL = 50;
const SCORE_STRUCTURE_THRESHOLD = 500;
const MIN_SUBSTRING_LENGTH = 3;

export interface ProxyMatchResult {
  readonly best: ManagedOutbound;
  readonly score: number;
  readonly isStructureUpdate: boolean;
}

const extractHost = (addr: string | undefined): string | undefined => {
  if (!addr) {
    return undefined;
  }
  const trimmed = addr.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 0 ? trimmed.slice(1, end).toLowerCase() : trimmed.toLowerCase();
  }
  const colon = trimmed.lastIndexOf(":");
  return (colon > 0 ? trimmed.slice(0, colon) : trimmed).toLowerCase();
};

const extractPort = (addr: string | undefined): number | undefined => {
  if (!addr) {
    return undefined;
  }
  const colon = addr.lastIndexOf(":");
  if (colon > 0 && colon < addr.length - 1) {
    const parsed = Number(addr.slice(colon + 1));
    return Number.isInteger(parsed) ? parsed : undefined;
  }
  return undefined;
};

const FLAG_REGEX = /[\u{1F1E6}-\u{1F1FF}]{2}/u;

const extractFlag = (text: string | undefined): string | undefined => {
  if (!text) {
    return undefined;
  }
  const match = FLAG_REGEX.exec(text);
  return match?.[0];
};

const normalizeText = (text: string | undefined): string =>
  (text ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9\u0600-\u06FF]+/giu, " ")
    .trim();

/** `inner` appears in `outer` as whole words ("us 1" is in "fast us 1" but not in "us 12"). */
const containsWords = (outer: string, inner: string): boolean =>
  inner.length >= MIN_SUBSTRING_LENGTH && ` ${outer} `.includes(` ${inner} `);

export const scoreProxyMatch = (previous: ManagedOutbound, candidate: ManagedOutbound, prevIndex: number, candIndex: number): number => {
  let score = 0;

  // 1. Remarks matching
  const prevRemarks = previous.remarks?.trim();
  const candRemarks = candidate.remarks?.trim();
  if (prevRemarks && candRemarks) {
    if (prevRemarks === candRemarks) {
      score += SCORE_EXACT_REMARKS;
    } else {
      const normPrev = normalizeText(prevRemarks);
      const normCand = normalizeText(candRemarks);
      if (normPrev.length > 0 && normPrev === normCand) {
        score += SCORE_NORMALIZED_REMARKS;
      } else if (containsWords(normCand, normPrev) || containsWords(normPrev, normCand)) {
        score += SCORE_SUBSTRING_REMARKS;
      }
    }

    const prevFlag = extractFlag(prevRemarks);
    const candFlag = extractFlag(candRemarks);
    if (prevFlag && candFlag && prevFlag === candFlag) {
      score += SCORE_FLAG;
    }
  }

  // 2. Server address matching
  const prevAddr = serverAddress(previous);
  const candAddr = serverAddress(candidate);
  const prevHost = extractHost(prevAddr);
  const candHost = extractHost(candAddr);
  if (prevHost && candHost && prevHost === candHost) {
    score += SCORE_EXACT_HOST;
    const prevPort = extractPort(prevAddr);
    const candPort = extractPort(candAddr);
    if (prevPort !== undefined && candPort !== undefined && prevPort === candPort) {
      score += SCORE_EXACT_PORT;
    }
  }

  // 3. Tag matching (if not generic)
  if (!isGenericTag(previous.tag) && !isGenericTag(candidate.tag) && previous.tag === candidate.tag) {
    score += SCORE_TAG;
  }

  // 4. Protocol matching
  if (previous.protocol === candidate.protocol) {
    score += SCORE_PROTOCOL;
  }

  // 5. Index proximity (up to 20 points)
  score += Math.max(0, 20 - Math.abs(candIndex - prevIndex));

  return score;
};

export const findClosestProxy = (
  previous: ManagedOutbound,
  candidates: readonly ManagedOutbound[],
  prevIndex = 0
): ProxyMatchResult | undefined => {
  const first = candidates[0];
  if (!first) {
    return undefined;
  }

  let best = first;
  let maxScore = -1;

  for (const [i, cand] of candidates.entries()) {
    const score = scoreProxyMatch(previous, cand, prevIndex, i);
    if (score > maxScore) {
      maxScore = score;
      best = cand;
    }
  }

  return {
    best,
    isStructureUpdate: maxScore >= SCORE_STRUCTURE_THRESHOLD,
    score: maxScore,
  };
};
