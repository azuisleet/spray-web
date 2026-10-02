import {describe, expect, it} from "vitest";
import {BulkQueue} from "../src/bulkQueue.js";
import {fitCrop} from "../src/plan.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

// Conversions that finish only when the test says so, recording what they were asked.
function fakes() {
    const calls = [];
    const convert = (file, options) => new Promise((resolve, reject) => {
        const call = {file, options, resolve: () => resolve({name: file.name, options}), reject};
        options.signal.addEventListener("abort", () => reject(options.signal.reason));
        calls.push(call);
    });
    // Names starting "still" are single frames; anything else is a long animation, large
    // enough that the choices produce different sprays.
    const probe = async (file) => {
        if (file.broken) throw new Error("unreadable");
        if (file.name.startsWith("still")) return {width: 100, height: 100, frameCount: 1, durations: [0]};
        return {width: 600, height: 331, frameCount: 139, durations: Array(139).fill(6000 / 139)};
    };
    return {calls, convert, probe};
}

const file = (name, extra = {}) => ({name, ...extra});
const statuses = (queue) => queue.getSnapshot().items.map(item => `${item.file.name}:${item.status}`);

describe("BulkQueue", () => {
    it("probes what it is given, then converts one file at a time in order", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("a"), file("b")]);
        await settle();

        expect(statuses(queue)).toEqual(["a:converting", "b:waiting"]);
        expect(calls.length).toBe(1);

        calls[0].resolve();
        await settle();
        expect(statuses(queue)).toEqual(["a:done", "b:converting"]);

        calls[1].resolve();
        await settle();
        expect(statuses(queue)).toEqual(["a:done", "b:done"]);
        expect(queue.getSnapshot().items[0].result.name).toBe("a");
    });

    it("converts with the shared settings unless a file overrides them", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.setSettings({choiceKey: "motion", fit: fitCrop});
        queue.add([file("a")]);
        await settle();
        expect(calls[0].options).toMatchObject({preference: "motion", fit: fitCrop, keepAllFrames: false});
        calls[0].resolve();
        await settle();

        queue.setOverrides(queue.getSnapshot().items[0].id, {choiceKey: "all"});
        await settle();
        expect(calls[1].options).toMatchObject({keepAllFrames: true, fit: fitCrop});
    });

    it("queues again only the files a settings change affects", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("a"), file("b")]);
        await settle();
        queue.setOverrides(queue.getSnapshot().items[1].id, {choiceKey: "detail"});
        calls[0].resolve();
        await settle();
        calls[1].resolve();
        await settle();
        expect(statuses(queue)).toEqual(["a:done", "b:done"]);

        // b has its own choice, so changing the shared one leaves it alone.
        queue.setSettings({choiceKey: "motion"});
        await settle();
        expect(statuses(queue)).toEqual(["a:converting", "b:done"]);
        expect(calls.length).toBe(3);
    });

    it("leaves a file alone when a change would not alter its spray", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("still")]);
        await settle();
        calls[0].resolve();
        await settle();

        // A still comes out the same under every choice.
        queue.setSettings({choiceKey: "motion"});
        await settle();
        expect(statuses(queue)).toEqual(["still:done"]);
        expect(calls.length).toBe(1);
    });

    it("cancels the running conversion when its plan changes, then runs it again", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("a")]);
        await settle();
        queue.setSettings({choiceKey: "detail"});
        await settle();

        expect(calls[0].options.signal.aborted).toBe(true);
        expect(calls.length).toBe(2);
        expect(calls[1].options.preference).toBe("detail");
        expect(statuses(queue)).toEqual(["a:converting"]);
    });

    it("cancels a file that is removed while converting and moves on", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("a"), file("b")]);
        await settle();
        queue.remove(queue.getSnapshot().items[0].id);
        await settle();

        expect(calls[0].options.signal.aborted).toBe(true);
        expect(statuses(queue)).toEqual(["b:converting"]);
    });

    it("marks files it cannot read or convert, without stopping the rest", async () => {
        const {calls, convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("bad", {broken: true}), file("a"), file("b")]);
        await settle();
        calls[0].reject(new Error("too big"));
        await settle();

        expect(statuses(queue)).toEqual(["bad:error", "a:error", "b:converting"]);
        expect(queue.getSnapshot().items[0].error.message).toBe("unreadable");
        expect(queue.getSnapshot().items[1].error.message).toBe("too big");
    });

    it("offers each file the choices for its own size", async () => {
        const {convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        queue.add([file("a")]);
        await settle();
        queue.add([file("still")]);
        await settle();
        expect(queue.getSnapshot().items[1].candidates[0].target.targetWidth).toBe(100);
    });

    it("keeps the snapshot stable until something changes", async () => {
        const {convert, probe} = fakes();
        const queue = new BulkQueue({convert, probe});
        const first = queue.getSnapshot();
        expect(queue.getSnapshot()).toBe(first);
        queue.add([file("a")]);
        expect(queue.getSnapshot()).not.toBe(first);
    });
});
