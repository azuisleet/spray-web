import {useMemo, useState, useSyncExternalStore} from 'react'
import {BulkQueue} from "./bulkQueue.js";
import Bulk from "./components/Bulk.jsx";
import {ChoicePicker, OutputPanel} from "./components/Output.jsx";
import Preview from "./components/Preview.jsx";
import {DropZone, FitControl, SourceThumbnail} from "./components/Source.jsx";
import {Label, Panel, ProgressBar, Spinner} from "./components/ui.jsx";
import {acceptedNames, acceptedTypes} from "./formats.js";
import {convertImage, probeImage} from "./convert.js";
import {candidateChoices, fitPad, listCandidates} from "./plan.js";
import {useConversion, useProbe} from "./useConversion.js";

const modeSingle = "single";
const modeMipTrick = "mipTrick";
const modeBulk = "bulk";

const modes = [[modeSingle, "Single image"], [modeMipTrick, "Mip trick"], [modeBulk, "Bulk"]];

// Small thumbnails for the bulk list, which may hold hundreds of files.
const bulkThumbnailSize = 96;

const siteUrl = "https://azuisleet.github.io";
const sourceUrl = "https://github.com/azuisleet/spray-web";

const centred = {x: 0.5, y: 0.5};

// The GPU drops to mip level k once the spray is drawn at about baseDimension / 2^k
// screen pixels, so picking the swap in pixels is resolution independent.
const swapOptions = [
    {pixels: 128, label: "128 px", hint: "a few steps back"},
    {pixels: 64, label: "64 px", hint: "across a room"},
    {pixels: 32, label: "32 px", hint: "across the map"},
    {pixels: 16, label: "16 px", hint: "sniper range"},
];

function baseNameOf(file) {
    const dot = file.name.lastIndexOf(".");
    return dot > 0 ? file.name.slice(0, dot) : file.name;
}

// How far along the bulk queue is, counting the running file's progress, or null when idle.
function bulkActivity({items}) {
    const active = items.filter(item => item.status !== "error");
    if (!active.some(item => ["probing", "waiting", "converting"].includes(item.status))) return null;
    const done = active.filter(item => item.status === "done").length;
    const running = active.find(item => item.status === "converting");
    return (done + (running?.progress ?? 0)) / active.length;
}

