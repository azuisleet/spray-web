import {useEffect, useState} from "react";

const prefix = "spray-converter:";

/**
 * A remembered setting: its stored value if that is still one of allowed, else fallback.
 * Storage can be missing or refuse access (private windows, blocked site data), so every
 * read and write is guarded and failure just means nothing is remembered.
 */
export function readSetting(name, allowed, fallback, storage = globalThis.localStorage) {
    try {
        const raw = storage?.getItem(prefix + name);
        if (raw === null || raw === undefined) return fallback;
        const value = JSON.parse(raw);
        return allowed.includes(value) ? value : fallback;
    } catch {
        return fallback;
    }
}

export function writeSetting(name, value, storage = globalThis.localStorage) {
    try {
        storage?.setItem(prefix + name, JSON.stringify(value));
    } catch {
        // Full or blocked: the setting is simply not remembered.
    }
}

/** useState that starts from the remembered value and remembers every change. */
export function useSetting(name, allowed, fallback) {
    const [value, setValue] = useState(() => readSetting(name, allowed, fallback));
    useEffect(() => writeSetting(name, value), [name, value]);
    return [value, setValue];
}
