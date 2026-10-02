/**
 * Planning a spray: how the image sits on the square decal, what texture size and frame
 * count to use, and which source frames fill the slots. Pure functions with no browser
 * dependencies, so the UI can call them freely and tests run them under Node.
 */
import {dxt1Size, maximumSize, mipDimensions} from "./vtf.js";

export const preferDetail = "detail";
export const preferBalanced = "balanced";
export const preferMotion = "motion";

export const fitPad = "pad";
export const fitCrop = "crop";
export const fitStretch = "stretch";

// vtex refuses anything that isn't a power of two on each axis, and it sizes the two
// axes independently. The decal on the wall is always square whatever the texture's
// shape, so a rectangular texture is still shown square, just with texels that are
// longer on one axis than the other.
const axisSizes = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

// The engine itself takes any multiple of 4: still and animated test sprays at sizes like
// 1008x1040, 720x724 and 360x360 (see scripts/test-sprays.mjs) all drew in full in TF2
// with no resampling. Mip tricks keep to powers of two so every level halves evenly.
const blockSizes = Array.from({length: 2048 / 4}, (_, i) => (i + 1) * 4);

// Exponents in chooseTarget's score. At 3 the presets differ clearly without either one
// collapsing to an extreme. Balanced leans a little towards timing, since an animation
// playing too fast is more noticeable than a little lost resolution.
const preferenceWeights = {
    [preferDetail]: {detail: 3, motion: 1},
    [preferBalanced]: {detail: 1, motion: 2},
    [preferMotion]: {detail: 1, motion: 3},
};

// An animated source never comes out as a still, however hard resolution is favoured.
const minimumAnimatedFrames = 2;

// Sprays are drawn with TF2's decals/playerlogoNN materials (c_te_playerdecal.cpp in the
// SDK), whose AnimatedTexture proxy sets animatedtextureframerate 5. The spray's own VMT
// plays no part.
export const engineFrameRate = 5;

function payloadPerFrame(width, height, useMips) {
    if (!useMips) return dxt1Size(width, height);
    return mipDimensions(width, height).reduce((total, [w, h]) => total + dxt1Size(w, h), 0);
}

/**
 * How the image maps onto the square decal.
 *
 *  - pad: all of it at its own aspect ratio, transparent bands on the short axis
 *  - crop: the largest square, positioned by focus (0..1 on each axis, centred by default)
 *  - stretch: all of it, distorted to fill the square
 *
 * @returns {source, decal}: the source rectangle in pixels, and where it lands in the
 *          decal as fractions of the square
 */
export function fitGeometry(width, height, fit = fitPad, focus = {x: 0.5, y: 0.5}) {
    const full = {x0: 0, y0: 0, x1: width, y1: height};
    const square = {x0: 0, y0: 0, x1: 1, y1: 1};

    if (fit === fitStretch) return {source: full, decal: square};

    if (fit === fitCrop) {
        const side = Math.min(width, height);
        const x0 = (width - side) * focus.x;
        const y0 = (height - side) * focus.y;
        return {source: {x0, y0, x1: x0 + side, y1: y0 + side}, decal: square};
    }

    const coverX = Math.min(1, width / height);
    const coverY = Math.min(1, height / width);
    return {
        source: full,
        decal: {x0: (1 - coverX) / 2, y0: (1 - coverY) / 2, x1: (1 + coverX) / 2, y1: (1 + coverY) / 2},
    };
}

/**
 * Where the image goes in a texture of the given size: its place in the square decal,
 * stretched onto the texture's grid, which the decal stretches back to square on the wall.
 */
export function placeInTexture(geometry, width, height) {
    const {decal} = geometry;
    return {
        src: geometry.source,
        dst: {x0: decal.x0 * width, y0: decal.y0 * height, x1: decal.x1 * width, y1: decal.y1 * height},
    };
}

/**
 * How many frames the spray wants: enough for the engine's fixed 5 fps to play the
 * animation at its real speed, since every frame beyond that slows it down and every one
 * short of it speeds it up. A long-held frame is repeated to keep its time. With
 * keepAllFrames the source frames are wanted one for one instead, at whatever speed
 * that plays.
 *
 * @param durations each source frame's display time in ms
 */
export function targetFrameCount(durations, {keepAllFrames = false} = {}) {
    if (durations.length <= 1) return 1;
    if (keepAllFrames) return durations.length;
    const seconds = durations.reduce((sum, d) => sum + d, 0) / 1000;
    return Math.max(minimumAnimatedFrames, Math.round(seconds * engineFrameRate));
}

