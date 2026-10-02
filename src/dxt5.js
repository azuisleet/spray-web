/**
 * DXT5 (BC3): each 4x4 block is an 8 byte alpha block followed by an 8 byte DXT1 style
 * colour block that is always read as four colours. Alpha gets two endpoints and eight
 * levels between them (or six plus exact 0 and 255), so soft edges and partial
 * transparency survive where DXT1 can only cut at a threshold.
 *
 * https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-resources-block-compression#bc3
 */
import {encodeColourBlock} from "./dxt1.js";

const blockBytes = 16;

const alphas = new Int32Array(16);
const palette = new Int32Array(8);
const candidate = new Uint8Array(16);
const chosen = new Uint8Array(16);

/**
 * The eight alpha levels for a pair of endpoints. a0 > a1 interpolates six levels between
 * them; otherwise four, with exact 0 and 255 as the last two.
 */
function fillAlphaPalette(a0, a1, out = palette) {
    out[0] = a0;
    out[1] = a1;
    if (a0 > a1) {
        for (let k = 1; k <= 6; k++) out[k + 1] = Math.round(((7 - k) * a0 + k * a1) / 7);
    } else {
        for (let k = 1; k <= 4; k++) out[k + 1] = Math.round(((5 - k) * a0 + k * a1) / 5);
        out[6] = 0;
        out[7] = 255;
    }
    return out;
}

// Indices into the palette for every pixel, into candidate; returns the squared error.
function assign(a0, a1) {
    fillAlphaPalette(a0, a1);
    let error = 0;
    for (let i = 0; i < 16; i++) {
        let nearest = 0, nearestError = Infinity;
        for (let k = 0; k < 8; k++) {
            const d = palette[k] - alphas[i];
            if (d * d < nearestError) {
                nearestError = d * d;
                nearest = k;
            }
        }
        candidate[i] = nearest;
        error += nearestError;
    }
    return error;
}

function encodeAlphaBlock(out, offset) {
    let min = 255, max = 0, innerMin = 255, innerMax = 0;
    for (let i = 0; i < 16; i++) {
        const a = alphas[i];
        if (a < min) min = a;
        if (a > max) max = a;
        if (a > 0 && a < 255) {
            if (a < innerMin) innerMin = a;
            if (a > innerMax) innerMax = a;
        }
    }

    // Eight levels spanning the whole range, or six spanning just the in-between values
    // with exact 0 and 255 alongside: the second wins for crisp shapes with soft edges.
    let a0 = max, a1 = min;
    let error = max > min ? assign(a0, a1) : Infinity;
    if (error === Infinity) {
        a0 = a1 = max;
        error = assign(a0, a1);
    }
    chosen.set(candidate);
    if (error > 0) {
        const low = innerMin <= innerMax ? innerMin : 0;
        const high = innerMin <= innerMax ? innerMax : 0;
        const inner = assign(low, high);
        if (inner < error) {
            a0 = low;
            a1 = high;
            chosen.set(candidate);
        }
    }

    out[offset] = a0;
    out[offset + 1] = a1;
    // Sixteen 3 bit indices, little endian, in two runs of eight (24 bits each).
    for (let half = 0; half < 2; half++) {
        let bits = 0;
        for (let i = 7; i >= 0; i--) bits = (bits << 3) | chosen[half * 8 + i];
        out[offset + 2 + half * 3] = bits & 0xFF;
        out[offset + 3 + half * 3] = (bits >> 8) & 0xFF;
        out[offset + 4 + half * 3] = (bits >> 16) & 0xFF;
    }
}

/**
 * @param width, height multiples of 4
 * @param rgba unpremultiplied RGBA, row major
 * @returns blocks in row major order, 16 bytes each
 */
export function encodeDXT5(width, height, rgba) {
    if (width % 4 !== 0 || height % 4 !== 0) throw new Error(`DXT5 needs dimensions divisible by 4, got ${width}x${height}`);
    if (rgba.length !== width * height * 4) throw new Error("Pixel data does not match dimensions");

    const stride = width * 4;
    const out = new Uint8Array((width / 4) * (height / 4) * blockBytes);
    let offset = 0;
    for (let by = 0; by < height / 4; by++) {
        for (let bx = 0; bx < width / 4; bx++, offset += blockBytes) {
            const p = by * 4 * stride + bx * 16;
            for (let y = 0, i = 0; y < 4; y++) {
                for (let x = 0; x < 4; x++, i++) alphas[i] = rgba[p + y * stride + x * 4 + 3];
            }
            encodeAlphaBlock(out, offset);
            encodeColourBlock(rgba, stride, p, out, offset + 8);
        }
    }
    return out;
}

const expand5 = (v) => (v << 3) | (v >> 2);
const expand6 = (v) => (v << 2) | (v >> 4);

/** Decodes as the hardware does, for previews and tests. */
export function decodeDXT5(width, height, data) {
    const out = new Uint8Array(width * height * 4);
    const blocksWide = Math.max(1, width >> 2);
    const blocksHigh = Math.max(1, height >> 2);
    const levels = new Int32Array(8);
    const colours = new Int32Array(12);

    for (let by = 0, offset = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++, offset += blockBytes) {
            fillAlphaPalette(data[offset], data[offset + 1], levels);
            const low = data[offset + 2] | (data[offset + 3] << 8) | (data[offset + 4] << 16);
            const high = data[offset + 5] | (data[offset + 6] << 8) | (data[offset + 7] << 16);

            const c0 = data[offset + 8] | (data[offset + 9] << 8);
            const c1 = data[offset + 10] | (data[offset + 11] << 8);
            const r0 = expand5(c0 >> 11), g0 = expand6((c0 >> 5) & 63), b0 = expand5(c0 & 31);
            const r1 = expand5(c1 >> 11), g1 = expand6((c1 >> 5) & 63), b1 = expand5(c1 & 31);
            colours.set([r0, g0, b0, r1, g1, b1,
                ((2 * r0 + r1 + 1) / 3) | 0, ((2 * g0 + g1 + 1) / 3) | 0, ((2 * b0 + b1 + 1) / 3) | 0,
                ((r0 + 2 * r1 + 1) / 3) | 0, ((g0 + 2 * g1 + 1) / 3) | 0, ((b0 + 2 * b1 + 1) / 3) | 0]);
            const colourBits = (data[offset + 12] | (data[offset + 13] << 8) | (data[offset + 14] << 16) | (data[offset + 15] << 24)) >>> 0;

            for (let i = 0; i < 16; i++) {
                const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                if (x >= width || y >= height) continue;
                const alphaIndex = ((i < 8 ? low : high) >> (3 * (i & 7))) & 7;
                const colourIndex = (colourBits >>> (2 * i)) & 3;
                const p = (y * width + x) * 4;
                out[p] = colours[colourIndex * 3];
                out[p + 1] = colours[colourIndex * 3 + 1];
                out[p + 2] = colours[colourIndex * 3 + 2];
                out[p + 3] = levels[alphaIndex];
            }
        }
    }
    return out;
}
