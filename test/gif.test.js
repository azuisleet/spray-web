import {createHash} from "crypto";
import {readFileSync} from "fs";
import {describe, expect, it} from "vitest";
import {decodeGifFrames, parseGif} from "../src/gif.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/skia/${name}`, import.meta.url))).buffer;

function decodeAll(gif) {
    const hash = createHash("sha256");
    let frames = 0;
    for (const [, pixels] of decodeGifFrames(gif, gif.frames.map((_, i) => i))) {
        hash.update(pixels);
        frames++;
    }
    return {frames, sha256: hash.digest("hex").slice(0, 16)};
}

// Hashes of every composited frame, from output confirmed identical to Chrome's decoder.
const expected = [
    {file: "alphabetAnim.gif", width: 100, height: 100, durations: Array(13).fill(100), sha256: "9e8f18600b53e802"},
    {file: "gif-transparent-index.gif", width: 4, height: 2, durations: [100, 200], sha256: "21304c0d1e7015a2"},
    {file: "out-of-palette.gif", width: 2, height: 2, durations: [100], sha256: "1bf272bf943f77fa"},
    {file: "randPixelsAnim.gif", width: 16, height: 16, durations: [100, 1000, 170, 40, 220, 7770, 90, 90, 90, 90, 90, 90, 90], sha256: "17e9b182fb781566"},
    {file: "randPixelsAnim2.gif", width: 8, height: 8, durations: [100, 1000, 170, 40], sha256: "fb57bc5f634d7371"},
    {file: "required.gif", width: 100, height: 100, durations: Array(7).fill(100), sha256: "894e38772eb1aa22"},
    {file: "test640x479.gif", width: 640, height: 479, durations: [200, 200, 200, 200], sha256: "4d3e939fff3dc9ca"},
    {file: "xOffsetTooBig.gif", width: 100, height: 90, durations: [100, 100], sha256: "9ac9ee0bee150042"},
];

describe("parseGif and decodeGifFrames", () => {
    it.each(expected)("decodes $file like Chrome", ({file, width, height, durations, sha256}) => {
        const gif = parseGif(fixture(file));
        expect([gif.width, gif.height]).toEqual([width, height]);
        expect(gif.frames.map(frame => frame.duration)).toEqual(durations);
        expect(decodeAll(gif)).toEqual({frames: durations.length, sha256});
    });

    it("yields only the wanted frames, once each, in order", () => {
        const gif = parseGif(fixture("alphabetAnim.gif"));
        const seen = [...decodeGifFrames(gif, [2, 2, 5, 12])].map(([index]) => index);
        expect(seen).toEqual([2, 5, 12]);
    });

    it("rejects files that are not GIFs", () => {
        expect(() => parseGif(new TextEncoder().encode("PNG not a gif").buffer)).toThrow("Not a GIF");
    });

    it("keeps what it can of a truncated file", () => {
        const whole = new Uint8Array(fixture("test640x479.gif"));
        const gif = parseGif(whole.slice(0, Math.floor(whole.length * 0.6)).buffer);
        expect(gif.frames.length).toBeGreaterThan(0);
        expect(() => decodeAll(gif)).not.toThrow();
    });
});