/**
 * Picks the texture size and frame count together. Enumerating the candidates beats
 * deriving one answer because the good choice depends on how the two trade off, and
 * the space is small enough to search in a few milliseconds.
 *
 * The score is the worse of resolution and motion, each raised to its preference weight,
 * so the pick sits where the two lose equally (skewed by the preference). A product of
 * the two would not work: along the size limit, halving the frames buys twice the texels,
 * so the product is flat and the choice comes down to rounding.
 *
 * @param wantedFrames from targetFrameCount; never exceeded, and motion is measured
 *        against it
 * @returns {targetWidth, targetHeight, frames, detail, motion, waste, cost, ...} or null
 *          when nothing fits
 */
export function chooseTarget(width, height, wantedFrames, {useMips = false, preference = preferBalanced, fit = fitPad} = {}) {
    const weights = preferenceWeights[preference] || preferenceWeights[preferBalanced];
    const {source, decal} = fitGeometry(width, height, fit);
    const sourceWidth = source.x1 - source.x0;
    const sourceHeight = source.y1 - source.y0;
    const coverX = decal.x1 - decal.x0;
    const coverY = decal.y1 - decal.y0;
    const sizes = useMips ? axisSizes : blockSizes;
    let best = null;

    for (const targetWidth of sizes) {
        for (const targetHeight of sizes) {
            const perFrame = payloadPerFrame(targetWidth, targetHeight, useMips);
            const affordable = Math.floor(maximumSize / perFrame);
            if (affordable < 1) continue;

            const frames = Math.min(wantedFrames, affordable);
            if (frames < Math.min(wantedFrames, minimumAnimatedFrames)) continue;

            // Texels the image covers on each axis against the source pixels there, capped at
            // 1 because upscaling adds nothing. Their product is the fraction of source pixels kept.
            const samplingX = targetWidth * coverX / sourceWidth;
            const samplingY = targetHeight * coverY / sourceHeight;
            const detailX = Math.min(1, samplingX);
            const detailY = Math.min(1, samplingY);
            const detail = detailX * detailY;
            // The blurrier axis is what you see, so a lopsided texture only helps once the
            // other axis already holds the source at full resolution.
            const resolution = Math.min(detailX, detailY);
            const motion = frames / wantedFrames;
            const resolutionTerm = resolution ** weights.detail;
            const motionTerm = motion ** weights.motion;
            const score = Math.min(resolutionTerm, motionTerm);
            // Then whichever pick keeps more overall, then the one sampling the source most evenly
            // across the two axes (blur that is the same both ways looks better, and sampling
            // one axis past the source's resolution only spends bytes), then fewer bytes.
            const total = detail * motionTerm;
            const anisotropy = Math.abs(Math.log2(samplingX / samplingY));
            const cost = perFrame * frames;

            const better = !best
                || score > best.score + 1e-9
                || (score > best.score - 1e-9
                    && (total > best.total + 1e-9
                        || (total > best.total - 1e-9
                            && (anisotropy < best.anisotropy
                                || (anisotropy === best.anisotropy && cost < best.cost)))));

            if (better) best = {targetWidth, targetHeight, frames, score, detail, motion, total, anisotropy, cost};
        }
    }

    // Padding lives in the square, so it is the same whatever texture is chosen.
    if (best) best.waste = 1 - coverX * coverY;
    return best;
}

// VTF has nowhere to store per-frame timing, so the engine plays frames at a fixed rate.
// Selecting by elapsed time rather than by index is what keeps a variable-delay GIF from
// being retimed, and it repeats a long-held frame across slots instead of dropping it.
// frames may be more than durations.length; source frames then repeat.
export function chooseFrameIndices(durations, frames) {
    const total = durations.reduce((sum, d) => sum + d, 0);
    const indices = [];

    let index = 0;
    let elapsed = durations[0];

    for (let slot = 0; slot < frames; slot++) {
        const at = (slot + 0.5) * total / frames;
        // Strictly less-than, so a slot midpoint landing exactly on a frame boundary
        // stays with the earlier frame and uniform delays decimate evenly.
        while (index < durations.length - 1 && elapsed < at) {
            index += 1;
            elapsed += durations[index];
        }
        indices.push(index);
    }

    return indices;
}

/**
 * Mip level the distant image takes over from in a mip trick, derived from the final size
 * so "swap at 64 px" means the same thing whatever size the plan chose.
 */
export function chooseSwapLevel(targetWidth, targetHeight, swapPixels) {
    const mipCount = mipDimensions(targetWidth, targetHeight).length;
    return Math.min(mipCount - 1, Math.max(1, Math.round(Math.log2(Math.max(targetWidth, targetHeight) / swapPixels))));
}
