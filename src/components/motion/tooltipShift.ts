export type TooltipShiftSide = "top" | "right" | "bottom" | "left";

/**
 * Horizontal nudge that keeps a tooltip inside the window (#183).
 *
 * Derived from the unshifted box — the anchor point and the measured width — never from the
 * shifted rect. Feeding the applied `translateX` back into its own measurement made the
 * correction a fixed-point search: once the webview quantized the translation, each pass
 * measured a slightly different overhang and React reported "Maximum update depth exceeded".
 */
export function tooltipShift(
  side: TooltipShiftSide,
  anchorLeft: number,
  width: number,
  viewportWidth: number,
  margin: number,
): number {
  const left = side === "right"
    ? anchorLeft
    : side === "left"
      ? anchorLeft - width
      : anchorLeft - width / 2;
  const right = left + width;
  const maxRight = viewportWidth - margin;
  if (right > maxRight) return maxRight - right;
  if (left < margin) return margin - left;
  return 0;
}
