import {openImage} from "./decode.js";
import {getEncoderPool} from "./encoderPool.js";
import {
    chooseFrameIndices, chooseSwapLevel, chooseTarget, engineFrameRate, fitGeometry, fitPad, placeInTexture,
    preferBalanced, targetFrameCount,
} from "./plan.js";
import {baseFlags, buildHeader, flagNoMip, headerSize, mipDimensions} from "./vtf.js";

// Levels under 4x4 still cost a whole DXT1 block, so they are drawn at 4x4.
const minBlockDimension = 4;

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

/**
 * Converts an image file into a spray.
 *
 * @param file Blob of the image; its type picks the decoder
 * @param options
 *   mipTrick   {file, swapPixels}: an image that takes over once the spray draws smaller
 *              than swapPixels on screen
 *   preference preferBalanced, preferDetail or preferMotion, for when it will not all fit
 *   fit        fitPad, fitCrop or fitStretch: how the image meets the square decal
 *   focus      {x, y} in 0..1, which part of the image a crop keeps
 *   keepAllFrames  plan for every source frame rather than for real-time playback at
 *              the engine's 5 fps; the spray then plays slower than the original
 *   signal     AbortSignal; aborting rejects with signal.reason
 *   onProgress called with 0..1
 * @returns {blob, levels, width, height, frames, sourceFrames, mipCount, padding, bytes,
 *           swapLevel, swapDimension, playSeconds, sourceSeconds}, where
 *           levels[level][frame] is the DXT1 data
 */
export async function convertImage(file, options = {}) {
    const {
        mipTrick = null,
        preference = preferBalanced,
        fit = fitPad,
        focus,
        keepAllFrames = false,
        signal,
        onProgress = () => {},
    } = options;

    const pool = getEncoderPool();
    let image = null;
    let farImage = null;

    try {
        image = await openImage(file);
        farImage = mipTrick ? await openImage(mipTrick.file) : null;
        signal?.throwIfAborted();

        const {width, height, frameCount} = image;
        const useMips = !!farImage;

        // For some decoders the timings cost a pass of their own, so a still skips them.
        const durations = frameCount > 1 ? await image.durations() : [0];
        signal?.throwIfAborted();
        const wantedFrames = targetFrameCount(durations, {keepAllFrames});

        const target = chooseTarget(width, height, wantedFrames, {useMips, preference, fit});
        if (!target) throw new Error("Image cannot be fit inside the 512 KB spray limit");

        const {targetWidth, targetHeight, frames: nFrames} = target;

        // Keeping every frame means one slot each, in order; otherwise slots are chosen by
        // time, which drops or repeats frames to match the engine's fixed rate.
        const frameIndices = keepAllFrames && nFrames === frameCount
            ? Array.from({length: nFrames}, (_, i) => i)
            : chooseFrameIndices(durations, nFrames);

        const levelDimensions = useMips ? mipDimensions(targetWidth, targetHeight) : [[targetWidth, targetHeight]];
        const mipCount = levelDimensions.length;
        const flags = useMips ? baseFlags : baseFlags | flagNoMip;
        const swapLevel = useMips ? chooseSwapLevel(targetWidth, targetHeight, mipTrick.swapPixels) : mipCount;

        const levelFor = (geometry) => ([w, h]) => {
            const level = {width: Math.max(minBlockDimension, w), height: Math.max(minBlockDimension, h)};
            return {...level, placement: placeInTexture(geometry, level.width, level.height)};
        };
        const nearLevels = levelDimensions.slice(0, swapLevel).map(levelFor(fitGeometry(width, height, fit, focus)));
        const farLevels = farImage
            ? levelDimensions.slice(swapLevel).map(levelFor(fitGeometry(farImage.width, farImage.height, fit, focus)))
            : [];

        // A long-held source frame can fill several slots; it is encoded once and shared.
        const slotsByIndex = new Map();
        frameIndices.forEach((index, slot) => {
            if (!slotsByIndex.has(index)) slotsByIndex.set(index, []);
            slotsByIndex.get(index).push(slot);
        });

        // VTF stores mips smallest first with every frame of a level together, so the levels
        // stay separate until assembly rather than being pushed as one flat list.
        const levels = levelDimensions.map(() => new Array(nFrames));
        const totalWork = slotsByIndex.size * nearLevels.length + farLevels.length;
        let completed = 0;

        const render = (source, level) => pool.render(source, level, signal).then(blocks => {
            completed += 1;
            onProgress(completed / totalWork);
            return blocks;
        });

        // The distant image is the same in every frame, so its levels are encoded once
        // and the blocks shared across frames.
        const farWork = [];
        if (farImage) {
            for await (const [, pixels] of farImage.frames([0])) {
                const source = {pixels, width: farImage.width, height: farImage.height};
                farLevels.forEach((level, n) => farWork.push(
                    render(source, level).then(blocks => levels[swapLevel + n].fill(blocks))));
            }
        }
        const farDone = Promise.all(farWork);
        farDone.catch(() => {});   // surfaced when awaited below, not as an unhandled rejection

        // Bounded so a long animation does not hold every frame's pixels at once, and
        // so the decoder never runs far ahead of the workers.
        const maxFramesInFlight = pool.size * 2;
        const inFlight = [farDone];

        for await (const [index, pixels] of image.frames([...slotsByIndex.keys()])) {
            signal?.throwIfAborted();
            const source = {pixels, width, height};
            const slots = slotsByIndex.get(index);
            const work = Promise.all(nearLevels.map((level, n) => render(source, level).then(blocks => {
                for (const slot of slots) levels[n][slot] = blocks;
            })));
            work.catch(() => {});
            inFlight.push(work);

            if (inFlight.length > maxFramesInFlight) await inFlight.shift();
            else await yieldToEventLoop();
        }

        await Promise.all(inFlight);
        if (levels.some(frames => frames.includes(undefined))) throw new Error("The image ended before all its frames were read");
        onProgress(1);

        const buffers = [];
        for (let level = mipCount - 1; level >= 0; level--) buffers.push(...levels[level]);

        return {
            blob: new Blob([buildHeader(targetWidth, targetHeight, nFrames, mipCount, flags), ...buffers], {type: "application/octet-stream"}),
            levels,
            width: targetWidth,
            height: targetHeight,
            frames: nFrames,
            sourceFrames: frameCount,
            mipCount,
            padding: target.waste,
            bytes: target.cost + headerSize,
            swapLevel: useMips ? swapLevel : null,
            swapDimension: useMips ? Math.max(...levelDimensions[swapLevel]) : null,
            playSeconds: nFrames / engineFrameRate,
            sourceSeconds: durations.reduce((sum, d) => sum + d, 0) / 1000,
        };
    } finally {
        image?.close();
        farImage?.close();
    }
}
