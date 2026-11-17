export {};

import { tooltipShift } from "./tooltipShift";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

const WIDTH = 100;
const VIEWPORT = 1200;
const MARGIN = 8;

/* A centred tooltip that fits needs no shift. */
equal(tooltipShift("top", 600, WIDTH, VIEWPORT, MARGIN), 0, "a fitting tooltip is not nudged");

/* Centred above a trigger near the right edge: pushed back by exactly the overhang. */
equal(tooltipShift("top", 1150, WIDTH, VIEWPORT, MARGIN), -8, "a right-edge overhang is undone");

/* Centred above a trigger near the left edge. */
equal(tooltipShift("bottom", 40, WIDTH, VIEWPORT, MARGIN), 18, "a left-edge overhang is undone");

/* `left` places the tooltip's right edge on the anchor, `right` its left edge. */
equal(tooltipShift("left", 60, WIDTH, VIEWPORT, MARGIN), 48, "a left-side tooltip clears the edge");
equal(tooltipShift("right", 1160, WIDTH, VIEWPORT, MARGIN), -68, "a right-side tooltip clears the edge");

/*
 * The correction is a pure function of the anchor and width, so re-running it against the
 * corrected box is a no-op — the property the rect-feedback version lacked.
 */
const shift = tooltipShift("top", 1150, WIDTH, VIEWPORT, MARGIN);
equal(tooltipShift("top", 1150, WIDTH, VIEWPORT, MARGIN), shift, "the correction is stable");

/*
 * Fractional geometry is where the old version never settled: the webview quantizes the
 * applied translate, so re-measuring the shifted box produced a slightly different overhang
 * on every pass. The unshifted input settles on the first pass.
 */
let passes = 0;
let applied = 0;
for (; passes < 50; passes += 1) {
  const next = tooltipShift("top", 1150.3, 100.7, VIEWPORT, MARGIN);
  if (next === applied) break;
  applied = next;
}
check(passes <= 1, "a fractional tooltip settles on the first pass");

console.log("tooltipShift: ok");
