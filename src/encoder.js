import {getEncoderPool} from "./encoderPool.js";
import {baseFlags, buildHeader, dxt1Size, flagNoMip, headerSize, maximumSize, mipDimensions} from "./vtf.js";

export const qualityModeNearest = 0;
export const qualityModeLinear = 1;
export const qualityModeCubic = 2;

export const preferDetail = "detail";
export const preferBalanced = "balanced";
export const preferMotion = "motion";

const minBlockDimension = 4;

// vtex refuses anything that isn't a power of two on each axis, and it sizes the two
// axes independently. The decal on the wall is always square whatever the texture's
// shape, so a rectangular texture is still shown square, just with texels that are
// longer on one axis than the other.
const axisSizes = [4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];

// The engine itself takes any multiple of 4: still and animated test sprays at sizes like
// 1008x1040, 720x724 and 360x360 (see scripts/test-sprays.mjs) all drew in full in TF2
// with no resampling. Mip tricks keep to powers of two so every level halves evenly.
const blockSizes = Array.from({length: 2048 / 4}, (_, i) => (i + 1) * 4);

// Exponents in chooseTarget's score. At 3 the presets differ clearly (a 139 frame GIF
// gets 13, 38 or 83 frames) without either one collapsing to an extreme.
const preferenceWeights = {
    [preferDetail]: {detail: 3, motion: 1},
    [preferBalanced]: {detail: 1, motion: 1},
    [preferMotion]: {detail: 1, motion: 3},
};

// An animated source never comes out as a still, however hard resolution is favoured.
const minimumAnimatedFrames = 2;

function payloadPerFrame(width, height, useMips) {
    if (!useMips) return dxt1Size(width, height);
    return mipDimensions(width, height).reduce((total, [w, h]) => total + dxt1Size(w, h), 0);
}

/**
 * The share of the square decal the image covers on each axis when fitted inside it at
 * its own aspect ratio, padding the rest.
 */
