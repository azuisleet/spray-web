import {describe, expect, it} from "vitest";
import {alphaThreshold, decodeDXT1, encodeDXT1} from "../src/dxt1.js";

// Small deterministic generator so the images are the same on every run.
function random(seed) {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 2 ** 32;
    };
}

function image(width, height, pixel) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
    }
    return rgba;
}

function psnr(source, decoded) {
    let squared = 0, count = 0;
    for (let i = 0; i < source.length; i += 4) {
        if (source[i + 3] < alphaThreshold) continue;
        for (let c = 0; c < 3; c++) squared += (source[i + c] - decoded[i + c]) ** 2;
        count += 3;
    }
    return 10 * Math.log10(255 ** 2 / (squared / count));
}

const roundTrip = (width, height, rgba) => decodeDXT1(width, height, encodeDXT1(width, height, rgba));

describe("encodeDXT1", () => {
    it("stores 8 bytes per 4x4 block", () => {
        expect(encodeDXT1(16, 8, new Uint8Array(16 * 8 * 4)).length).toBe(4 * 2 * 8);
    });

    it("refuses sizes that are not whole blocks", () => {
        expect(() => encodeDXT1(6, 4, new Uint8Array(6 * 4 * 4))).toThrow("divisible by 4");
    });

    it("reproduces colours that 565 can hold exactly", () => {
        for (const colour of [[255, 0, 0], [0, 255, 255], [8, 4, 8], [132, 130, 132], [255, 255, 255], [0, 0, 0]]) {
            const decoded = roundTrip(4, 4, image(4, 4, () => [...colour, 255]));
            expect([...decoded.subarray(0, 3)]).toEqual(colour);
        }
    });

    it("gets any solid colour within 2 levels", () => {
        const next = random(1);
        for (let n = 0; n < 200; n++) {
            const colour = [next() * 256 | 0, next() * 256 | 0, next() * 256 | 0];
            const decoded = roundTrip(4, 4, image(4, 4, () => [...colour, 255]));
            for (let c = 0; c < 3; c++) expect(Math.abs(decoded[c] - colour[c])).toBeLessThanOrEqual(2);
        }
    });

    it("keeps 1-bit alpha exact: no holes in opaque areas, nothing showing in transparent ones", () => {
        const next = random(2);
        // Dark, nearly flat blocks are where quantised endpoints can end up equal, which
        // selects the palette mode whose fourth entry is transparent.
        const rgba = image(64, 64, (x, y) => {
            const shade = (x + y) / 16 + next() * 3;
            const alpha = (x * 7 + y * 3) % 23 < 5 ? 0 : 255;
            return [shade, shade, shade + 1, alpha];
        });
        const decoded = roundTrip(64, 64, rgba);
        for (let i = 3; i < rgba.length; i += 4) expect(decoded[i]).toBe(rgba[i] >= alphaThreshold ? 255 : 0);
    });

    it.each([
        ["smooth gradient", (x, y) => [x * 2, y * 2, 255 - x - y, 255], 42],
        ["gradient with noise", (x, y, next) => [x * 2 + next() * 24, y * 2, (x ^ y) & 255, 255], 30],
        ["hard edges", (x, y) => ((x >> 3) + (y >> 3)) % 2 ? [230, 40, 30, 255] : [20, 90, 220, 255], 40],
    ])("keeps quality on a %s", (name, pixel, floor) => {
        const next = random(3);
        const rgba = image(128, 128, (x, y) => pixel(x, y, next));
        expect(psnr(rgba, roundTrip(128, 128, rgba))).toBeGreaterThan(floor);
    });
});
