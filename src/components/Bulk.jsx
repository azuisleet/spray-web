import {useEffect, useRef, useState, useSyncExternalStore} from "react";
import {acceptedNames, acceptedTypes} from "../formats.js";
import {candidateChoices} from "../plan.js";
import {downloadBlob} from "../useConversion.js";
import {buildVMT} from "../vtf.js";
import {createZip, uniqueNames} from "../zip.js";
import {OutputPanel} from "./Output.jsx";
import Preview from "./Preview.jsx";
import {FitControl} from "./Source.jsx";
import {headingClass} from "./styles.js";

function baseNameOf(file) {
    const dot = file.name.lastIndexOf(".");
    return dot > 0 ? file.name.slice(0, dot) : file.name;
}

// Every file in a drop, looking inside dropped folders too.
async function filesFromDrop(dataTransfer) {
    const entries = [...dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    if (!entries.length) return [...dataTransfer.files];

    const files = [];
    const walk = async (entry) => {
        if (entry.isFile) {
            files.push(await new Promise((resolve, reject) => entry.file(resolve, reject)));
        } else if (entry.isDirectory) {
            const reader = entry.createReader();
            // readEntries hands back a batch at a time until it returns none.
            for (;;) {
                const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                if (!batch.length) break;
                for (const child of batch) await walk(child);
            }
        }
    };
    for (const entry of entries) await walk(entry);
    return files;
}

function Thumbnail({bitmap}) {
    const ref = useRef(null);
    useEffect(() => {
        const canvas = ref.current;
        if (!canvas || !bitmap) return;
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d").drawImage(bitmap, 0, 0);
    }, [bitmap]);
    return (
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xs bg-zinc-200 dark:bg-zinc-800">
            {bitmap && <canvas ref={ref} className="max-h-full max-w-full"/>}
        </div>
    );
}

function planText(item, choiceKey) {
    const candidate = item.candidates.find(c => c.key === choiceKey) ?? item.candidates[0];
    const target = candidate?.target;
    if (!target) return "";
    return item.info.frameCount > 1
        ? `${target.targetWidth}×${target.targetHeight}, ${target.frames} frames, ${candidate.playSeconds.toFixed(1)} s`
        : `${target.targetWidth}×${target.targetHeight}`;
}

function Status({item}) {
    if (item.status === "converting") {
        return (
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700" title="Converting">
                <div className="h-full bg-paint" style={{width: `${Math.round(item.progress * 100)}%`}}/>
            </div>
        );
    }
    const styles = {
        probing: ["reading", "opacity-60"],
        waiting: ["waiting", "opacity-60"],
        done: ["done", "text-emerald-700 dark:text-emerald-400"],
        error: ["failed", "text-alarm"],
    };
    const [label, className] = styles[item.status];
    return <span className={`text-sm ${className}`} title={item.error?.message}>{label}</span>;
}

function Row({item, settings, selected, onSelect, queue}) {
    const choiceKey = item.overrides.choiceKey ?? settings.choiceKey;
    return (
        <li className={`flex cursor-pointer items-center gap-3 rounded-sm border px-2 py-2 ${selected ? "border-paint bg-paint/10" : "border-transparent hover:border-zinc-300 dark:hover:border-zinc-700"}`}
            onClick={onSelect}>
            <Thumbnail bitmap={item.info?.thumbnail}/>
            <div className="min-w-0 grow">
                <div className="truncate font-medium" title={item.file.name}>{item.file.name}</div>
                <div className="truncate text-sm opacity-70">
                    {item.status === "error" ? item.error.message : item.info ? planText(item, choiceKey) : "…"}
                </div>
            </div>
            {item.info?.frameCount > 1 && (
                <select value={item.overrides.choiceKey ?? ""} title="Choice for this file"
                        className="rounded-xs border border-zinc-400 bg-transparent px-1 py-0.5 text-sm"
                        onClick={(event) => event.stopPropagation()}
                        onChange={(event) => queue.setOverrides(item.id, {choiceKey: event.target.value || undefined})}>
                    <option value="">As set</option>
                    {candidateChoices.map(choice => <option key={choice.key} value={choice.key}>{choice.label}</option>)}
                </select>
            )}
            <Status item={item}/>
            <button type="button" aria-label={`Remove ${item.file.name}`} title="Remove"
                    className="cursor-pointer rounded-xs px-1.5 opacity-60 hover:bg-zinc-200 hover:opacity-100 dark:hover:bg-zinc-700"
                    onClick={(event) => {
                        event.stopPropagation();
                        queue.remove(item.id);
                    }}>
                ×
            </button>
        </li>
    );
}

/** Many files at once: shared settings, a queue converted in turn, one zip at the end. */
export default function Bulk({queue}) {
    const {items, settings} = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
    const [selectedId, setSelectedId] = useState(null);
    const [includeVMT, setIncludeVMT] = useState(false);
    const [notice, setNotice] = useState(null);
    const filesRef = useRef(null);
    const folderRef = useRef(null);

    const selected = items.find(item => item.id === selectedId) ?? items.find(item => item.status === "done") ?? null;
    const done = items.filter(item => item.status === "done");
    const counts = ["converting", "waiting", "probing", "error"].map(status => [status, items.filter(i => i.status === status).length]);

    const addFiles = (files) => {
        const images = files.filter(file => acceptedTypes.includes(file.type));
        const skipped = files.length - images.length;
        setNotice(skipped ? `Skipped ${skipped} file${skipped === 1 ? "" : "s"} that ${skipped === 1 ? "is not a" : "are not"} ${acceptedNames} image${skipped === 1 ? "" : "s"}` : null);
        if (images.length) queue.add(images);
    };

    const downloadAll = () => {
        const vtfNames = uniqueNames(done.map(item => `${baseNameOf(item.file)}.vtf`));
        const entries = [];
        done.forEach((item, n) => {
            entries.push({name: vtfNames[n], data: item.result.blob});
            if (includeVMT) {
                const stem = vtfNames[n].slice(0, -4);
                entries.push({name: `${stem}.vmt`, data: new Blob([buildVMT(stem)])});
            }
        });
        Promise.all(entries.map(async entry => ({name: entry.name, data: new Uint8Array(await entry.data.arrayBuffer())})))
            .then(files => downloadBlob(new Blob([createZip(files)], {type: "application/zip"}), "sprays.zip"));
    };

    const input = (ref, extra) => (
        <input ref={ref} type="file" multiple className="hidden" accept={acceptedTypes.join(",")} {...extra}
               onChange={(event) => {
                   addFiles([...event.target.files]);
                   event.target.value = null;
               }}/>
    );

    return (
        <main className="mx-auto grid w-full max-w-7xl grow gap-8 p-6 md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(16rem,22rem)]"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  filesFromDrop(event.dataTransfer).then(addFiles);
              }}>
            <section className="flex min-w-0 flex-col gap-3">
                <h2 className={`border-b border-zinc-300 pb-1 dark:border-zinc-700 ${headingClass}`}>Files</h2>
                <div className="flex flex-col items-center gap-2 rounded-sm border-2 border-dashed border-zinc-400 px-3 py-6 text-center">
                    <div className="font-semibold">Drop images or folders</div>
                    <div className="flex gap-2 text-sm">
                        <button type="button" className="cursor-pointer underline" onClick={() => filesRef.current.click()}>choose files</button>
                        <span className="opacity-60">or</span>
                        <button type="button" className="cursor-pointer underline" onClick={() => folderRef.current.click()}>a folder</button>
                    </div>
                    {input(filesRef)}
                    {input(folderRef, {webkitdirectory: ""})}
                </div>
                {notice && <div className="text-sm text-amber-700 dark:text-amber-400">{notice}</div>}

                <div className="flex flex-col gap-1">
                    <span className="text-sm text-steel dark:text-zinc-400">For every file</span>
                    <div className="grid grid-cols-2 gap-1 text-sm" role="radiogroup" aria-label="Choice for every file">
                        {candidateChoices.map(choice => (
                            <button key={choice.key} type="button" role="radio" aria-checked={settings.choiceKey === choice.key}
                                    onClick={() => queue.setSettings({choiceKey: choice.key})}
                                    className={`cursor-pointer rounded-xs border px-2 py-1 ${settings.choiceKey === choice.key ? "border-paint bg-paint text-ink" : "border-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-700"}`}>
                                {choice.label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="flex flex-col gap-1">
                    <span className="text-sm text-steel dark:text-zinc-400">Fit to the square spray</span>
                    <FitControl fit={settings.fit} onChange={(fit) => queue.setSettings({fit})}/>
                </div>

                <label className="flex items-center gap-2 text-sm" title="TF2's spray import writes its own; these are only for copying files in by hand">
                    <input type="checkbox" checked={includeVMT} onChange={(event) => setIncludeVMT(event.target.checked)}/>
                    Include .vmt files
                </label>
                <button type="button" disabled={!done.length} onClick={downloadAll}
                        className="cursor-pointer rounded-xs bg-paint px-4 py-2 font-semibold text-ink hover:bg-paint-strong disabled:cursor-default disabled:opacity-40">
                    Download all ({done.length} of {items.length}) as .zip
                </button>
                {items.length > 0 && (
                    <button type="button" className="cursor-pointer self-start text-sm underline opacity-80" onClick={() => {
                        queue.clear();
                        setSelectedId(null);
                    }}>Clear the list</button>
                )}
            </section>

            <section className="flex min-w-0 flex-col gap-3">
                <h2 className={`border-b border-zinc-300 pb-1 dark:border-zinc-700 ${headingClass}`}>
                    Queue
                    {items.length > 0 && (
                        <span className="ml-2 font-sans text-sm font-normal text-steel dark:text-zinc-400">
                            {[`${done.length} done`, ...counts.filter(([, n]) => n).map(([status, n]) => `${n} ${status === "probing" ? "reading" : status === "error" ? "failed" : status}`)].join(", ")}
                        </span>
                    )}
                </h2>
                {items.length === 0
                    ? <p className="text-sm opacity-70">Nothing yet. Every image dropped here becomes a spray with the settings on the left; each file can also have its own choice.</p>
                    : (
                        <ul className="flex flex-col gap-1">
                            {items.map(item => (
                                <Row key={item.id} item={item} settings={settings} queue={queue}
                                     selected={item.id === selected?.id} onSelect={() => setSelectedId(item.id)}/>
                            ))}
                        </ul>
                    )}
            </section>

            <section className="flex min-w-0 flex-col gap-3">
                <h2 className={`truncate border-b border-zinc-300 pb-1 dark:border-zinc-700 ${headingClass}`}>
                    {selected ? selected.file.name : "Preview"}
                </h2>
                <Preview result={selected?.result ?? null} converting={selected?.status === "converting"}
                         progress={selected?.progress ?? 0} emptyText="Select a converted file to preview it"/>
                {selected?.status === "done" && <OutputPanel result={selected.result} baseName={baseNameOf(selected.file)}/>}
            </section>
        </main>
    );
}
