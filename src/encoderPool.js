// About 10 ms of encoding: large enough that messaging is noise, small enough that one
// big mip spreads across every worker.
const pixelsPerTask = 64 * 1024;

/**
 * DXT1 encoding across a pool of workers. DXT1 blocks are independent and stored row
 * major, so a level splits into horizontal strips whose outputs simply concatenate.
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
            worker.postMessage({id: task.id, width: task.width, height: task.height, pixels: task.pixels},
                [task.pixels.buffer]);
            task.pixels = null;
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

    function submit(width, height, pixels) {
        if (live === 0) return Promise.reject(new Error("No encoder workers are running"));
        // Transferring detaches the whole buffer, so a view onto a larger buffer is copied.
        if (pixels.byteOffset !== 0 || pixels.byteLength !== pixels.buffer.byteLength) pixels = pixels.slice();

        return new Promise((resolve, reject) => {
            queue.push({id: nextId++, width, height, pixels, resolve, reject});
            pump();
        });
    }

    return {
        size,

        /**
         * Takes ownership of pixels (the buffer is transferred away).
         * @returns Promise of the DXT1 blocks for the level
         */
        async encode(width, height, pixels) {
            const stripRows = Math.max(4, Math.floor(pixelsPerTask / width / 4) * 4);
            if (height <= stripRows) return submit(width, height, pixels);

            const strips = [];
            const rowBytes = width * 4;
            for (let y = 0; y < height; y += stripRows) {
                const rows = Math.min(stripRows, height - y);
                strips.push(submit(width, rows, pixels.subarray(y * rowBytes, (y + rows) * rowBytes)));
            }

            const parts = await Promise.all(strips);
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

// Leaves a core for the main thread, which keeps decoding and resampling frames.
export function getEncoderPool() {
    if (!sharedPool) {
        const cores = navigator.hardwareConcurrency || 4;
        sharedPool = createEncoderPool(Math.max(1, Math.min(cores - 1, 8)));
    }
    return sharedPool;
}
