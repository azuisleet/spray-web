import {describe, expect, it} from "vitest";
import {defaultTrim, videoDurations, videoFrameRate} from "../src/decode.js";
import {chooseTarget, targetFrameCount} from "../src/plan.js";

describe("video timing", () => {
    it("uses the opening six seconds of a long video, and all of a short one", () => {
        expect(defaultTrim(42)).toEqual({start: 0, end: 6});
        expect(defaultTrim(2.5)).toEqual({start: 0, end: 2.5});
    });

    it("lays a span of video on the 30 a second frame grid", () => {
        const durations = videoDurations(2);
        expect(durations.length).toBe(2 * videoFrameRate);
        expect(durations.reduce((sum, d) => sum + d, 0)).toBeCloseTo(2000);
        expect(videoDurations(0.01).length).toBe(1);
    });

    it("plans a video like an animation: five frames for each second used", () => {
        const wanted = targetFrameCount(videoDurations(6));
        expect(wanted).toBe(30);
        expect(chooseTarget(1280, 720, wanted).frames).toBeLessThanOrEqual(30);
    });
});
