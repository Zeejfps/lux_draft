/**
 * Imperial formatting for the flooring panels.
 *
 * One copy, because three panels now read the same figures and two of them had already drifted
 * into two spellings of this function — one of which printed `0 3/4"` for a rip under an inch.
 */

/** 23.5 -> `23 1/2"`. A cut list is read off a tape measure, not a calculator. */
export function formatInches(value: number): string {
  const whole = Math.floor(value + 1e-9);
  const eighths = Math.round((value - whole) * 8);
  if (eighths === 0) return `${whole}"`;
  if (eighths === 8) return `${whole + 1}"`;
  const divisor = eighths % 4 === 0 ? 4 : eighths % 2 === 0 ? 2 : 1;
  return `${whole ? `${whole} ` : ''}${eighths / divisor}/${8 / divisor}"`;
}
