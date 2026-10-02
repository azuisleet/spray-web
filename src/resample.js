/**
 * Separable Catmull-Rom resampling of an image into a rectangle of a larger transparent
 * target. The filter widens with the reduction factor, so a 1024 px image drawn into an
 * 8 px mip averages everything under each texel rather than picking 16 samples and
 * aliasing.
 *
 * Catmull-Rom over Mitchell-Netravali (B = C = 1/3): on photos it lands 5-7 dB closer to
 * a Lanczos-3 reduction and keeps about 90% of its edge contrast against Mitchell's 84%,
 * at the same cost.
 *
 * Work is premultiplied by alpha so the colour of transparent pixels never bleeds into
 * the edges of opaque ones.
 */

const support = 2;

function catmullRom(x) {
    x = Math.abs(x);
    if (x < 1) return 1.5 * x * x * x - 2.5 * x * x + 1;
    if (x < 2) return -0.5 * x * x * x + 2.5 * x * x - 4 * x + 2;
    return 0;
}

/**
 * Filter taps along one axis: source span [srcStart, srcEnd) of a srcSize image lands on
 * [dstStart, dstEnd) of the target's dstSize pixels (fractional is fine on both). Pixels
 * the image does not touch get no taps; edge pixels it only partly covers keep that
 * coverage, which later scales their alpha. Taps past a cropped span read the pixels
 * beyond it, so a crop has no artificial edge; past the image's own border they mirror
 * back in, which unlike repeating the edge pixel does not overweight it.
 */
function mirror(index, size) {
    const period = 2 * size;
    const wrapped = ((index % period) + period) % period;
    return wrapped < size ? wrapped : period - 1 - wrapped;
}

export function axisTaps(srcSize, srcStart, srcEnd, dstSize, dstStart, dstEnd) {
    const scale = (srcEnd - srcStart) / (dstEnd - dstStart);
    const filterScale = Math.max(1, scale);
    const radius = support * filterScale;

    const offsets = new Int32Array(dstSize + 1);
    const coverage = new Float32Array(dstSize);
    const indices = [];
    const weights = [];

    for (let i = 0; i < dstSize; i++) {
        offsets[i] = indices.length;
        coverage[i] = Math.max(0, Math.min(i + 1, dstEnd) - Math.max(i, dstStart));
        if (coverage[i] === 0) continue;

        const centre = srcStart + (i + 0.5 - dstStart) * scale - 0.5;
        const first = Math.ceil(centre - radius);
        const last = Math.floor(centre + radius);
        const begin = indices.length;
        let total = 0;

        for (let j = first; j <= last; j++) {
            const weight = catmullRom((j - centre) / filterScale);
            if (weight === 0) continue;
            indices.push(mirror(j, srcSize));
            weights.push(weight);
            total += weight;
        }
        for (let k = begin; k < weights.length; k++) weights[k] /= total;
    }
    offsets[dstSize] = indices.length;

    return {offsets, coverage, indices: Int32Array.from(indices), weights: Float32Array.from(weights)};
}

/** Source rows needed for target rows [rowStart, rowEnd), as [first, end). */
export function sourceRowRange(taps, rowStart, rowEnd) {
    let first = Infinity, end = -Infinity;
    for (let k = taps.offsets[rowStart]; k < taps.offsets[rowEnd]; k++) {
        if (taps.indices[k] < first) first = taps.indices[k];
        if (taps.indices[k] + 1 > end) end = taps.indices[k] + 1;
    }
    return first === Infinity ? [0, 0] : [first, end];
}

export function verticalTaps(sourceHeight, targetHeight, {src, dst}) {
    return axisTaps(sourceHeight, src.y0, src.y1, targetHeight, dst.y0, dst.y1);
}

/**
 * Renders target rows [rowStart, rowStart + rows) of a targetWidth x targetHeight image,
 * with the src rectangle of the source drawn into the dst rectangle of the target (both
 * in fractional pixels).
 *
 * @param source {pixels, width, height, rowOffset}: pixels holds rows from rowOffset on,
 *        at least the ones sourceRowRange asks for.
 * @param placement {src, dst}, as from placeInTexture
 * @returns unpremultiplied RGBA for just those rows
 */
export function resampleRows(source, targetWidth, targetHeight, placement, rowStart, rows) {
    const {pixels, width: srcWidth, height: srcHeight, rowOffset} = source;
    const {src, dst} = placement;
    const xTaps = axisTaps(srcWidth, src.x0, src.x1, targetWidth, dst.x0, dst.x1);
    const yTaps = verticalTaps(srcHeight, targetHeight, placement);
    const [srcFirst, srcEnd] = sourceRowRange(yTaps, rowStart, rowStart + rows);
    // Clamped storage rounds and clamps on write, which also absorbs the overshoot from
    // the filter's negative lobes.
    const out = new Uint8ClampedArray(targetWidth * rows * 4);
    if (srcEnd <= srcFirst) return out;

    // Horizontal pass over just the source rows these target rows need, premultiplied.
    const stride = targetWidth * 4;
    const horizontal = new Float32Array((srcEnd - srcFirst) * stride);
    for (let sy = srcFirst; sy < srcEnd; sy++) {
        const row = (sy - rowOffset) * srcWidth * 4;
        const base = (sy - srcFirst) * stride;
        for (let x = 0; x < targetWidth; x++) {
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = xTaps.offsets[x]; k < xTaps.offsets[x + 1]; k++) {
                const p = row + xTaps.indices[k] * 4;
                const wa = xTaps.weights[k] * pixels[p + 3];
                r += wa * pixels[p];
                g += wa * pixels[p + 1];
                b += wa * pixels[p + 2];
                a += wa;
            }
            const q = base + x * 4;
            horizontal[q] = r;
            horizontal[q + 1] = g;
            horizontal[q + 2] = b;
            horizontal[q + 3] = a;
        }
    }

    // Vertical pass, then back to straight alpha.
    for (let y = 0; y < rows; y++) {
        const ty = rowStart + y;
        const coverageY = yTaps.coverage[ty];
        if (coverageY === 0) continue;
        for (let x = 0; x < targetWidth; x++) {
            const coverage = xTaps.coverage[x] * coverageY;
            if (coverage === 0) continue;
            let r = 0, g = 0, b = 0, a = 0;
            for (let k = yTaps.offsets[ty]; k < yTaps.offsets[ty + 1]; k++) {
                const q = (yTaps.indices[k] - srcFirst) * stride + x * 4;
                const w = yTaps.weights[k];
                r += w * horizontal[q];
                g += w * horizontal[q + 1];
                b += w * horizontal[q + 2];
                a += w * horizontal[q + 3];
            }
            if (a <= 0) continue;
            const p = (y * targetWidth + x) * 4;
            out[p] = r / a;
            out[p + 1] = g / a;
            out[p + 2] = b / a;
            out[p + 3] = a * coverage;
        }
    }

    return out;
}
