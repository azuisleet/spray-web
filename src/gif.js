/**
 * GIF decoder: frames come out fully composited (disposal and transparency applied) as
 * unpremultiplied RGBA at the full canvas size.
 *
 * Parsing the block structure up front is cheap and gives every frame's delay without
 * decoding any pixels, so frame selection can happen before the expensive part.
 *
 * https://www.w3.org/Graphics/GIF/spec-gif89a.txt
 */

const disposeToBackground = 2;
const disposeToPrevious = 3;

// Browsers show delays of 0 or 1 centisecond as 10, and GIFs are authored against that.
const minimumDelay = 2;
const substituteDelay = 10;

function readPalette(bytes, offset, entries) {
    return bytes.subarray(offset, offset + entries * 3);
}

function skipSubBlocks(bytes, offset) {
    while (offset < bytes.length && bytes[offset] !== 0) offset += bytes[offset] + 1;
    return offset + 1;
}

export function parseGif(buffer) {
    const bytes = new Uint8Array(buffer);
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature !== "GIF87a" && signature !== "GIF89a") throw new Error("Not a GIF file");

    const width = bytes[6] | (bytes[7] << 8);
    const height = bytes[8] | (bytes[9] << 8);
    const screenFlags = bytes[10];
    let offset = 13;

    let globalPalette = null;
    if (screenFlags & 0x80) {
        const entries = 2 << (screenFlags & 7);
        globalPalette = readPalette(bytes, offset, entries);
        offset += entries * 3;
    }

    const frames = [];
    let control = null;

    while (offset < bytes.length) {
        const introducer = bytes[offset++];

        if (introducer === 0x3B) break;   // trailer

        if (introducer === 0x21) {
            const label = bytes[offset++];
            if (label === 0xF9 && bytes[offset] >= 4) {
                const flags = bytes[offset + 1];
                control = {
                    disposal: (flags >> 2) & 7,
                    transparentIndex: flags & 1 ? bytes[offset + 4] : -1,
                    delay: bytes[offset + 2] | (bytes[offset + 3] << 8),
                };
            }
            offset = skipSubBlocks(bytes, offset);
            continue;
        }

        if (introducer !== 0x2C) break;   // anything else means the file is damaged; keep what we have

        const left = bytes[offset] | (bytes[offset + 1] << 8);
        const top = bytes[offset + 2] | (bytes[offset + 3] << 8);
        const frameWidth = bytes[offset + 4] | (bytes[offset + 5] << 8);
        const frameHeight = bytes[offset + 6] | (bytes[offset + 7] << 8);
        const flags = bytes[offset + 8];
        offset += 9;

        let palette = globalPalette;
        if (flags & 0x80) {
            const entries = 2 << (flags & 7);
            palette = readPalette(bytes, offset, entries);
            offset += entries * 3;
        }

        const minCodeSize = bytes[offset++];
        const dataStart = offset;
        offset = skipSubBlocks(bytes, offset);

        const delay = control?.delay ?? 0;
        frames.push({
            left, top, width: frameWidth, height: frameHeight,
            interlaced: (flags & 0x40) !== 0,
            palette,
            minCodeSize,
            dataStart,
            dataEnd: offset,
            disposal: control?.disposal ?? 0,
            transparentIndex: control?.transparentIndex ?? -1,
            duration: (delay < minimumDelay ? substituteDelay : delay) * 10,
        });
        control = null;
    }

    if (!frames.length) throw new Error("GIF has no frames");

    // Browsers grow a canvas too small for the first frame so that frame shows in full;
    // later frames are clipped as usual.
    const canvasWidth = Math.max(width, frames[0].left + frames[0].width);
    const canvasHeight = Math.max(height, frames[0].top + frames[0].height);

    return {bytes, width: canvasWidth, height: canvasHeight, frames};
}

// Scratch for LZW, shared by every decode on this thread.
const prefix = new Int16Array(4096);
const suffix = new Uint8Array(4096);
const stack = new Uint8Array(4097);

