/** 256-entry RGBA lookup tables for the spectrogram. Index 0 = transparent (no data). */

function build(stops: Array<[number, [number, number, number]]>, alphaRamp: boolean): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let i = 1; i < 256; i++) {
    const x = (i - 1) / 254;
    let j = 0;
    while (j < stops.length - 2 && x > stops[j + 1][0]) j++;
    const [x0, c0] = stops[j];
    const [x1, c1] = stops[j + 1];
    const f = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
    lut[i * 4] = c0[0] + (c1[0] - c0[0]) * f;
    lut[i * 4 + 1] = c0[1] + (c1[1] - c0[1]) * f;
    lut[i * 4 + 2] = c0[2] + (c1[2] - c0[2]) * f;
    lut[i * 4 + 3] = alphaRamp ? Math.round(255 * Math.min(1, 0.15 + 1.2 * x)) : 255;
  }
  return lut;
}

/** Inferno-like, for dark backgrounds. */
export const INFERNO = build(
  [
    [0, [0, 0, 4]],
    [0.25, [87, 16, 110]],
    [0.5, [188, 55, 84]],
    [0.75, [249, 142, 9]],
    [1, [252, 255, 164]],
  ],
  false,
);

/** Ink on paper, like a printed sonogram, for light backgrounds. */
export const INK = build(
  [
    [0, [250, 250, 248]],
    [0.5, [120, 120, 125]],
    [1, [8, 8, 12]],
  ],
  false,
);
