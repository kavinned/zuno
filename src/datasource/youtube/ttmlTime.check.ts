import { parseTtmlTime } from "./ttmlTime";

export {};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`FAILED: ${message}`);
}

function equal(actual: unknown, expected: unknown, message: string): void {
  check(actual === expected, `${message}: expected ${String(expected)}, got ${String(actual)}`);
}

/* lrc.red emits bare decimal seconds; this is the form that made every line drop. */
equal(parseTtmlTime("19.764"), 19.764, "bare decimal seconds parse");
equal(parseTtmlTime("0.200"), 0.2, "a sub-second offset parses");
equal(parseTtmlTime("20"), 20, "bare whole seconds parse");

/* The forms BetterLyrics already used must keep working. */
equal(parseTtmlTime("00:00:19.764"), 19.764, "clock time still parses");
equal(parseTtmlTime("1:02.5"), 62.5, "minute clock time still parses");
equal(parseTtmlTime("250ms"), 0.25, "the metric offset form still parses");
equal(parseTtmlTime("1.5s"), 1.5, "seconds with a suffix still parse");

equal(parseTtmlTime(null), undefined, "missing time is undefined");
equal(parseTtmlTime(""), undefined, "an empty time is undefined");
equal(parseTtmlTime("not a time"), undefined, "garbage is undefined");
equal(parseTtmlTime("1.2.3"), undefined, "a malformed decimal is rejected");

console.log("ttmlTime self-check passed");