/** Decodes one frame's LZW stream into palette indices, row major in stream order. */
function decodeIndices(bytes, frame, out) {
    const {minCodeSize, dataStart, dataEnd} = frame;
    const pixelCount = frame.width * frame.height;
    const clearCode = 1 << minCodeSize;
    const endCode = clearCode + 1;

    let codeSize = minCodeSize + 1;
    let codeMask = (1 << codeSize) - 1;
    let nextCode = endCode + 1;
    let previous = -1;
    let first = 0;

    for (let code = 0; code < clearCode; code++) {
        prefix[code] = -1;
        suffix[code] = code;
    }

    let bits = 0;
    let bitCount = 0;
    let blockRemaining = 0;
    let offset = dataStart;
    let written = 0;

    while (written < pixelCount) {
        while (bitCount < codeSize) {
            if (blockRemaining === 0) {
                if (offset >= dataEnd) return written;
                blockRemaining = bytes[offset++];
                if (blockRemaining === 0) return written;
            }
            bits |= bytes[offset++] << bitCount;
            bitCount += 8;
            blockRemaining--;
        }

        const code = bits & codeMask;
        bits >>>= codeSize;
        bitCount -= codeSize;

        if (code === clearCode) {
            codeSize = minCodeSize + 1;
            codeMask = (1 << codeSize) - 1;
            nextCode = endCode + 1;
            previous = -1;
            continue;
        }
        if (code === endCode) break;

        if (previous === -1) {
            if (code >= clearCode) return written;   // corrupt: first code must be a literal
            out[written++] = code;
            previous = code;
            first = code;
            continue;
        }

        // A code one past the table is the previous string plus its own first byte.
        let current = code;
        let depth = 0;
        if (code >= nextCode) {
            if (code > nextCode) return written;    // corrupt
            stack[depth++] = first;
            current = previous;
        }
        while (current >= clearCode) {
            stack[depth++] = suffix[current];
            current = prefix[current];
        }
        first = current;
        stack[depth++] = current;

        while (depth > 0 && written < pixelCount) out[written++] = stack[--depth];

        if (nextCode < 4096) {
            prefix[nextCode] = previous;
            suffix[nextCode] = first;
            nextCode++;
            // Grow the code size once the table needs it; at 4096 entries it stays at 12
            // bits until the encoder sends a clear.
            if (nextCode > codeMask && codeSize < 12) {
                codeSize++;
                codeMask = (1 << codeSize) - 1;
            }
        }
        previous = code;
    }

    return written;
}

// Interlaced GIFs store rows in four passes: every 8th from 0, every 8th from 4, every
// 4th from 2, every 2nd from 1.
function interlacedRowOrder(height) {
    const rows = new Int32Array(height);
    let n = 0;
    for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
        for (let y = start; y < height; y += step) rows[n++] = y;
    }
    return rows;
}

/**
 * Yields [index, rgba] for each frame in wanted (ascending indices). Every frame up to the
 * last wanted one is decoded, since each builds on the canvas left by the one before.
 * The rgba buffer is reused: copy it before the next iteration if it has to live on.
 */
export function* decodeGifFrames(gif, wanted) {
    const {bytes, width, height, frames} = gif;
    const canvas = new Uint8ClampedArray(width * height * 4);
    const indices = new Uint8Array(frames.reduce((largest, f) => Math.max(largest, f.width * f.height), 0));
    let saved = null;
    let next = 0;

    for (let index = 0; index < frames.length && next < wanted.length; index++) {
        const frame = frames[index];
        const {left, top, palette, transparentIndex} = frame;

        if (frame.disposal === disposeToPrevious) saved = canvas.slice();

        const decoded = decodeIndices(bytes, frame, indices);
        const rowOrder = frame.interlaced ? interlacedRowOrder(frame.height) : null;

        if (palette) {
            const paletteEntries = palette.length / 3;
            const clipWidth = Math.min(frame.width, width - left);
            for (let row = 0; row < frame.height; row++) {
                const y = top + (rowOrder ? rowOrder[row] : row);
                if (y >= height) continue;
                const source = row * frame.width;
                if (source >= decoded) break;   // truncated stream: the rest of the frame stays as it was
                let p = (y * width + left) * 4;
                for (let x = 0; x < clipWidth; x++, p += 4) {
                    const c = indices[source + x];
                    if (c === transparentIndex) continue;
                    // Indices past the end of the palette show as black, as in browsers.
                    const inPalette = c < paletteEntries;
                    canvas[p] = inPalette ? palette[c * 3] : 0;
                    canvas[p + 1] = inPalette ? palette[c * 3 + 1] : 0;
                    canvas[p + 2] = inPalette ? palette[c * 3 + 2] : 0;
                    canvas[p + 3] = 255;
                }
            }
        }

        if (index === wanted[next]) {
            yield [index, canvas];
            while (next < wanted.length && wanted[next] === index) next++;
        }

        if (frame.disposal === disposeToBackground) {
            // Browsers clear to transparent rather than the background colour.
            const clipWidth = Math.min(frame.width, width - left);
            for (let y = top; y < Math.min(height, top + frame.height); y++) {
                canvas.fill(0, (y * width + left) * 4, (y * width + left + clipWidth) * 4);
            }
        } else if (frame.disposal === disposeToPrevious && saved) {
            canvas.set(saved);
        }
    }
}
