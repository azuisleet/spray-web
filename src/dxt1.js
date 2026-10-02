/**
 * DXT1 (BC1) encoder with 1-bit alpha, written for speed in plain JS: flat typed arrays,
 * no allocation per block, and squared error throughout.
 *
 * Per block: principal axis of the opaque colours gives starting endpoints, a least
 * squares refit pulls them onto the palette weights actually chosen, and a short greedy
 * walk over the quantised 565 endpoints cleans up rounding. Fully opaque blocks try both
 * the four colour and the three colour palette and keep whichever is closer.
 *
 * https://learn.microsoft.com/en-us/windows/win32/direct3d10/d3d10-graphics-programming-guide-resources-block-compression#bc1
 */

const blockBytes = 8;

// Alpha below this becomes the transparent palette entry.
export const alphaThreshold = 128;

// Weights on squared channel error, roughly the luma contribution of each channel.
const weightR = 3;
const weightG = 6;
const weightB = 1;

const powerIterations = 8;
const refitIterations = 2;
const refineRounds = 4;

// Weight of the first endpoint for each palette index, by palette mode.
const fourColourWeights = new Float64Array([1, 0, 2 / 3, 1 / 3]);
const threeColourWeights = new Float64Array([1, 0, 1 / 2, 0]);

// Per block scratch, reused for every block so the hot loop never allocates.
const blockR = new Int32Array(16);
const blockG = new Int32Array(16);
const blockB = new Int32Array(16);
const blockOpaque = new Uint8Array(16);
const palette = new Int32Array(12);
const candidateIndices = new Uint8Array(16);
const bestIndices = new Uint8Array(16);

const best = {error: Infinity, c0: 0, c1: 0};

// Set while encoding the colour half of a DXT5 block, which is always read as four colours
// (alpha lives in its own half), so the three colour palette must never be chosen.
let fourColourOnly = false;

function expand5(v) {
    return (v << 3) | (v >> 2);
}

function expand6(v) {
    return (v << 2) | (v >> 4);
}

function clampByte(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v;
}

function quantise565(r, g, b) {
    return (Math.round(clampByte(r) * 31 / 255) << 11)
        | (Math.round(clampByte(g) * 63 / 255) << 5)
        | Math.round(clampByte(b) * 31 / 255);
}

function fillPalette(c0, c1, threeColour) {
    const r0 = expand5(c0 >> 11), g0 = expand6((c0 >> 5) & 63), b0 = expand5(c0 & 31);
    const r1 = expand5(c1 >> 11), g1 = expand6((c1 >> 5) & 63), b1 = expand5(c1 & 31);

    palette[0] = r0; palette[1] = g0; palette[2] = b0;
    palette[3] = r1; palette[4] = g1; palette[5] = b1;

    if (threeColour) {
        palette[6] = (r0 + r1 + 1) >> 1;
        palette[7] = (g0 + g1 + 1) >> 1;
        palette[8] = (b0 + b1 + 1) >> 1;
    } else {
        palette[6] = ((2 * r0 + r1 + 1) / 3) | 0;
        palette[7] = ((2 * g0 + g1 + 1) / 3) | 0;
        palette[8] = ((2 * b0 + b1 + 1) / 3) | 0;
        palette[9] = ((r0 + 2 * r1 + 1) / 3) | 0;
        palette[10] = ((g0 + 2 * g1 + 1) / 3) | 0;
        palette[11] = ((b0 + 2 * b1 + 1) / 3) | 0;
    }
}

/**
 * Scores an endpoint pair and keeps it if it beats the best so far. The decoder picks
 * the palette mode from the endpoint order, so the pair is ordered here: c0 > c1 for
 * four colours, c0 <= c1 for three. Equal endpoints can only mean three colours, which
 * is harmless since every visible entry is the same colour.
 */
