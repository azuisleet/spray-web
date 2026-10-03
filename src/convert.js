import {hasSoftAlpha, isOpaque} from "./alpha.js";
import {openImage} from "./decode.js";
import {getEncoderPool} from "./encoderPool.js";
import {
    chooseFrameIndices, chooseSwapLevel, chooseTarget, engineFrameRate, fitGeometry, fitPad, placeTarget,
    preferBalanced, targetFrameCount,
} from "./plan.js";
import {filterNearest, filterSmooth} from "./resample.js";
import {formatBGR888, textureFormats} from "./textureFormats.js";
import {baseFlags, buildHeader, flagEightBitAlpha, flagNoMip, flagOneBitAlpha, flagPointSample, headerSize, mipDimensions} from "./vtf.js";

// Levels under 4x4 still cost a whole DXT1 block, so they are drawn at 4x4.
const minBlockDimension = 4;

// Share of the progress bar given to opening the image, before any strip is finished.
const openedShare = 0.1;

// Longest side of the thumbnail probeImage returns, unless asked for another.
const defaultThumbnailSize = 512;

/**
 * Reads what planning needs from an image without converting it, plus a thumbnail of the
 * first frame for showing the source.
 *
 * @returns {width, height, frameCount, durations (ms), thumbnail: ImageBitmap, softAlpha,
 *          opaque, video}, where softAlpha says the first frame has partial transparency
 *          worth keeping, opaque that it has no transparency at all, and video is
 *          {duration} in seconds for a video, else null
 */
