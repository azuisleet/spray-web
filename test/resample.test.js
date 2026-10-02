import {describe, expect, it} from "vitest";
import {resampleRows, sourceRowRange, verticalTaps} from "../src/resample.js";

function image(width, height, pixel) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) pixels.set(pixel(x, y), (y * width + x) * 4);
    }
    return {pixels, width, height, rowOffset: 0};
}

const full = (width, height) => ({x0: 0, y0: 0, x1: width, y1: height});
const render = (source, width, height, placement) => resampleRows(source, width, height, placement, 0, height);
const pixelAt = (pixels, width, x, y) => [...pixels.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

describe("resampleRows", () => {
    it("leaves an image untouched at the same size", () => {
        const source = image(8, 8, (x, y) => [x * 30, y * 30, (x * y) % 256, 255]);
        expect([...render(source, 8, 8, {src: full(8, 8), dst: full(8, 8)})]).toEqual([...source.pixels]);
    });

    it("keeps a flat colour flat however far it shrinks", () => {
        const source = image(64, 48, () => [200, 100, 50, 255]);
        const out = render(source, 4, 4, {src: full(64, 48), dst: full(4, 4)});
        for (let i = 0; i < out.length; i += 4) expect([...out.subarray(i, i + 4)]).toEqual([200, 100, 50, 255]);
    });

    it("averages detail away rather than aliasing it", () => {
        // One-pixel stripes reduce to a flat mid grey, not to whichever stripe gets sampled.
        // The border columns lean a little because mirroring repeats the edge pixel, which
        // for stripes this fine is as unfavourable as it gets.
        const source = image(64, 64, (x) => x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
        const out = render(source, 8, 8, {src: full(64, 64), dst: full(8, 8)});
        for (let y = 0; y < 8; y++) {
            for (let x = 0; x < 8; x++) {
                const allowed = x === 0 || x === 7 ? 12 : 2;
                expect(Math.abs(pixelAt(out, 8, x, y)[0] - 128)).toBeLessThanOrEqual(allowed);
            }
        }
    });

    it("leaves padding transparent and the image opaque", () => {
        const source = image(8, 4, () => [10, 20, 30, 255]);
        const out = render(source, 8, 8, {src: full(8, 4), dst: {x0: 0, y0: 2, x1: 8, y1: 6}});
        for (const y of [0, 1, 6, 7]) expect(pixelAt(out, 8, 3, y)[3]).toBe(0);
        for (const y of [2, 3, 4, 5]) expect(pixelAt(out, 8, 3, y)).toEqual([10, 20, 30, 255]);
    });

    it("draws only the cropped part of the source", () => {
        const source = image(8, 4, (x) => x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
        const out = render(source, 4, 4, {src: {x0: 4, y0: 0, x1: 8, y1: 4}, dst: full(4, 4)});
        for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(pixelAt(out, 4, x, y)).toEqual([0, 0, 255, 255]);
    });

    it("never lets the colour of transparent pixels bleed in", () => {
        const source = image(16, 16, (x) => x < 8 ? [255, 0, 0, 255] : [0, 255, 0, 0]);
        const out = render(source, 4, 4, {src: full(16, 16), dst: full(4, 4)});
        for (let i = 0; i < out.length; i += 4) {
            if (out[i + 3] > 0) expect([out[i], out[i + 1], out[i + 2]]).toEqual([255, 0, 0]);
        }
    });

    it("gives the same result rendered in strips from just the rows each needs", () => {
        // This is how the worker pool splits a level.
        const source = image(37, 53, (x, y) => [(x * 7) % 256, (y * 5) % 256, (x * y) % 256, (x + y) % 3 ? 255 : 0]);
        const placement = {src: full(37, 53), dst: {x0: 1.5, y0: 2.25, x1: 22.5, y1: 17.75}};
        const whole = render(source, 24, 20, placement);

        const taps = verticalTaps(53, 20, placement);
        const strips = [];
        for (let rowStart = 0; rowStart < 20; rowStart += 4) {
            const [first, end] = sourceRowRange(taps, rowStart, rowStart + 4);
            const rows = {...source, pixels: source.pixels.slice(first * 37 * 4, end * 37 * 4), rowOffset: first};
            strips.push(...resampleRows(rows, 24, 20, placement, rowStart, 4));
        }
        expect(strips).toEqual([...whole]);
    });
});

describe("resampleRows with the nearest filter", () => {
    it("copies whole pixels at the same size and picks one per block when shrinking by a whole factor", () => {
        const source = image(8, 8, (x, y) => [x * 30, y * 30, 100, 255]);
        const same = render(source, 8, 8, {src: full(8, 8), dst: full(8, 8), filter: "nearest"});
        expect([...same]).toEqual([...source.pixels]);

        const half = render(source, 4, 4, {src: full(8, 8), dst: full(4, 4), filter: "nearest"});
        // Texel (1, 2) covers source pixels 2-3 and 4-5; its centre falls on (3, 5).
        expect(pixelAt(half, 4, 1, 2)).toEqual([90, 150, 100, 255]);
    });

    it("never blends neighbours, even at the edge of padding", () => {
        const source = image(4, 2, (x) => x % 2 ? [255, 255, 255, 255] : [0, 0, 0, 255]);
        const out = render(source, 4, 4, {src: full(4, 2), dst: {x0: 0, y0: 1, x1: 4, y1: 3}, filter: "nearest"});
        for (let i = 0; i < out.length; i += 4) {
            if (out[i + 3]) expect([0, 255]).toContain(out[i]);
        }
        expect(pixelAt(out, 4, 0, 0)[3]).toBe(0);
    });
});
