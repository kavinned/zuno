/**
 * Self-check for useChunkedList chunk sizing and increment logic.
 */
export {};

import {
  DEFAULT_CHUNK_INCREMENT,
  DEFAULT_INITIAL_CHUNK,
  getNextChunkCount,
} from "./useChunkedList";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

// 1. Initial chunk constants are sensible
equal(DEFAULT_INITIAL_CHUNK, 60, "default initial chunk is 60");
equal(DEFAULT_CHUNK_INCREMENT, 40, "default chunk increment is 40");

// 2. Increments within bounds
const step1 = getNextChunkCount(60, 40, 200);
equal(step1, 100, "increments 60 by 40 to 100");

const step2 = getNextChunkCount(100, 40, 200);
equal(step2, 140, "increments 100 by 40 to 140");

// 3. Clamping at upper bound (total items)
const clamped = getNextChunkCount(180, 40, 200);
equal(clamped, 200, "clamps to total items when increment exceeds total");

const alreadyAtTotal = getNextChunkCount(200, 40, 200);
equal(alreadyAtTotal, 200, "stays at total if already at or beyond total");

// 4. Clamping when total is smaller than initial chunk
const smallTotal = getNextChunkCount(0, 60, 15);
equal(smallTotal, 15, "clamps initial count to small total");

// 5. Empty total
const empty = getNextChunkCount(0, 40, 0);
equal(empty, 0, "handles zero total");
