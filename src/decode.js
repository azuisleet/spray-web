import {decodeGifFrames, parseGif} from "./gif.js";

// JPEG and friends go through createImageBitmap, which is also what applies EXIF rotation.
const animatableTypes = ["image/gif", "image/png", "image/apng", "image/webp", "image/avif"];

// Videos have no frame list to read, and browsers do not report their frame rate, so a
// video is treated as frames on a fixed grid this fine. The planner only ever wants 5 a
// second (the engine's rate) and picks among these by time, as it does for GIF frames.
export const videoFrameRate = 30;

// How much of a long video is used unless a different span is chosen: past this, 512 KB
// spread over the frames leaves little resolution for each.
const defaultVideoSeconds = 6;

/** The span of a video used by default: the start, up to defaultVideoSeconds long. */
export function defaultTrim(duration) {
    return {start: 0, end: Math.min(duration, defaultVideoSeconds)};
}

/** Frame timings for seconds of video on the frame grid, as a GIF would give them. */
export function videoDurations(seconds) {
    return Array(Math.max(1, Math.round(seconds * videoFrameRate))).fill(1000 / videoFrameRate);
}

/**
 * Opens an image file as a sequence of RGBA frames, using whatever this browser offers:
 *
 *  - GIF: our own decoder, which reads every frame's delay without decoding pixels and
 *    behaves the same in every browser.
 *  - Other animated formats (WebP, APNG, AVIF): WebCodecs ImageDecoder where available.
 *  - Everything else, or browsers without ImageDecoder: createImageBitmap, first frame only.
 *  - Video: a <video> element, seeked to each frame's time; trim picks the span used.
 *
 * @returns {width, height, frameCount, durations(): Promise<number[]> (ms),
 *           frames(wanted): async iterator of [index, rgba], close()}
 *          frames() takes ascending indices; each rgba buffer is only valid until the next.
 */
export async function openImage(blob, {nativeGif = false, trim} = {}) {
    if (blob.type.startsWith("video/")) return openVideo(blob, trim);
    if (blob.type === "image/gif" && !nativeGif) return openGif(blob);
    if (animatableTypes.includes(blob.type) && typeof ImageDecoder !== "undefined"
        && await ImageDecoder.isTypeSupported(blob.type)) {
        return openWithImageDecoder(blob);
    }
    return openStill(blob);
}

async function openGif(blob) {
    const gif = parseGif(await blob.arrayBuffer());
    return {
        width: gif.width,
        height: gif.height,
        frameCount: gif.frames.length,
        durations: async () => gif.frames.map(frame => frame.duration),
        async* frames(wanted) {
            yield* decodeGifFrames(gif, wanted);
        },
        close() {},
    };
}

function makeReader(width, height) {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d", {willReadFrequently: true});
    return (image) => {
        context.clearRect(0, 0, width, height);
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, width, height).data;
    };
}

async function openWithImageDecoder(blob) {
    const decoder = new ImageDecoder({data: blob.stream(), type: blob.type});
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    const frameCount = Math.max(1, track.frameCount);

    const first = (await decoder.decode({frameIndex: 0})).image;
    const width = first.displayWidth;
    const height = first.displayHeight;
    first.close();

    const read = makeReader(width, height);

    return {
        width,
        height,
        frameCount,
        // ImageDecoder only reports a frame's duration once it is decoded, so this costs a
        // full pass; the caller only asks when frames have to be dropped.
        async durations() {
            const durations = [];
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex++) {
                const {image} = await decoder.decode({frameIndex});
                durations.push(image.duration ? image.duration / 1000 : 100);
                image.close();
            }
            return durations;
        },
        async* frames(wanted) {
            let last = -1;
            for (const frameIndex of wanted) {
                if (frameIndex === last) continue;
                last = frameIndex;
                const {image} = await decoder.decode({frameIndex});
                try {
                    yield [frameIndex, read(image)];
                } finally {
                    image.close();
                }
            }
        },
        close() {
            decoder.close();
        },
    };
}

async function openStill(blob) {
    const bitmap = await createImageBitmap(blob);
    const {width, height} = bitmap;
    const pixels = makeReader(width, height)(bitmap);
    bitmap.close();

    return {
        width,
        height,
        frameCount: 1,
        durations: async () => [100],
        async* frames() {
            yield [0, pixels];
        },
        close() {},
    };
}

// Resolves on event, or rejects on the element's error event.
function once(element, event) {
    return new Promise((resolve, reject) => {
        const done = () => {
            element.removeEventListener(event, done);
            element.removeEventListener("error", failed);
            resolve();
        };
        const failed = () => {
            element.removeEventListener(event, done);
            element.removeEventListener("error", failed);
            reject(new Error("This browser cannot play the video"));
        };
        element.addEventListener(event, done);
        element.addEventListener("error", failed);
    });
}

async function seek(video, time) {
    if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return;
    const seeked = once(video, "seeked");
    video.currentTime = time;
    await seeked;
}

async function openVideo(blob, trim) {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    try {
        const loaded = once(video, "loadeddata");
        video.src = url;
        await loaded;

        // Some recordings do not state their length up front; seeking to the end makes the
        // browser work it out.
        if (!Number.isFinite(video.duration)) {
            await seek(video, 1e9);
            await seek(video, 0);
        }
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }

    const duration = video.duration;
    const {start, end} = trim ?? defaultTrim(duration);
    const from = Math.max(0, Math.min(start, duration));
    const to = Math.max(from, Math.min(end, duration));
    const durations = videoDurations(to - from);
    const width = video.videoWidth;
    const height = video.videoHeight;
    const read = makeReader(width, height);

    return {
        width,
        height,
        frameCount: durations.length,
        duration,
        durations: async () => durations,
        async* frames(wanted) {
            let last = -1;
            for (const index of wanted) {
                if (index === last) continue;
                last = index;
                // The middle of the frame's slot, which never lands on a boundary.
                await seek(video, Math.min(to, from + (index + 0.5) / videoFrameRate));
                yield [index, read(video)];
            }
        },
        close() {
            video.removeAttribute("src");
            video.load();
            URL.revokeObjectURL(url);
        },
    };
}
