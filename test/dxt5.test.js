import {describe, expect, it} from "vitest";
import {decodeDXT5, encodeDXT5} from "../src/dxt5.js";

function image(width, height, pixel) {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4);
    }
    return rgba;
}

const roundTrip = (width, height, rgba) => decodeDXT5(width, height, encodeDXT5(width, height, rgba));

function maxAlphaError(source, decoded) {
    let worst = 0;
    for (let i = 3; i < source.length; i += 4) worst = Math.max(worst, Math.abs(source[i] - decoded[i]));
    return worst;
}

describe("encodeDXT5", () => {
    it("stores 16 bytes per 4x4 block", () => {
        expect(encodeDXT5(16, 8, new Uint8Array(16 * 8 * 4)).length).toBe(4 * 2 * 16);
    });

    it("keeps fully transparent and fully opaque pixels exact", () => {
        const rgba = image(32, 32, (x, y) => [200, 50, 50, (x * 3 + y * 5) % 7 < 3 ? 0 : 255]);
        const decoded = roundTrip(32, 32, rgba);
        for (let i = 3; i < rgba.length; i += 4) expect(decoded[i]).toBe(rgba[i]);
    });

    it("keeps a smooth alpha ramp within a few levels", () => {
        const rgba = image(64, 16, (x) => [255, 255, 255, Math.min(255, x * 4)]);
        expect(maxAlphaError(rgba, roundTrip(64, 16, rgba))).toBeLessThanOrEqual(3);
    });

    it("keeps soft edges: a feathered circle stays close and its centre stays solid", () => {
        const rgba = image(64, 64, (x, y) => {
            const d = Math.hypot(x - 31.5, y - 31.5);
            return [40, 120, 220, Math.round(255 * Math.min(1, Math.max(0, (26 - d) / 8)))];
        });
        const decoded = roundTrip(64, 64, rgba);
        expect(maxAlphaError(rgba, decoded)).toBeLessThanOrEqual(12);
        expect(decoded[(32 * 64 + 32) * 4 + 3]).toBe(255);
        expect(decoded[3]).toBe(0);
    });

    it("fits colour to the pixels that show, ignoring fully transparent ones", () => {
        // Every other pixel is invisible and garish; the visible ones are one solid colour.
        const rgba = image(8, 8, (x, y) => (x + y) % 2 ? [0, 255, 0, 0] : [200, 40, 40, 255]);
        const decoded = roundTrip(8, 8, rgba);
        for (let i = 0; i < rgba.length; i += 4) {
            if (rgba[i + 3] === 255) expect(Math.abs(decoded[i] - 200) + Math.abs(decoded[i + 1] - 40) + Math.abs(decoded[i + 2] - 40)).toBeLessThanOrEqual(6);
        }
    });

    it("always reads its colour block as four colours, so dark opaque pixels never turn see-through", () => {
        const rgba = image(16, 16, (x, y) => [(x + y) % 3, (x + y) % 3, (x + y) % 3, 255]);
        const decoded = roundTrip(16, 16, rgba);
        for (let i = 3; i < decoded.length; i += 4) expect(decoded[i]).toBe(255);
    });
});
