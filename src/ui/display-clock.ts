/**
 * Musical time as displayed (smoothed), shared between the dial and other
 * animated views. Written by the dial's animation loop every frame; read by
 * other rAF loops without going through React state.
 */
export const displayClock = {
  /** Cycle beats (includes the count-1 offset): count 1 at multiples of 8. */
  beats: 0,
  running: false,
};
