import fs from "node:fs";
import OpusScript from "opusscript";
import { SAMPLE_RATE, CHANNELS, FRAME_SAMPLES, FRAME_BYTES } from "./tts.js";

const BITRATE = 64000; // speech-sized; announcements are short

let encoder: OpusScript | null = null;

function getEncoder(): OpusScript {
  if (!encoder) {
    encoder = new OpusScript(SAMPLE_RATE, CHANNELS, OpusScript.Application.AUDIO);
    encoder.setBitrate(BITRATE);
    const OPUS_SET_VBR = 4006;
    encoder.encoderCTL(OPUS_SET_VBR, 0); // CBR: steadier pacing on a 1-vCPU box
  }
  return encoder;
}

/**
 * Scale 16-bit samples in place. Applied here rather than while rendering the
 * PCM, so the on-disk cache stays volume-independent: changing the volume
 * re-encodes from the same PCM instead of re-running ffmpeg and piper.
 */
function applyGain(buf: Buffer, gain: number): Buffer {
  if (gain === 1) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let v = Math.round(buf.readInt16LE(i) * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out.writeInt16LE(v, i);
  }
  return out;
}

/**
 * Encode a raw PCM file into ready-to-send 20 ms Opus frames.
 * `gain` of 1 is the file as recorded; 0.5 is half amplitude.
 */
export function encodePcmFile(pcmPath: string, gain = 1): Buffer[] {
  const pcm = applyGain(fs.readFileSync(pcmPath), gain);
  const enc = getEncoder();
  const frames: Buffer[] = [];

  for (let off = 0; off + FRAME_BYTES <= pcm.length; off += FRAME_BYTES) {
    frames.push(enc.encode(pcm.subarray(off, off + FRAME_BYTES), FRAME_SAMPLES) as Buffer);
  }

  // Pad the trailing partial frame with silence rather than clipping the word.
  const rest = pcm.length % FRAME_BYTES;
  if (rest > 0) {
    const last = Buffer.alloc(FRAME_BYTES);
    pcm.subarray(pcm.length - rest).copy(last);
    frames.push(enc.encode(last, FRAME_SAMPLES) as Buffer);
  }
  return frames;
}

/** Loudest sample in a rendered PCM file, as a fraction of full scale. */
export function peakOf(pcmPath: string, gain = 1): number {
  const pcm = fs.readFileSync(pcmPath);
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(pcm.readInt16LE(i));
    if (v > peak) peak = v;
  }
  return Math.min(1, (peak * gain) / 32767);
}