function squareFit(width, height) {
    return {fitX: Math.min(1, width / height), fitY: Math.min(1, height / width)};
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
 */
export function chooseTarget(width, height, frameCount, useMips, preference) {
    const weights = preferenceWeights[preference] || preferenceWeights[preferBalanced];
    const {fitX, fitY} = squareFit(width, height);
    const sizes = useMips ? axisSizes : blockSizes;
    let best = null;

    for (const targetWidth of sizes) {
        for (const targetHeight of sizes) {
            const perFrame = payloadPerFrame(targetWidth, targetHeight, useMips);
            const affordable = Math.floor(maximumSize / perFrame);
            if (affordable < 1) continue;

            const frames = Math.min(frameCount, affordable);
            if (frames < Math.min(frameCount, minimumAnimatedFrames)) continue;

            // Texels the image covers on each axis against the source pixels there, capped at
            // 1 because upscaling adds nothing. Their product is the fraction of source pixels kept.
            const detailX = Math.min(1, targetWidth * fitX / width);
            const detailY = Math.min(1, targetHeight * fitY / height);
            const detail = detailX * detailY;
            // The blurrier axis is what you see, so a lopsided texture only helps once the
            // other axis already holds the source at full resolution.
            const resolution = Math.min(detailX, detailY);
            const motion = frames / frameCount;
            const resolutionTerm = resolution ** weights.detail;
            const motionTerm = motion ** weights.motion;
            const score = Math.min(resolutionTerm, motionTerm);
            // Then whichever pick keeps more overall, then texels closer to square, then fewer bytes.
            const total = detail * motionTerm;
            const anisotropy = Math.abs(Math.log2(targetWidth / targetHeight));
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
    if (best) best.waste = 1 - fitX * fitY;
    return best;
}

// VTF has nowhere to store per-frame timing, so the engine plays frames at a fixed rate.
// Selecting by elapsed time rather than by index is what keeps a variable-delay GIF from
// being retimed, and it repeats a long-held frame across slots instead of dropping it.
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

function collectDurations(canvasKit, arrayBuffer, frameCount) {
    const scan = canvasKit.MakeAnimatedImageFromEncoded(arrayBuffer);
    const durations = [];

    for (let i = 0; i < frameCount; i++) {
        durations.push(Math.max(1, scan.currentFrameDuration() || 1));
        if (i < frameCount - 1) scan.decodeNextFrame();
    }

    scan.delete();
    return durations;
}

// Where the image goes in the texture: its place in the square decal, stretched onto the
// texture's grid, which the decal stretches back to square on the wall.
function destinationRect(canvasKit, width, height, targetWidth, targetHeight) {
    const {fitX, fitY} = squareFit(width, height);
    const scaledWidth = targetWidth * fitX;
    const scaledHeight = targetHeight * fitY;

    return canvasKit.LTRBRect(
        (targetWidth - scaledWidth) / 2,
        (targetHeight - scaledHeight) / 2,
        (targetWidth + scaledWidth) / 2,
        (targetHeight + scaledHeight) / 2);
}

// A MessageChannel round trip lets the page paint between frames. Unlike rAF and
// setTimeout it is not paused or throttled in a background tab.
function yieldToEventLoop() {
    return new Promise(resolve => {
        const {port1, port2} = new MessageChannel();
        port1.onmessage = () => {
            port1.close();
            resolve();
        };
        port2.postMessage(null);
    });
}

function drawLevel(canvasKit, entry, image, src, dst, qualityMode) {
    const {surface, canvas, info} = entry;
    canvas.clear(canvasKit.TRANSPARENT);
    if (qualityMode === qualityModeCubic)
        canvas.drawImageRectCubic(image, src, dst, 1 / 3, 1 / 3);
    else
        canvas.drawImageRectOptions(image, src, dst, qualityMode === qualityModeNearest ? canvasKit.FilterMode.Nearest : canvasKit.FilterMode.Linear, canvasKit.MipmapMode.None);
    surface.flush();
    return canvas.readPixels(0, 0, info);
}

/**
 * @param options {mipTrick, preference} where mipTrick is {arrayBuffer, swapPixels} for
 *                the image that takes over once the spray draws smaller than swapPixels.
 */
export async function convertImageToVTF(canvasKit, arrayBuffer, setProgress, qualityMode, options = {}) {
    const {mipTrick = null, preference = preferBalanced} = options;

    const pool = getEncoderPool();
    const surfaces = new Map();
    let animatedImage = null;
    let farImage = null;

    try {
        animatedImage = canvasKit.MakeAnimatedImageFromEncoded(arrayBuffer);
        if (!animatedImage) throw new Error("Could not decode the image");

        const frameCount = Math.max(1, animatedImage.getFrameCount());
        const width = animatedImage.width();
        const height = animatedImage.height();
        const srcRect = canvasKit.LTRBRect(0, 0, width, height);

        farImage = mipTrick ? canvasKit.MakeImageFromEncoded(mipTrick.arrayBuffer) : null;
        if (mipTrick && !farImage) throw new Error("Could not decode the distant image");
        const useMips = !!farImage;

        const target = chooseTarget(width, height, frameCount, useMips, preference);
        if (!target) throw new Error("Image cannot be fit inside the 512 KB spray limit");

        const {targetWidth, targetHeight, frames: nFrames} = target;

        // Only pay for the extra decode pass when frames actually have to be dropped.
        const frameIndices = nFrames < frameCount
            ? chooseFrameIndices(collectDurations(canvasKit, arrayBuffer, frameCount), nFrames)
            : null;

        const levelDimensions = useMips ? mipDimensions(targetWidth, targetHeight) : [[targetWidth, targetHeight]];
        const mipCount = levelDimensions.length;
        const flags = useMips ? baseFlags : baseFlags | flagNoMip;

        // Derived from the final size so "swap at 64px" survives whatever the fit chose.
        const swapLevel = useMips
            ? Math.min(mipCount - 1, Math.max(1,
                Math.round(Math.log2(Math.max(targetWidth, targetHeight) / mipTrick.swapPixels))))
            : mipCount;

        console.log(`Chose ${targetWidth}x${targetHeight}, ${nFrames}/${frameCount} frames, ` +
            `${(target.waste * 100).toFixed(0)}% padding, ${target.cost + headerSize} bytes`);
        if (useMips) console.log(`Distant image from mip ${swapLevel} (${levelDimensions[swapLevel].join("x")}) down`);

        const surfaceFor = (width, height) => {
            const key = `${width}x${height}`;
            let entry = surfaces.get(key);
            if (!entry) {
                const surface = canvasKit.MakeSurface(width, height);
                entry = {surface, canvas: surface.getCanvas(), info: surface.imageInfo()};
                surfaces.set(key, entry);
            }
            return entry;
        };

        const levels = levelDimensions.map(([w, h], level) => {
            const renderWidth = Math.max(minBlockDimension, w);
            const renderHeight = Math.max(minBlockDimension, h);
            return {level, renderWidth, renderHeight, near: destinationRect(canvasKit, width, height, renderWidth, renderHeight)};
        });
        const nearLevels = levels.slice(0, swapLevel);
        const farLevels = levels.slice(swapLevel);

        // VTF stores mips smallest first with every frame of a level together, so the levels
        // stay separate until assembly rather than being pushed as one flat list.
        const mipFrames = levels.map(() => new Array(nFrames));
        const totalWork = nFrames * nearLevels.length + farLevels.length;
        let completed = 0;

        const encodeLevel = (level, pixels, store) => pool
            .encode(level.renderWidth, level.renderHeight, pixels)
            .then(blocks => {
                store(blocks);
                completed += 1;
                setProgress(completed / totalWork);
            });

        // The distant image is the same in every frame, so its levels are encoded once
        // and the blocks shared across frames.
        const farSrcRect = farImage ? canvasKit.LTRBRect(0, 0, farImage.width(), farImage.height()) : null;
        const farWork = Promise.all(farLevels.map(level => {
            const dst = destinationRect(canvasKit, farImage.width(), farImage.height(), level.renderWidth, level.renderHeight);
            const pixels = drawLevel(canvasKit, surfaceFor(level.renderWidth, level.renderHeight), farImage, farSrcRect, dst, qualityMode);
            return encodeLevel(level, pixels, blocks => mipFrames[level.level].fill(blocks));
        }));
        farWork.catch(() => {});   // surfaced when awaited below, not as an unhandled rejection

        // Bounded so a long animation does not hold every frame's pixels at once, and
        // so the decoder never runs far ahead of the workers.
        const maxFramesInFlight = pool.size * 2;
        const inFlight = [farWork];
        let sourceIndex = 0;

        for (let emitted = 0; emitted < nFrames; emitted++) {
            const wanted = frameIndices ? frameIndices[emitted] : emitted;
            while (sourceIndex < wanted) {
                animatedImage.decodeNextFrame();
                sourceIndex += 1;
            }

            const frame = animatedImage.makeImageAtCurrentFrame();
            const frameWork = [];
            try {
                for (const level of nearLevels) {
                    const pixels = drawLevel(canvasKit, surfaceFor(level.renderWidth, level.renderHeight), frame, srcRect, level.near, qualityMode);
                    frameWork.push(encodeLevel(level, pixels, blocks => mipFrames[level.level][emitted] = blocks));
                }
            } finally {
                frame.delete();
            }

            const work = Promise.all(frameWork);
            work.catch(() => {});
            inFlight.push(work);

            if (inFlight.length > maxFramesInFlight) await inFlight.shift();
            else await yieldToEventLoop();
        }

        await Promise.all(inFlight);
        setProgress(1);
        console.log('Completed');

        const buffers = [];
        for (let level = mipCount - 1; level >= 0; level--) buffers.push(...mipFrames[level]);

        const header = buildHeader(targetWidth, targetHeight, nFrames, mipCount, flags);
        return {
            blob: new Blob([header, ...buffers], {type: "application/binary"}),
            width: targetWidth,
            height: targetHeight,
            frames: nFrames,
            sourceFrames: frameCount,
            mipCount,
            padding: target.waste,
            bytes: target.cost + headerSize,
            swapLevel: useMips ? swapLevel : null,
            swapDimension: useMips ? Math.max(...levelDimensions[swapLevel]) : null,
        };
    } finally {
        for (const {surface} of surfaces.values()) surface.delete();
        farImage?.delete();
        animatedImage?.delete();
    }
}