function tryPair(c0, c1, threeColour) {
    if (fourColourOnly) threeColour = false;
    if (threeColour) {
        if (c0 > c1) { const t = c0; c0 = c1; c1 = t; }
    } else if (c0 < c1) {
        const t = c0; c0 = c1; c1 = t;
    } else if (c0 === c1 && !fourColourOnly) {
        threeColour = true;
    }

    fillPalette(c0, c1, threeColour);
    const entries = threeColour ? 9 : 12;

    let error = 0;
    for (let i = 0; i < 16; i++) {
        if (!blockOpaque[i]) {
            candidateIndices[i] = 3;
            continue;
        }

        const r = blockR[i], g = blockG[i], b = blockB[i];
        let nearest = 0;
        let nearestError = Infinity;
        for (let p = 0, index = 0; p < entries; p += 3, index++) {
            const dr = palette[p] - r, dg = palette[p + 1] - g, db = palette[p + 2] - b;
            const e = weightR * dr * dr + weightG * dg * dg + weightB * db * db;
            if (e < nearestError) {
                nearestError = e;
                nearest = index;
            }
        }

        candidateIndices[i] = nearest;
        error += nearestError;
        if (error >= best.error) return;
    }

    if (error < best.error) {
        best.error = error;
        best.c0 = c0;
        best.c1 = c1;
        bestIndices.set(candidateIndices);
    }
}

/**
 * Least squares endpoints for the current best indices: with every pixel's palette
 * weight fixed, each channel is an independent two unknown linear fit.
 */
function refit(threeColour) {
    const weights = threeColour ? threeColourWeights : fourColourWeights;
    let aa = 0, bb = 0, ab = 0;
    let ar = 0, ag = 0, ab_ = 0;
    let br = 0, bg = 0, bb_ = 0;

    for (let i = 0; i < 16; i++) {
        if (!blockOpaque[i]) continue;
        const wa = weights[bestIndices[i]];
        const wb = 1 - wa;
        aa += wa * wa;
        bb += wb * wb;
        ab += wa * wb;
        ar += wa * blockR[i]; ag += wa * blockG[i]; ab_ += wa * blockB[i];
        br += wb * blockR[i]; bg += wb * blockG[i]; bb_ += wb * blockB[i];
    }

    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-8) return false;
    const inv = 1 / det;

    tryPair(
        quantise565((ar * bb - br * ab) * inv, (ag * bb - bg * ab) * inv, (ab_ * bb - bb_ * ab) * inv),
        quantise565((br * aa - ar * ab) * inv, (bg * aa - ag * ab) * inv, (bb_ * aa - ab_ * ab) * inv),
        threeColour);
    return true;
}

// Steps of one in each 565 field of either endpoint.
const fieldSteps = new Int32Array([1 << 11, 1 << 5, 1]);
const fieldMasks = new Int32Array([31 << 11, 63 << 5, 31]);

function refine(threeColour) {
    for (let round = 0; round < refineRounds; round++) {
        const startError = best.error;
        const c0 = best.c0, c1 = best.c1;

        for (let field = 0; field < 3; field++) {
            const step = fieldSteps[field], mask = fieldMasks[field];
            for (let dir = -1; dir <= 1; dir += 2) {
                const delta = dir * step;
                const v0 = (c0 & mask) + delta;
                if (v0 >= 0 && v0 <= mask) tryPair((c0 & ~mask) | v0, c1, threeColour);
                const v1 = (c1 & mask) + delta;
                if (v1 >= 0 && v1 <= mask) tryPair(c0, (c1 & ~mask) | v1, threeColour);
            }
        }

        if (best.error >= startError) return;
    }
}

/**
 * For a solid block, the endpoint pair whose interpolated entry lands closest to each
 * 8-bit value. Hitting the colour through the 2/3 or 1/2 entry is often exact where the
 * nearest plain 565 value is off by a few levels.
 */
function buildSingleColourTable(bits, threeColour) {
    const levels = 1 << bits;
    const expand = bits === 5 ? expand5 : expand6;
    const table = new Uint8Array(512);

    for (let v = 0; v < 256; v++) {
        let bestError = Infinity;
        for (let e0 = 0; e0 < levels; e0++) {
            const x0 = expand(e0);
            for (let e1 = 0; e1 < levels; e1++) {
                const x1 = expand(e1);
                const mixed = threeColour ? (x0 + x1 + 1) >> 1 : ((2 * x0 + x1 + 1) / 3) | 0;
                const error = Math.abs(mixed - v) * 256 + Math.abs(e0 - e1);
                if (error < bestError) {
                    bestError = error;
                    table[v * 2] = e0;
                    table[v * 2 + 1] = e1;
                }
            }
        }
    }

    return table;
}

