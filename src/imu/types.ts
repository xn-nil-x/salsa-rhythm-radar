/**
 * IMU integration seam (Salsa Motion Lab). Types only — not implemented in MVP 1–2.
 *
 * Intended setup: a second smartphone fixed at the lower back (sacrum, S1–S2)
 * records accelerometer + gyroscope; the music phone records audio. Both share
 * a clock via a sync event (clap / marked movement) or a network time offset.
 * Samples keep their raw timestamps; musical phase is attached afterwards and
 * never replaces the original time base.
 */

/** One raw IMU sample in device coordinates. */
export interface ImuSample {
  /** Device timestamp, seconds (monotonic clock of the IMU phone). */
  t: number;
  /** Specific force incl. gravity, m/s², device axes. */
  acc: [number, number, number];
  /** Angular velocity, rad/s, device axes. */
  gyro: [number, number, number];
  /** Orientation quaternion (w, x, y, z) if the platform provides it. */
  orientation?: [number, number, number, number];
}

/** IMU channels after orientation estimation and gravity compensation, body frame. */
export interface BodyMotionSample {
  t: number;
  /** Longitudinal (forward), lateral (side), vertical linear acceleration, m/s². */
  ax: number;
  ay: number;
  az: number;
  /** Angular velocity about the vertical axis (turns), rad/s. */
  wz: number;
}

/** Clock mapping between the IMU phone and the audio phone. */
export interface ClockSync {
  /** audioTime = imuTime * scale + offset */
  offset: number;
  scale: number;
  method: 'clap' | 'marked-movement' | 'network';
  /** Estimated residual error, seconds. */
  uncertainty: number;
}

/**
 * Movement events inferred from body motion, in the vocabulary of the dance
 * layer (Salsa Alphabet axes). `kind: 'inferred'` — a lumbar IMU does not
 * observe which foot carries the weight; weight transfer is always a hypothesis.
 */
export interface InferredMovementEvent {
  t: number;
  kind: 'inferred';
  type: 'weight-transfer' | 'direction-change' | 'turn' | 'vertical-accent';
  confidence: number;
  /** Musical phase attached after synchronisation, 0..1 of the 8-count cycle. */
  phase?: number;
}

/** Future providers: DeviceMotion API (live), CSV import (phyphox), second-phone stream. */
export interface ImuSource {
  start(onSample: (s: ImuSample) => void): Promise<void>;
  stop(): void;
}