function App() {
    const [mode, setMode] = useState(modeSingle);
    const [file, setFile] = useState(null);
    const [farFile, setFarFile] = useState(null);
    const [swapPixels, setSwapPixels] = useState(64);
    const [choiceKey, setChoiceKey] = useState("balanced");
    const [fit, setFit] = useState(fitPad);
    const [focus, setFocus] = useState(centred);
    const [farFocus, setFarFocus] = useState(centred);
    const [notice, setNotice] = useState(null);
    // Kept here rather than in the bulk view so switching tabs keeps the list.
    const [bulkQueue] = useState(() => new BulkQueue({
        convert: convertImage,
        probe: (file) => probeImage(file, {thumbnailSize: bulkThumbnailSize}),
    }));

    const mipTrick = mode === modeMipTrick;

    // Rejects unsupported files here, where the reason can still be shown.
    const accept = (onAccepted) => (selected) => {
        if (!acceptedTypes.includes(selected.type)) {
            setNotice(`${selected.name} is not a ${acceptedNames} image`);
            return;
        }
        setNotice(null);
        onAccepted(selected);
    };
    const selectFile = accept((selected) => {
        setFile(selected);
        setFocus(centred);
    });
    const selectFarFile = accept((selected) => {
        setFarFile(selected);
        setFarFocus(centred);
    });

    const probe = useProbe(file);
    const info = probe.info;
    const farProbe = useProbe(mipTrick ? farFile : null);

    const candidates = useMemo(
        () => info ? listCandidates(info.width, info.height, info.durations, {useMips: mipTrick, fit}) : [],
        [info, mipTrick, fit]);
    const choice = candidateChoices.find(c => c.key === choiceKey);

    const job = useMemo(() => {
        if (!file) return null;
        if (mipTrick && !farFile) return null;
        return {
            file,
            options: {
                preference: choice.preference,
                keepAllFrames: choice.keepAllFrames,
                fit,
                focus,
                mipTrick: mipTrick ? {file: farFile, swapPixels, focus: farFocus} : null,
            },
        };
    }, [file, farFile, mipTrick, swapPixels, choice, fit, focus, farFocus]);

    const {status, progress, result, error} = useConversion(job);
    const converting = status === "converting";
    const baseName = file ? baseNameOf(file) : null;

    // Shown under the header whatever the view, so work in progress is never missed.
    const bulkSnapshot = useSyncExternalStore(bulkQueue.subscribe, bulkQueue.getSnapshot);
    const activity = mode === modeBulk ? bulkActivity(bulkSnapshot) : converting ? progress : null;

    return (
        <div className="flex grow flex-col"
             onDragOver={(event) => event.preventDefault()}
             onDrop={(event) => {
                 event.preventDefault();
                 if (mode === modeBulk) return;
                 const dropped = event.dataTransfer.files?.[0];
                 if (dropped) selectFile(dropped);
             }}>
            <header className="sticky top-0 z-10 border-b border-zinc-300 bg-plaster/95 backdrop-blur dark:border-zinc-800 dark:bg-concrete/95">
                <div className="mx-auto flex max-w-7xl flex-wrap items-end justify-between gap-4 px-6 pt-4 pb-3">
                    <div>
                        <h1 className="font-stencil text-4xl leading-none font-extrabold text-ink dark:text-zinc-100">Spray Converter</h1>
                        <p className="mt-1 text-sm text-steel dark:text-zinc-400">Turn images and GIFs into Team Fortress 2 sprays</p>
                    </div>
                    <div className="flex gap-1" role="tablist">
                        {modes.map(([value, label]) => (
                            <button key={value} type="button" role="tab" aria-selected={mode === value}
                                    className={`cursor-pointer rounded-sm px-3 py-1 font-display text-lg font-semibold ${mode === value ? "bg-ink text-plaster dark:bg-zinc-100 dark:text-concrete" : "text-zinc-600 hover:bg-zinc-300/60 dark:text-zinc-300 dark:hover:bg-zinc-800"}`}
                                    onClick={() => setMode(value)}>
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="h-0.5">
                    {activity !== null && (
                        <div className="h-full bg-paint" style={{width: `${Math.max(2, Math.round(activity * 100))}%`}}/>
                    )}
                </div>
            </header>

            {mode === modeBulk ? <Bulk queue={bulkQueue}/> : (
                <main className="mx-auto grid w-full max-w-7xl grow items-start gap-6 p-6 md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(14rem,18rem)]">
                    <Panel title="Source">
                        <DropZone label={mipTrick ? "Close up" : "Image"} hint="drop or choose an image"
                                  file={file} onSelect={selectFile} compact={!!info}/>
                        {info && <SourceThumbnail info={info} fit={fit} focus={focus} onFocus={setFocus}/>}
                        {probe.status === "error" && <div className="text-sm text-alarm">Could not read {file.name}: {probe.error.message}</div>}
                        {mipTrick && (
                            <>
                                <DropZone label="Distant" hint="shown once the spray is small on screen"
                                          file={farFile} onSelect={selectFarFile} compact/>
                                {farProbe.info && <SourceThumbnail info={farProbe.info} fit={fit} focus={farFocus} onFocus={setFarFocus}/>}
                                {farProbe.status === "error" && <div className="text-sm text-alarm">Could not read {farFile.name}: {farProbe.error.message}</div>}
                                <label className="flex flex-col gap-1 text-sm">
                                    <Label>Swap to the distant image under</Label>
                                    <select className="rounded-xs border border-zinc-400 bg-transparent px-2 py-1"
                                            value={swapPixels} onChange={(event) => setSwapPixels(Number(event.target.value))}>
                                        {swapOptions.map(({pixels, label, hint}) => <option key={pixels} value={pixels}>{label} — {hint}</option>)}
                                    </select>
                                </label>
                            </>
                        )}
                        <div className="flex flex-col gap-1">
                            <Label>Fit to the square spray</Label>
                            <FitControl fit={fit} onChange={setFit}/>
                        </div>
                        {notice && <div className="text-sm text-alarm">{notice}</div>}
                    </Panel>

                    <Panel title="Preview">
                        <Preview result={result} converting={converting} progress={progress}
                                 emptyText={mipTrick && file && !farFile
                                     ? "Add the distant image to make the spray"
                                     : `Drop a ${acceptedNames} anywhere to make a spray`}/>
                        {status === "error" && <div className="text-sm text-alarm">Failed to convert: {error.message}</div>}
                    </Panel>

                    <Panel title="Spray">
                        {!file && <p className="text-sm text-zinc-500 dark:text-zinc-400">Size and frame options appear here once there is an image.</p>}
                        <ChoicePicker candidates={candidates} selected={choiceKey} onSelect={setChoiceKey}/>
                        {status === "done" && <OutputPanel result={result} baseName={baseName}/>}
                        {converting && (
                            <div className="flex flex-col gap-2 border-l-4 border-paint py-1 pl-3" aria-live="polite">
                                <div className="flex items-center gap-2 font-display text-lg font-semibold">
                                    <Spinner className="h-4 w-4 text-paint-strong"/>
                                    Converting
                                    <span className="ml-auto tabular-nums">{Math.round(progress * 100)}%</span>
                                </div>
                                <ProgressBar value={progress}/>
                            </div>
                        )}
                    </Panel>
                </main>
            )}

            <footer className="mx-auto flex w-full max-w-7xl flex-wrap justify-between gap-2 border-t border-zinc-300 px-6 py-4 text-sm text-steel dark:border-zinc-800 dark:text-zinc-400">
                <span>Nothing is uploaded: every image is converted on this device.</span>
                <span className="flex gap-4">
                    <a href={siteUrl} className="underline decoration-paint decoration-2 underline-offset-4 hover:text-ink dark:hover:text-zinc-100">azuisleet.github.io</a>
                    <a href={sourceUrl} className="underline decoration-paint decoration-2 underline-offset-4 hover:text-ink dark:hover:text-zinc-100">Source code</a>
                </span>
            </footer>
        </div>
    )
}

export default App
