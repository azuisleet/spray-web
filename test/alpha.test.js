import {describe, expect, it} from "vitest";
import {hasSoftAlpha} from "../src/alpha.js";

function image(width, height, alpha) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) rgba[(y * width + x) * 4 + 3] = alpha(x, y);
    }
    return rgba;
}

describe("hasSoftAlpha", () => {
    it("finds a feathered edge", () => {
        const rgba = image(100, 100, (x, y) => Math.round(255 * Math.min(1, Math.max(0, (40 - Math.hypot(x - 50, y - 50)) / 10))));
        expect(hasSoftAlpha(rgba)).toBe(true);
    });

    it("ignores a hard cut-out", () => {
        expect(hasSoftAlpha(image(100, 100, (x) => x < 50 ? 0 : 255))).toBe(false);
    });

    it("ignores data hidden in the lowest alpha bit, like a generator's 254 strip", () => {
        // 9 pixels wide down the left edge, as in an image generator's hidden settings.
        expect(hasSoftAlpha(image(1024, 1024, (x, y) => x < 9 && (x + y) % 2 ? 254 : 255))).toBe(false);
    });

    it("ignores stray near-clear and near-solid values left by editors", () => {
        expect(hasSoftAlpha(image(100, 100, (x, y) => (x * y) % 7 === 0 ? 3 : (x + y) % 5 === 0 ? 250 : 255))).toBe(false);
    });

    it("still counts an anti-aliased outline", () => {
        // A solid disc with a one pixel soft rim.
        const rgba = image(200, 200, (x, y) => {
            const d = Math.hypot(x - 100, y - 100);
            return d < 80 ? 255 : d < 81 ? 128 : 0;
        });
        expect(hasSoftAlpha(rgba)).toBe(true);
    });
});
