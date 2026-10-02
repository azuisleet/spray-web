import {defaultTrim, videoDurations} from "./decode.js";
import {candidateChoices, fitPad, listCandidates} from "./plan.js";

let nextId = 1;

/**
 * The bulk converter's queue: probes files as they arrive, then converts them one at a
 * time (each conversion already uses every worker). Settings apply to every file unless
 * the file overrides them, and changing them queues again exactly the files whose output
 * would change, cancelling the running one if it is among them.
 *
 * A plain store rather than React state, so the scheduling is testable on its own; the
 * UI reads it with useSyncExternalStore.
 *
 * Items: {id, file, status, progress, info, candidates, overrides, result, error}, where
 * status is probing, waiting, converting, done or error.
 */
export class BulkQueue {
    #convert;
    #probe;
    #listeners = new Set();
    #items = [];
    // softEdges keeps soft edges for the files that have them; pixelArt applies to all.
    #settings = {choiceKey: "balanced", fit: fitPad, softEdges: true, pixelArt: false};
    #running = null;    // {id, key, controller}
    #snapshot = null;

    /**
     * @param convert convertImage; probe probeImage. Injected so tests can fake them.
     * @param settings optional starting settings, such as remembered ones
     */
    constructor({convert, probe, settings = {}}) {
        this.#convert = convert;
        this.#probe = probe;
        this.#settings = {...this.#settings, ...settings};
    }

    subscribe = (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    getSnapshot = () => {
        this.#snapshot ??= {items: this.#items, settings: this.#settings};
        return this.#snapshot;
    };

    #emit() {
        this.#snapshot = null;
        for (const listener of this.#listeners) listener();
    }

    #update(id, changes) {
        this.#items = this.#items.map(item => item.id === id ? {...item, ...changes} : item);
        this.#emit();
    }

    #find(id) {
        return this.#items.find(item => item.id === id);
    }

    /**
     * What an item would be converted with now, and a key for what that produces. The key
     * is the output rather than the settings, so a change that leaves a file's spray the
     * same (a still under any choice, two choices that agree) does not convert it again.
     */
    #plan(item) {
        const choiceKey = item.overrides.choiceKey ?? this.#settings.choiceKey;
        const fit = item.overrides.fit ?? this.#settings.fit;
        const choice = candidateChoices.find(c => c.key === choiceKey);
        const softEdges = this.#settings.softEdges && !!item.info?.softAlpha;
        const pixelArt = this.#settings.pixelArt;
        const shape = {fit, softEdges, pixelArt};
        // A video uses its opening span, and never every frame (30 a second played at 5).
        const video = item.info?.video;
        const trim = video ? defaultTrim(video.duration) : undefined;
        const keepAllFrames = choice.keepAllFrames && !video;
        const options = {preference: choice.preference, keepAllFrames, trim, ...shape};
        if (!item.info) return {key: null, options, shape, durations: null};

        const {info} = item;
        const durations = video ? videoDurations(trim.end - trim.start) : info.durations;
        // A still has a single candidate, whatever the choice.
        const candidates = listCandidates(info.width, info.height, durations, shape).filter(c => !(video && c.keepAllFrames));
        const candidate = candidates.find(c => c.key === choiceKey) ?? candidates[0];
        const target = candidate?.target;
        const animated = info.frameCount > 1;
        // Keeping every frame picks frames one for one rather than by time, so it can differ
        // even at the same frame count.
        const output = target ? `${target.targetWidth}x${target.targetHeight}x${target.frames}|${target.format}|${target.pixel?.scale ?? 0}` : "none";
        const key = [fit, output, animated && keepAllFrames].join("|");
        return {key, options, shape, durations};
    }

    #withCandidates(item) {
        if (!item.info) return item;
        const {info} = item;
        const {shape, durations} = this.#plan(item);
        const candidates = listCandidates(info.width, info.height, durations, shape).filter(c => !(info.video && c.keepAllFrames));
        return {...item, candidates};
    }

    add(files) {
        const added = files.map(file => ({
            id: nextId++, file, status: "probing", progress: 0, info: null, candidates: [],
            overrides: {}, result: null, resultKey: null, error: null,
        }));
        this.#items = [...this.#items, ...added];
        this.#emit();
        for (const item of added) this.#startProbe(item.id);
    }

    async #startProbe(id) {
        const item = this.#find(id);
        try {
            const info = await this.#probe(item.file);
            if (!this.#find(id)) return;
            this.#items = this.#items.map(i => i.id === id ? this.#withCandidates({...i, info, status: "waiting"}) : i);
            this.#emit();
        } catch (error) {
            if (this.#find(id)) this.#update(id, {status: "error", error});
        }
        this.#pump();
    }

    remove(id) {
        if (this.#running?.id === id) this.#running.controller.abort();
        this.#items = this.#items.filter(item => item.id !== id);
        this.#emit();
    }

    clear() {
        this.#running?.controller.abort();
        this.#items = [];
        this.#emit();
    }

    setSettings(changes) {
        this.#settings = {...this.#settings, ...changes};
        this.#replan();
    }

    /** Per-file overrides; pass undefined for a setting to follow the shared one again. */
    setOverrides(id, changes) {
        const item = this.#find(id);
        if (!item) return;
        const overrides = {...item.overrides, ...changes};
        for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete overrides[key];
        this.#items = this.#items.map(i => i.id === id ? {...i, overrides} : i);
        this.#replan();
    }

    // Recomputes candidates, marks out-of-date items waiting again, and cancels the
    // running conversion if its plan changed.
    #replan() {
        this.#items = this.#items.map(item => {
            const updated = this.#withCandidates(item);
            const stale = item.info && item.status !== "converting" && item.resultKey !== this.#plan(item).key;
            return stale ? {...updated, status: "waiting", progress: 0, error: null} : updated;
        });
        const running = this.#running && this.#find(this.#running.id);
        if (running && this.#plan(running).key !== this.#running.key) this.#running.controller.abort();
        this.#emit();
        this.#pump();
    }

    #pump() {
        if (this.#running) return;
        const next = this.#items.find(item => item.status === "waiting");
        if (!next) return;

        const {key, options} = this.#plan(next);
        const controller = new AbortController();
        const running = {id: next.id, key, controller};
        this.#running = running;
        this.#update(next.id, {status: "converting", progress: 0, error: null});

        this.#convert(next.file, {
            ...options,
            signal: controller.signal,
            onProgress: (progress) => {
                if (!controller.signal.aborted) this.#update(next.id, {progress});
            },
        }).then(result => {
            if (!controller.signal.aborted) this.#update(next.id, {status: "done", progress: 1, result, resultKey: key});
        }, error => {
            if (!controller.signal.aborted) this.#update(next.id, {status: "error", error, resultKey: key});
        }).finally(() => {
            this.#running = null;
            // Cancelled because its plan changed: back in line with the new plan.
            const item = this.#find(running.id);
            if (controller.signal.aborted && item) this.#update(running.id, {status: "waiting", progress: 0});
            this.#pump();
        });
    }
}
