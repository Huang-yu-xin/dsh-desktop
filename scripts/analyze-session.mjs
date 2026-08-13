// Reads a DeepSeek Harness session artifact (concatenated checksummed zstd
// frames, one per durable batch) and prints a verification-oriented summary.
// Port of the official structural frame scan (session-persistence-jsonl/zstd.ts).
import fs from 'node:fs';
import zlib from 'node:zlib';

const ZSTD_MAGIC = 0xFD2FB528;

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

export function readSessionEvents(filePath) {
  const buf = fs.readFileSync(filePath);
  const { frames } = scanZstdFrames(buf);
  const texts = frames.map((f) => zlib.zstdDecompressSync(buf.subarray(f.start, f.end)).toString('utf8'));
  const lines = texts.join('\n').split('\n').filter((l) => l.trim().length > 0);
  return { events: lines.map((l) => JSON.parse(l)), frameCount: frames.length };
}

function summarize(events) {
  const types = {};
  for (const e of events) types[e.type ?? '(none)'] = (types[e.type ?? '(none)'] ?? 0) + 1;
  return types;
}

function toolLike(e) {
  return typeof e.data?.name === 'string' ? e.data.name : null;
}

function main() {
  const file = process.argv[2];
  const mode = process.argv[3] ?? 'types';
  const { events, frameCount } = readSessionEvents(file);
  if (mode === 'types') {
    console.log(`frames=${frameCount} events=${events.length}`);
    console.log('type histogram:');
    for (const [k, v] of Object.entries(summarize(events))) console.log(`  ${k}: ${v}`);
  } else if (mode === 'tools') {
    const seen = [];
    for (const e of events) {
      const t = toolLike(e);
      if (t && !seen.includes(t)) seen.push(t);
    }
    console.log('tool names used:', JSON.stringify(seen));
    console.log('--- sample tool events (first 2, 600 chars) ---');
    let n = 0;
    for (const e of events) {
      if (toolLike(e) && n < 2) {
        console.log(JSON.stringify(e).slice(0, 600));
        n += 1;
      }
    }
  } else if (mode === 'assistant') {
    // Concatenate assistant text deltas from the final portion of the log.
    const parts = [];
    for (const e of events) {
      const text = e.text ?? e.delta?.text ?? e.content?.text ?? e.content;
      if (typeof text === 'string' && (e.type?.includes('assistant') || e.role === 'assistant')) parts.push(text);
    }
    console.log(parts.join('').slice(0, 4000));
  }
}

// Only run the CLI when executed directly (never when imported by the driver).
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