const single5Four = buildSingleColourTable(5, false);
const single6Four = buildSingleColourTable(6, false);
const single5Three = buildSingleColourTable(5, true);
const single6Three = buildSingleColourTable(6, true);

function trySingleColour(r, g, b, threeColour) {
    const t5 = threeColour ? single5Three : single5Four;
    const t6 = threeColour ? single6Three : single6Four;
    tryPair(
        (t5[r * 2] << 11) | (t6[g * 2] << 5) | t5[b * 2],
        (t5[r * 2 + 1] << 11) | (t6[g * 2 + 1] << 5) | t5[b * 2 + 1],
        threeColour);
}

function compressBlock(out, offset) {
    let count = 0;
    let meanR = 0, meanG = 0, meanB = 0;
    for (let i = 0; i < 16; i++) {
        if (!blockOpaque[i]) continue;
        count++;
        meanR += blockR[i];
        meanG += blockG[i];
        meanB += blockB[i];
    }

    if (count === 0) {
        // c0 == c1 selects three colour mode, every pixel takes index 3: transparent.
        out[offset] = out[offset + 1] = out[offset + 2] = out[offset + 3] = 0;
        out[offset + 4] = out[offset + 5] = out[offset + 6] = out[offset + 7] = 0xFF;
        return;
    }

    const hasTransparent = count < 16;
    meanR /= count;
    meanG /= count;
    meanB /= count;

    let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
    for (let i = 0; i < 16; i++) {
        if (!blockOpaque[i]) continue;
        const r = blockR[i] - meanR, g = blockG[i] - meanG, b = blockB[i] - meanB;
        crr += r * r; crg += r * g; crb += r * b;
        cgg += g * g; cgb += g * b; cbb += b * b;
    }

    best.error = Infinity;

    if (crr + cgg + cbb < 1e-6) {
        // Solid colour (this also covers a lone opaque pixel).
        const r = Math.round(meanR), g = Math.round(meanG), b = Math.round(meanB);
        const direct = quantise565(r, g, b);
        tryPair(direct, direct, true);
        trySingleColour(r, g, b, true);
        if (!hasTransparent || fourColourOnly) trySingleColour(r, g, b, false);
    } else {
        // Principal axis by power iteration, seeded with the covariance row of the widest
        // channel: it is never zero here, where a fixed seed like (1,1,1) can be
        // orthogonal to the axis when channels are anticorrelated.
        let ax, ay, az;
        if (crr >= cgg && crr >= cbb) { ax = crr; ay = crg; az = crb; }
        else if (cgg >= cbb) { ax = crg; ay = cgg; az = cgb; }
        else { ax = crb; ay = cgb; az = cbb; }
        for (let iteration = 0; iteration < powerIterations; iteration++) {
            const nx = crr * ax + crg * ay + crb * az;
            const ny = crg * ax + cgg * ay + cgb * az;
            const nz = crb * ax + cgb * ay + cbb * az;
            const length = Math.max(Math.abs(nx), Math.abs(ny), Math.abs(nz));
            if (length === 0) break;
            ax = nx / length; ay = ny / length; az = nz / length;
        }
        const norm = Math.hypot(ax, ay, az);
        ax /= norm; ay /= norm; az /= norm;

        let minT = Infinity, maxT = -Infinity;
        for (let i = 0; i < 16; i++) {
            if (!blockOpaque[i]) continue;
            const t = (blockR[i] - meanR) * ax + (blockG[i] - meanG) * ay + (blockB[i] - meanB) * az;
            if (t < minT) minT = t;
            if (t > maxT) maxT = t;
        }

        const high = quantise565(meanR + ax * maxT, meanG + ay * maxT, meanB + az * maxT);
        const low = quantise565(meanR + ax * minT, meanG + ay * minT, meanB + az * minT);

        const modes = fourColourOnly ? [false] : hasTransparent ? [true] : [false, true];
        for (const threeColour of modes) {
            const before = best.error;
            tryPair(high, low, threeColour);
            // The refit uses the best indices, which only belong to this mode if this
            // mode just produced them.
            for (let iteration = 0; iteration < refitIterations && best.error < before; iteration++) {
                const previous = best.error;
                if (!refit(threeColour) || best.error >= previous) break;
            }
        }
    }

    refine(!fourColourOnly && best.c0 <= best.c1);

    let bits = 0;
    for (let i = 15; i >= 0; i--) bits = (bits << 2) | bestIndices[i];

    out[offset] = best.c0 & 0xFF;
    out[offset + 1] = best.c0 >> 8;
    out[offset + 2] = best.c1 & 0xFF;
    out[offset + 3] = best.c1 >> 8;
    out[offset + 4] = bits & 0xFF;
    out[offset + 5] = (bits >>> 8) & 0xFF;
    out[offset + 6] = (bits >>> 16) & 0xFF;
    out[offset + 7] = bits >>> 24;
}