export async function probeImage(file, {signal, thumbnailSize = defaultThumbnailSize} = {}) {
    const image = await openImage(file);
    try {
        const durations = image.frameCount > 1 ? await image.durations() : [0];
        signal?.throwIfAborted();

        let thumbnail = null;
        let softAlpha = false;
        let opaque = false;
        // Videos often open on a fade or a title, so theirs comes from the middle.
        const thumbnailFrame = image.duration !== undefined ? Math.floor(image.frameCount / 2) : 0;
        for await (const [, pixels] of image.frames([thumbnailFrame])) {
            softAlpha = hasSoftAlpha(pixels);
            opaque = isOpaque(pixels);
            const scale = Math.min(1, thumbnailSize / Math.max(image.width, image.height));
            thumbnail = await createImageBitmap(new ImageData(new Uint8ClampedArray(pixels), image.width, image.height), {
                resizeWidth: Math.max(1, Math.round(image.width * scale)),
                resizeHeight: Math.max(1, Math.round(image.height * scale)),
                resizeQuality: "high",
            });
        }

        // A video's length lets the caller choose a span; its timings depend on that span.
        const video = image.duration !== undefined ? {duration: image.duration} : null;
        return {width: image.width, height: image.height, frameCount: image.frameCount, durations, thumbnail, softAlpha, opaque, video};
    } finally {
        image.close();
    }
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

/**
 * Converts an image file into a spray.
 *
 * @param file Blob of the image; its type picks the decoder
 * @param options
 *   mipTrick   {file, swapPixels, focus}: an image that takes over once the spray draws smaller
 *              than swapPixels on screen
 *   preference preferBalanced, preferDetail or preferMotion, for when it will not all fit
 *   fit        fitPad, fitCrop or fitStretch: how the image meets the square decal
 *   focus      {x, y} in 0..1, which part of the image a crop keeps
 *   softEdges  keep 8-bit alpha (DXT5) so soft edges and partial transparency survive
 *   pixelArt   whole pixels only, point sampled in game, uncompressed when that costs
 *              nothing; ignored for a mip trick
 *   opaque     the image has no transparency, as probeImage found from one frame: pixel
 *              art may then be stored without alpha. Should another frame turn out to
 *              have some, the conversion starts again without it.
 *   trim       {start, end} in seconds: the span of a video to use (default: its start)
 *   keepAllFrames  plan for every source frame rather than for real-time playback at
 *              the engine's 5 fps; the spray then plays slower than the original
 *   signal     AbortSignal; aborting rejects with signal.reason
 *   onProgress called with 0..1
 * @returns {blob, levels, width, height, frames, sourceFrames, mipCount, padding, bytes,
 *           swapLevel, swapDimension, format, pointSample, pixelScale, playSeconds,
 *           sourceSeconds}, where
 *           levels[level][frame] is the DXT1 data
 */
export async function convertImage(file, options = {}) {
    const {signal} = options;
    // Each attempt has its own signal, so the work of one abandoned for transparency is
    // cancelled and stops reporting progress.
    const attempt = async (opaque) => {
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        if (signal?.aborted) abort();
        signal?.addEventListener("abort", abort);
        try {
            return await convertOnce(file, {...options, opaque, signal: controller.signal});
        } catch (error) {
            if (!(error instanceof NotOpaqueError)) throw error;
            controller.abort(error);
            signal?.throwIfAborted();
            return null;
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    };
    return (options.opaque && await attempt(true)) || attempt(false);
}

// A frame with transparency, found while converting for an opaque format.
class NotOpaqueError extends Error {}

async function convertOnce(file, options) {
    const {
        mipTrick = null,
        preference = preferBalanced,
        fit = fitPad,
        focus,
        keepAllFrames = false,
        softEdges = false,
        pixelArt = false,
        opaque = false,
        trim,
        signal,
        onProgress = () => {},
    } = options;

    const pool = getEncoderPool();
    let image = null;
    let farImage = null;

    try {
        image = await openImage(file, {trim});
        farImage = mipTrick ? await openImage(mipTrick.file) : null;
        signal?.throwIfAborted();
        // A still is decoded by now, often the longest single step, so say so before the
        // strip by strip progress below takes over the rest.
        onProgress(openedShare);

        const {width, height, frameCount} = image;
        const useMips = !!farImage;

        // For some decoders the timings cost a pass of their own, so a still skips them.
        const durations = frameCount > 1 ? await image.durations() : [0];
        signal?.throwIfAborted();
        const wantedFrames = targetFrameCount(durations, {keepAllFrames});

        const target = chooseTarget(width, height, wantedFrames, {useMips, preference, fit, softEdges, pixelArt, opaque});
        if (!target) throw new Error("Image cannot be fit inside the 512 KB spray limit");

        const {targetWidth, targetHeight, frames: nFrames} = target;

        // Keeping every frame means one slot each, in order; otherwise slots are chosen by
        // time, which drops or repeats frames to match the engine's fixed rate.
        const frameIndices = keepAllFrames && nFrames === frameCount
            ? Array.from({length: nFrames}, (_, i) => i)
            : chooseFrameIndices(durations, nFrames);

        const levelDimensions = useMips ? mipDimensions(targetWidth, targetHeight) : [[targetWidth, targetHeight]];
        const mipCount = levelDimensions.length;
        const {format} = target;
        const pointSample = !!target.pixel;
        // The format decides which alpha flag fits; pixel art is point sampled so it stays
        // blocky up close.
        let flags = (baseFlags & ~(flagOneBitAlpha | flagEightBitAlpha)) | textureFormats[format].alphaFlag;
        if (!useMips) flags |= flagNoMip;
        if (pointSample) flags |= flagPointSample;
        const filter = pointSample ? filterNearest : filterSmooth;
        const swapLevel = useMips ? chooseSwapLevel(targetWidth, targetHeight, mipTrick.swapPixels) : mipCount;

        const levelFor = (geometry) => ([w, h]) => {
            const level = {width: Math.max(minBlockDimension, w), height: Math.max(minBlockDimension, h)};
            return {...level, format, placement: {...placeTarget(geometry, target, level.width, level.height), filter}};
        };
        const nearLevels = levelDimensions.slice(0, swapLevel).map(levelFor(fitGeometry(width, height, fit, focus)));
        const farLevels = farImage
            ? levelDimensions.slice(swapLevel).map(levelFor(fitGeometry(farImage.width, farImage.height, fit, mipTrick.focus)))
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
        // Progress counts finished pixels, a strip at a time, so a single large level moves
        // steadily rather than jumping from nothing to done.
        const pixelsOf = (list) => list.reduce((sum, level) => sum + level.width * level.height, 0);
        const totalPixels = slotsByIndex.size * pixelsOf(nearLevels) + pixelsOf(farLevels);
        let finishedPixels = 0;

        const render = (source, level) => pool.render(source, level, signal, (pixels) => {
            finishedPixels += pixels;
            if (!signal?.aborted) onProgress(openedShare + (1 - openedShare) * finishedPixels / totalPixels);
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
            if (format === formatBGR888 && !isOpaque(pixels)) throw new NotOpaqueError("A frame has transparency");
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
            blob: new Blob([buildHeader(targetWidth, targetHeight, nFrames, mipCount, flags, textureFormats[format].vtf), ...buffers], {type: "application/octet-stream"}),
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
            format,
            pointSample,
            pixelScale: target.pixel?.scale ?? null,
            video: image.duration !== undefined,
            playSeconds: nFrames / engineFrameRate,
            sourceSeconds: durations.reduce((sum, d) => sum + d, 0) / 1000,
        };
    } finally {
        image?.close();
        farImage?.close();
    }
}
