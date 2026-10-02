import {useDeferredValue, useEffect, useEffectEvent, useMemo, useState, useSyncExternalStore} from 'react'
import {BulkQueue} from "./bulkQueue.js";
import Bulk from "./components/Bulk.jsx";
import {ChoicePicker, OutputPanel} from "./components/Output.jsx";
import {VtfViewer} from "./components/VtfView.jsx";
import Preview from "./components/Preview.jsx";
import {DropZone, FitControl, SourceThumbnail, TrimControl} from "./components/Source.jsx";
import {defaultTrim, videoDurations} from "./decode.js";
import {Label, Panel, ProgressBar, Spinner} from "./components/ui.jsx";
import {acceptedNames, acceptedTypes, isVtf, namePasted, withKnownType} from "./formats.js";
import {convertImage, probeImage} from "./convert.js";
import {candidateChoices, fitCrop, fitPad, fitStretch, listCandidates} from "./plan.js";
import {readSetting, useSetting, writeSetting} from "./settings.js";
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

const choiceKeys = candidateChoices.map(choice => choice.key);
const fits = [fitPad, fitCrop, fitStretch];

function App() {
    // Settings are remembered between visits; files and crop positions are not.
    const [mode, setMode] = useSetting("mode", modes.map(([value]) => value), modeSingle);
    const [file, setFile] = useState(null);
    // A spray file being looked at rather than converted (single image tab only).
    const [viewFile, setViewFile] = useState(null);
    const [farFile, setFarFile] = useState(null);
    const [swapPixels, setSwapPixels] = useSetting("swapPixels", swapOptions.map(option => option.pixels), 64);
    const [choiceKey, setChoiceKey] = useSetting("choice", choiceKeys, "balanced");
    const [fit, setFit] = useSetting("fit", fits, fitPad);
    const [focus, setFocus] = useState(centred);
    const [farFocus, setFarFocus] = useState(centred);
    // Null follows the image (on when it has soft edges); a choice sticks until the next image.
    const [softEdgesChoice, setSoftEdgesChoice] = useState(null);
    const [pixelArtChoice, setPixelArtChoice] = useState(false);
    // Null uses the start of the video; a chosen span sticks until the next file.
    const [trimChoice, setTrimChoice] = useState(null);
    const [notice, setNotice] = useState(null);
    // Kept here rather than in the bulk view so switching tabs keeps the list.
    const [bulkQueue] = useState(() => new BulkQueue({
        convert: convertImage,
        probe: (file) => probeImage(file, {thumbnailSize: bulkThumbnailSize}),
        settings: {
            choiceKey: readSetting("bulkChoice", choiceKeys, "balanced"),
            fit: readSetting("bulkFit", fits, fitPad),
            softEdges: readSetting("bulkSoftEdges", [true, false], true),
            pixelArt: readSetting("bulkPixelArt", [true, false], false),
        },
    }));

    const mipTrick = mode === modeMipTrick;
    const layoutClass = "mx-auto grid w-full max-w-7xl grow items-start gap-6 p-6 md:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)] lg:grid-cols-[minmax(14rem,18rem)_minmax(0,1fr)_minmax(14rem,18rem)]";

    // Rejects unsupported files here, where the reason can still be shown.
    const accept = (onAccepted) => (dropped) => {
        const selected = withKnownType(dropped);
        if (!acceptedTypes.includes(selected.type)) {
            setNotice(`${selected.name} isn't a ${acceptedNames} file`);
            return;
        }
        setNotice(null);
        onAccepted(selected);
    };
    const convertFrom = (selected) => {
        setViewFile(null);
        setFile(selected);
        setFocus(centred);
        setSoftEdgesChoice(null);
        setTrimChoice(null);
    };
    // A spray dropped on the single image tab is shown as it is; anywhere else, and once
    // asked to, it is just another source to convert.
    const selectFile = accept((selected) => {
        if (isVtf(selected) && mode === modeSingle) {
            setViewFile(selected);
            setFile(null);
        } else {
            convertFrom(selected);
        }
    });
    const selectFarFile = accept((selected) => {
        setFarFile(selected);
        setFarFocus(centred);
    });

    // Ctrl+V anywhere: a pasted image becomes the image here, or joins the bulk queue.
    const onPaste = useEffectEvent((event) => {
        const pasted = [...(event.clipboardData?.files ?? [])].filter(f => acceptedTypes.includes(f.type)).map(f => namePasted(f));
        if (!pasted.length) return;
        event.preventDefault();
        if (mode === modeBulk) bulkQueue.add(pasted);
        else selectFile(pasted[0]);
    });
    useEffect(() => {
        const listener = (event) => onPaste(event);
        window.addEventListener("paste", listener);
        return () => window.removeEventListener("paste", listener);
    }, []);

    const probe = useProbe(file);
    const info = probe.info;
    const softEdges = softEdgesChoice ?? !!info?.softAlpha;
    // Pixel art keeps whole pixels, which a mip chain would blend away.
    const pixelArt = pixelArtChoice && !mipTrick;
    const video = info?.video ?? null;
    // Memoised: the span is part of the conversion job, and a fresh object on every render
    // would restart the conversion on every render.
    const trim = useMemo(() => video ? trimChoice ?? defaultTrim(video.duration) : null, [video, trimChoice]);
    // Dragging the trim sliders updates them at once; planning follows when there is time.
    const plannedTrim = useDeferredValue(trim);
    const durations = useMemo(
        () => video && plannedTrim ? videoDurations(plannedTrim.end - plannedTrim.start) : info?.durations,
        [video, plannedTrim, info]);
    const farProbe = useProbe(mipTrick ? farFile : null);

    const candidates = useMemo(
        // Every frame of a video means its 30 a second played at 5: not worth offering.
        () => info ? listCandidates(info.width, info.height, durations, {useMips: mipTrick, fit, softEdges, pixelArt})
            .filter(candidate => !(video && candidate.keepAllFrames)) : [],
        [info, durations, video, mipTrick, fit, softEdges, pixelArt]);
    const choice = candidateChoices.find(c => c.key === (video && choiceKey === "all" ? "balanced" : choiceKey));

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
                softEdges,
                pixelArt,
                trim: plannedTrim,
                mipTrick: mipTrick ? {file: farFile, swapPixels, focus: farFocus} : null,
            },
        };
    }, [file, farFile, mipTrick, swapPixels, choice, fit, focus, farFocus, softEdges, pixelArt, plannedTrim]);

    const {status, progress, result, error} = useConversion(job);
    const converting = status === "converting";
    const baseName = file ? baseNameOf(file) : null;

    // Shown under the header whatever the view, so work in progress is never missed.
    const bulkSnapshot = useSyncExternalStore(bulkQueue.subscribe, bulkQueue.getSnapshot);

    useEffect(() => {
        writeSetting("bulkChoice", bulkSnapshot.settings.choiceKey);
        writeSetting("bulkFit", bulkSnapshot.settings.fit);
        writeSetting("bulkSoftEdges", bulkSnapshot.settings.softEdges);
        writeSetting("bulkPixelArt", bulkSnapshot.settings.pixelArt);
    }, [bulkSnapshot.settings]);
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

            {mode === modeBulk ? <Bulk queue={bulkQueue}/> : mode === modeSingle && viewFile ? (
                <VtfViewer file={viewFile} onSelect={selectFile} onConvert={() => convertFrom(viewFile)} layoutClass={layoutClass}/>
            ) : (
                <main className={layoutClass}>
                    <Panel title="Source">
                        <DropZone label={mipTrick ? "Close up" : "Image, video or spray"} hint="drop, choose or paste one"
                                  file={file} onSelect={selectFile} compact={!!info}/>
                        {info && <SourceThumbnail info={info} fit={fit} focus={focus} onFocus={setFocus} pixelated={pixelArt}/>}
                        {video && <TrimControl duration={video.duration} trim={trim} onTrim={setTrimChoice}/>}
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
                        <div className="flex flex-col gap-2 text-sm">
                            <label className="flex items-start gap-2">
                                <input type="checkbox" className="mt-1" checked={softEdges}
                                       onChange={(event) => setSoftEdgesChoice(event.target.checked)}/>
                                <span>
                                    Soft edges
                                    <span className="block text-steel dark:text-zinc-400">
                                        {info?.softAlpha && softEdgesChoice === null
                                            ? "On because this image has them. Uses twice the bytes per pixel."
                                            : "Keeps partial transparency, at twice the bytes per pixel."}
                                    </span>
                                </span>
                            </label>
                            <label className={`flex items-start gap-2 ${mipTrick ? "opacity-50" : ""}`}>
                                <input type="checkbox" className="mt-1" checked={pixelArt} disabled={mipTrick}
                                       onChange={(event) => setPixelArtChoice(event.target.checked)}/>
                                <span>
                                    Pixel art
                                    <span className="block text-steel dark:text-zinc-400">
                                        {mipTrick
                                            ? "Not available with a mip trick."
                                            : "Keeps every pixel whole and sharp in game, in exact colour when it fits."}
                                    </span>
                                </span>
                            </label>
                        </div>
                        {notice && <div className="text-sm text-alarm">{notice}</div>}
                    </Panel>

                    <Panel title="Preview">
                        <Preview result={result} converting={converting} progress={progress}
                                 emptyText={mipTrick && file && !farFile
                                     ? "Add the distant image to make the spray"
                                     : `Drop or paste a ${acceptedNames} anywhere to make a spray`}/>
                        {status === "error" && <div className="text-sm text-alarm">Failed to convert: {error.message}</div>}
                    </Panel>

                    <Panel title="Spray">
                        {!file && <p className="text-sm text-zinc-500 dark:text-zinc-400">Size and frame options appear here once there is an image.</p>}
                        <ChoicePicker candidates={candidates} selected={choice.key} onSelect={setChoiceKey}/>
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