/**
 * @param width, height multiples of 4
 * @param rgba unpremultiplied RGBA, row major
 * @returns blocks in row major order, 8 bytes each
 */
export function encodeDXT1(width, height, rgba) {
    if (width % 4 !== 0 || height % 4 !== 0) throw new Error(`DXT1 needs dimensions divisible by 4, got ${width}x${height}`);
    if (rgba.length !== width * height * 4) throw new Error("Pixel data does not match dimensions");

    const blocksWide = width / 4;
    const blocksHigh = height / 4;
    const out = new Uint8Array(blocksWide * blocksHigh * blockBytes);
    const stride = width * 4;

    let offset = 0;
    for (let by = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++) {
            let p = by * 4 * stride + bx * 16;
            for (let y = 0, i = 0; y < 4; y++, p += stride - 16) {
                for (let x = 0; x < 4; x++, i++, p += 4) {
                    blockR[i] = rgba[p];
                    blockG[i] = rgba[p + 1];
                    blockB[i] = rgba[p + 2];
                    blockOpaque[i] = rgba[p + 3] >= alphaThreshold ? 1 : 0;
                }
            }
            compressBlock(out, offset);
            offset += blockBytes;
        }
    }

    return out;
}

/**
 * Encodes the colour half of a DXT5 block: the 4x4 block whose top left pixel is at index
 * p of rgba (a row of stride bytes), into out at offset. Pixels with no alpha at all are
 * left out of the fit, since nothing of their colour shows.
 */
export function encodeColourBlock(rgba, stride, p, out, offset) {
    for (let y = 0, i = 0; y < 4; y++, p += stride - 16) {
        for (let x = 0; x < 4; x++, i++, p += 4) {
            blockR[i] = rgba[p];
            blockG[i] = rgba[p + 1];
            blockB[i] = rgba[p + 2];
            blockOpaque[i] = rgba[p + 3] > 0 ? 1 : 0;
        }
    }
    fourColourOnly = true;
    try {
        compressBlock(out, offset);
    } finally {
        fourColourOnly = false;
    }
}

/** Decodes as the hardware does, for previews and tests. */
export function decodeDXT1(width, height, data) {
    const out = new Uint8Array(width * height * 4);
    const blocksWide = Math.max(1, width >> 2);
    const blocksHigh = Math.max(1, height >> 2);

    for (let by = 0, offset = 0; by < blocksHigh; by++) {
        for (let bx = 0; bx < blocksWide; bx++, offset += blockBytes) {
            const c0 = data[offset] | (data[offset + 1] << 8);
            const c1 = data[offset + 2] | (data[offset + 3] << 8);
            const bits = (data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24)) >>> 0;
            const threeColour = c0 <= c1;
            fillPalette(c0, c1, threeColour);

            for (let i = 0; i < 16; i++) {
                const x = bx * 4 + (i & 3), y = by * 4 + (i >> 2);
                if (x >= width || y >= height) continue;
                const index = (bits >>> (i * 2)) & 3;
                const p = (y * width + x) * 4;
                if (threeColour && index === 3) {
                    out[p] = out[p + 1] = out[p + 2] = out[p + 3] = 0;
                } else {
                    out[p] = palette[index * 3];
                    out[p + 1] = palette[index * 3 + 1];
                    out[p + 2] = palette[index * 3 + 2];
                    out[p + 3] = 255;
                }
            }
        }
    }

    return out;
}
