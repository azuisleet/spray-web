/* global ImageDecoder -- WebCodecs, newer than the eslint browser globals */
import {decodeGifFrames, parseGif} from "./gif.js";

// JPEG and friends go through createImageBitmap, which is also what applies EXIF rotation.
const animatableTypes = ["image/gif", "image/png", "image/apng", "image/webp", "image/avif"];

/**
 * Opens an image file as a sequence of RGBA frames, using whatever this browser offers:
 *
 *  - GIF: our own decoder, which reads every frame's delay without decoding pixels and
 *    behaves the same in every browser.
 *  - Other animated formats (WebP, APNG, AVIF): WebCodecs ImageDecoder where available.
 *  - Everything else, or browsers without ImageDecoder: createImageBitmap, first frame only.
 *
 * @returns {width, height, frameCount, durations(): Promise<number[]> (ms),
 *           frames(wanted): async iterator of [index, rgba], close()}
 *          frames() takes ascending indices; each rgba buffer is only valid until the next.
 */
export async function openImage(blob, {nativeGif = false} = {}) {
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
