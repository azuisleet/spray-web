import {sourceRowRange, verticalTaps} from "./resample.js";

// Output pixels per task, about 10 ms of resampling and encoding: large enough that
// messaging is noise, small enough that one big mip spreads across every worker.
const pixelsPerTask = 64 * 1024;

/**
 * Resampling and DXT1 encoding across a pool of workers. DXT1 blocks are independent and
 * stored row major, so a level splits into horizontal strips whose outputs simply
 * concatenate, and each strip only needs the source rows its filter reaches.
 */
export function createEncoderPool(size) {
    const idle = [];
    const queue = [];
    const running = new Map();
    let live = 0;
    let nextId = 0;

    function pump() {
        while (idle.length && queue.length) {
            const worker = idle.pop();
            const task = queue.shift();
            running.set(worker, task);
            worker.postMessage({id: task.id, ...task.message}, task.transfer);
            task.message = task.transfer = null;
        }
    }

    function spawn() {
        const worker = new Worker(new URL("./encoderWorker.js", import.meta.url), {type: "module"});

        worker.onmessage = ({data}) => {
            const task = running.get(worker);
            running.delete(worker);
            if (data.error) task.reject(new Error(data.error));
            else task.resolve(data.blocks);
            idle.push(worker);
            pump();
        };

        // Only fires for failures outside the message handler, such as the script not
        // loading, so the worker is treated as dead.
        worker.onerror = (event) => {
            event.preventDefault();
            const message = `Encoder worker failed: ${event.message || "could not start"}`;
            running.get(worker)?.reject(new Error(message));
            running.delete(worker);
            worker.terminate();
            live -= 1;
            if (live === 0) {
                for (const task of queue.splice(0)) task.reject(new Error(message));
            }
        };

        live += 1;
        idle.push(worker);
    }

    for (let i = 0; i < size; i++) spawn();

    function submit(message, transfer, signal) {
        if (live === 0) return Promise.reject(new Error("No encoder workers are running"));
        return new Promise((resolve, reject) => {
            queue.push({id: nextId++, message, transfer, signal, resolve, reject});
            pump();
        });
    }

    // Queued work for a cancelled job is dropped; strips already running finish and are
    // thrown away, which is never more than one strip per worker.
    function cancelQueued(signal) {
        for (let i = queue.length - 1; i >= 0; i--) {
            if (queue[i].signal !== signal) continue;
            queue[i].reject(signal.reason);
            queue.splice(i, 1);
        }
    }

    return {
        size,

        /**
         * Draws source into one level and encodes it. The source rows each strip needs are
         * copied out before this returns, so the caller may reuse source.pixels at once.
         *
         * @param source {pixels, width, height}: unpremultiplied RGBA
         * @param level {width, height, placement: {src, dst}}, as from placeInTexture
         * @param signal optional AbortSignal; aborting drops this level's queued strips
         * @param onStrip optional, called with the pixel count of each strip as it finishes
         * @returns Promise of the level's DXT1 blocks
         */
        async render(source, level, signal, onStrip) {
            signal?.throwIfAborted();
            const {width, height} = level;
            const stripRows = Math.max(4, Math.floor(pixelsPerTask / width / 4) * 4);
            const yTaps = verticalTaps(source.height, height, level.placement);
            const rowBytes = source.width * 4;

            const strips = [];
            for (let rowStart = 0; rowStart < height; rowStart += stripRows) {
                const rows = Math.min(stripRows, height - rowStart);
                const [first, end] = sourceRowRange(yTaps, rowStart, rowStart + rows);
                const pixels = source.pixels.slice(first * rowBytes, end * rowBytes);
                strips.push(submit({
                    source: {pixels, width: source.width, height: source.height, rowOffset: first},
                    level,
                    rowStart,
                    rows,
                }, [pixels.buffer], signal).then(blocks => {
                    onStrip?.(width * rows);
                    return blocks;
                }));
            }

            const onAbort = () => cancelQueued(signal);
            signal?.addEventListener("abort", onAbort, {once: true});
            let parts;
            try {
                parts = await Promise.all(strips);
            } finally {
                signal?.removeEventListener("abort", onAbort);
            }
            signal?.throwIfAborted();
            if (parts.length === 1) return parts[0];
            const blocks = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
            let offset = 0;
            for (const part of parts) {
                blocks.set(part, offset);
                offset += part.length;
            }
            return blocks;
        },

        terminate() {
            for (const worker of [...idle, ...running.keys()]) worker.terminate();
            const error = new Error("Encoder pool was terminated");
            for (const task of [...running.values(), ...queue.splice(0)]) task.reject(error);
            running.clear();
            idle.length = 0;
            live = 0;
        },
    };
}

let sharedPool = null;

// Leaves a core for the main thread, which keeps decoding frames.
export function getEncoderPool() {
    if (!sharedPool) {
        const cores = navigator.hardwareConcurrency || 4;
        sharedPool = createEncoderPool(Math.max(1, Math.min(cores - 1, 8)));
    }
    return sharedPool;
}
