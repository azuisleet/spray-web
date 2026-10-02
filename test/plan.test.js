import {describe, expect, it} from "vitest";
import {
    chooseFrameIndices, chooseSwapLevel, chooseTarget, engineFrameRate, fitCrop, fitGeometry, fitPad, fitStretch,
    placeInTexture, preferBalanced, preferDetail, preferMotion, targetFrameCount,
} from "../src/plan.js";
import {dxt1Size, headerSize, maximumSize, mipDimensions} from "../src/vtf.js";

const size = (target) => `${target.targetWidth}x${target.targetHeight}x${target.frames}`;

describe("chooseTarget", () => {
    it.each([
        ["keeps a still that fits at its own size", [1000, 1000, 1], "1000x1000x1"],
        ["keeps a small still at its own size", [300, 300, 1], "300x300x1"],
        ["gives a large still the tested 1024x1020", [4000, 4000, 1], "1024x1020x1"],
        ["pads a 2:1 still into the square it needs", [800, 400, 1], "800x800x1"],
        ["balances a long animation", [640, 360, 300], "92x92x123"],
        ["balances a short animation", [498, 280, 25], "240x240x18"],
    ])("%s", (name, [width, height, frames], expected) => {
        expect(size(chooseTarget(width, height, frames))).toBe(expected);
    });

    it("never goes over the size budget", () => {
        for (const [width, height, frames] of [[4000, 4000, 1], [640, 360, 300], [128, 64, 139], [3, 2, 1], [2048, 16, 7]]) {
            for (const preference of [preferDetail, preferBalanced, preferMotion]) {
                for (const useMips of [false, true]) {
                    const target = chooseTarget(width, height, frames, {preference, useMips});
                    expect(target.cost).toBeLessThanOrEqual(maximumSize);
                    expect(target.targetWidth % 4 + target.targetHeight % 4).toBe(0);
                }
            }
        }
    });

    it("keeps to powers of two for a mip trick", () => {
        const target = chooseTarget(4000, 4000, 1, {useMips: true});
        for (const side of [target.targetWidth, target.targetHeight]) expect(Math.log2(side) % 1).toBe(0);
        const payload = mipDimensions(target.targetWidth, target.targetHeight).reduce((sum, [w, h]) => sum + dxt1Size(w, h), 0);
        expect(target.cost).toBe(payload);
    });

    it("orders the presets: resolution keeps fewest frames, motion the most", () => {
        const frames = [preferDetail, preferBalanced, preferMotion].map(preference => chooseTarget(600, 331, 139, {preference}).frames);
        expect(frames).toEqual([13, 68, 83]);
    });

    it("never turns an animation into a still", () => {
        expect(chooseTarget(2000, 2000, 2, {preference: preferDetail}).frames).toBe(2);
    });

    it("reports padding only for the pad fit", () => {
        expect(chooseTarget(800, 400, 1, {fit: fitPad}).waste).toBeCloseTo(0.5);
        expect(chooseTarget(800, 400, 1, {fit: fitCrop}).waste).toBe(0);
        expect(chooseTarget(800, 400, 1, {fit: fitStretch}).waste).toBe(0);
    });

    it("sizes a crop for the square it keeps and a stretch for the whole image", () => {
        expect(size(chooseTarget(800, 400, 1, {fit: fitCrop}))).toBe("400x400x1");
        expect(size(chooseTarget(800, 400, 1, {fit: fitStretch}))).toBe("800x400x1");
    });

    it("returns its header-inclusive size within 512 KiB", () => {
        expect(chooseTarget(4000, 4000, 1).cost + headerSize).toBeLessThanOrEqual(512 * 1024);
    });
});

describe("fitGeometry and placeInTexture", () => {
    it("pads a wide image with bands above and below", () => {
        const {source, decal} = fitGeometry(800, 400, fitPad);
        expect(source).toEqual({x0: 0, y0: 0, x1: 800, y1: 400});
        expect(decal).toEqual({x0: 0, y0: 0.25, x1: 1, y1: 0.75});
    });

    it("crops the largest square, where the focus says", () => {
        expect(fitGeometry(800, 400, fitCrop).source).toEqual({x0: 200, y0: 0, x1: 600, y1: 400});
        expect(fitGeometry(800, 400, fitCrop, {x: 0, y: 0.5}).source).toEqual({x0: 0, y0: 0, x1: 400, y1: 400});
        expect(fitGeometry(400, 800, fitCrop, {x: 0.5, y: 1}).source).toEqual({x0: 0, y0: 400, x1: 400, y1: 800});
    });

    it("maps the decal onto a rectangular texture axis by axis", () => {
        const placement = placeInTexture(fitGeometry(800, 400, fitPad), 512, 1024);
        expect(placement.dst).toEqual({x0: 0, y0: 256, x1: 512, y1: 768});
    });
});

describe("targetFrameCount", () => {
    it("wants 5 frames per second of animation, the engine's fixed rate", () => {
        expect(targetFrameCount(Array(139).fill(6000 / 139))).toBe(30);
        expect(targetFrameCount(Array(25).fill(100))).toBe(13);
    });

    it("wants repeats of a long-held frame rather than speeding it up", () => {
        expect(targetFrameCount([200, 3000, 200])).toBe(17);
    });

    it("wants one frame for a still and at least two for any animation", () => {
        expect(targetFrameCount([100])).toBe(1);
        expect(targetFrameCount([20, 20])).toBe(2);
    });

    it("wants every source frame when asked to keep them all", () => {
        expect(targetFrameCount(Array(139).fill(40), {keepAllFrames: true})).toBe(139);
    });

    it("plans no more frames than wanted, however much room there is", () => {
        expect(chooseTarget(64, 64, 13).frames).toBe(13);
        expect(engineFrameRate).toBe(5);
    });
});

describe("chooseFrameIndices", () => {
    it("decimates even delays evenly", () => {
        expect(chooseFrameIndices(Array(10).fill(100), 5)).toEqual([0, 2, 4, 6, 8]);
    });

    it("picks by time, repeating a long-held frame", () => {
        expect(chooseFrameIndices([100, 1000, 100], 3)).toEqual([1, 1, 1]);
        // Slot midpoints fall at 108, 325, ... 1191 ms: frames 0 and 3 are too short to be hit.
        expect(chooseFrameIndices([100, 100, 1000, 100], 6)).toEqual([1, 2, 2, 2, 2, 2]);
    });

    it("keeps every frame when there is room", () => {
        expect(chooseFrameIndices([30, 70, 50], 3)).toEqual([0, 1, 2]);
    });

    it("repeats frames when more slots are wanted than there are frames", () => {
        expect(chooseFrameIndices([200, 600, 200], 5)).toEqual([0, 1, 1, 1, 2]);
    });
});

describe("chooseSwapLevel", () => {
    it("swaps where the texture draws at the requested size", () => {
        expect(chooseSwapLevel(512, 512, 64)).toBe(3);
        expect(chooseSwapLevel(256, 512, 64)).toBe(3);
    });

    it("stays between the top level and the last", () => {
        expect(chooseSwapLevel(64, 64, 128)).toBe(1);
        expect(chooseSwapLevel(64, 64, 1)).toBe(6);
    });
});
