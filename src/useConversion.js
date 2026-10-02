import {useEffect, useState} from "react";
import {convertImage, probeImage} from "./convert.js";

// Long enough to coalesce a burst of setting changes, short enough to feel immediate.
const debounceMs = 150;

const idle = {status: "idle", progress: 0, result: null, error: null};

/**
 * Runs the conversion described by job, restarting whenever job changes: the running
 * conversion is aborted and a new one starts after a short pause. Pass a memoised job
 * (it is compared by identity), or null for nothing to do.
 *
 * @param job {file, options} for convertImage, without signal or onProgress
 * @returns {status: "idle" | "converting" | "done" | "error", progress, result, error}
 *          While converting, result still holds the previous output, if any.
 */
export function useConversion(job) {
    // Tagged with the job it belongs to, so a new job reads as converting from its first
    // render, before anything has been reported for it.
    const [state, setState] = useState({job: null, ...idle});

    useEffect(() => {
        if (!job) return;

        const controller = new AbortController();
        const report = (update) => {
            if (!controller.signal.aborted) setState(previous => ({...previous, ...update, job}));
        };

        const timer = setTimeout(() => {
            convertImage(job.file, {
                ...job.options,
                signal: controller.signal,
                onProgress: (progress) => report({status: "converting", progress}),
            })
                .then(result => report({status: "done", progress: 1, result, error: null}))
                .catch(error => {
                    if (controller.signal.aborted) return;
                    console.error(error);
                    report({status: "error", progress: 0, result: null, error});
                });
        }, debounceMs);

        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [job]);

    if (!job) return idle;
    if (state.job !== job) return {status: "converting", progress: 0, result: state.result, error: null};
    const {status, progress, result, error} = state;
    return {status, progress, result, error};
}

/** Saves blob as a download named name. */
export function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    // The download has its own reference by the time this runs.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Probes file for the planner and a thumbnail, as {status, info, error}. Resolves to the
 * same shape for the same file, so callers can memoise on info.
 */
export function useProbe(file) {
    const [state, setState] = useState({file: null, info: null, error: null});

    useEffect(() => {
        if (!file) return;
        const controller = new AbortController();
        probeImage(file, {signal: controller.signal})
            .then(info => {
                if (controller.signal.aborted) info.thumbnail?.close();
                else setState({file, info, error: null});
            })
            .catch(error => {
                if (!controller.signal.aborted) setState({file, info: null, error});
            });
        return () => controller.abort();
    }, [file]);

    // Thumbnails are left to garbage collection: closing one when its probe is replaced
    // would also close it under StrictMode's rehearsal unmount, while it is still shown.
    if (!file) return {status: "idle", info: null, error: null};
    if (state.file !== file) return {status: "probing", info: null, error: null};
    return state.error ? {status: "error", info: null, error: state.error} : {status: "done", info: state.info, error: null};
}
