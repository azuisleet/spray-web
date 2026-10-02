import {useMemo, useRef, useState} from 'react'
import {preferBalanced, preferDetail, preferMotion} from "./plan.js";
import {downloadBlob, useConversion} from "./useConversion.js";
import {buildVMT} from "./vtf.js";

const modeSingle = "single";
const modeMipTrick = "mipTrick";

const acceptedTypes = ["image/gif", "image/png", "image/apng", "image/jpeg", "image/webp", "image/avif"];
const acceptedNames = "GIF, PNG, JPEG, WebP or AVIF";

const siteUrl = "https://azuisleet.github.io";
const sourceUrl = "https://github.com/azuisleet/spray-web";

// The GPU drops to mip level k once the spray is drawn at about baseDimension / 2^k
// screen pixels, so picking the swap in pixels is resolution independent.
const swapOptions = [
    {pixels: 128, label: "128 px", hint: "a few steps back"},
    {pixels: 64, label: "64 px", hint: "across a room"},
    {pixels: 32, label: "32 px", hint: "across the map"},
    {pixels: 16, label: "16 px", hint: "sniper range"},
];

const preferenceOptions = [
    {value: preferBalanced, label: "Balanced"},
    {value: preferDetail, label: "Favour resolution"},
    {value: preferMotion, label: "Favour smooth motion"},
];

function baseNameOf(file) {
    const dot = file.name.lastIndexOf(".");
    return dot > 0 ? file.name.slice(0, dot) : file.name;
}

function firstFile(fileList) {
    return fileList?.[0] ?? null;
}

function FileInput({inputRef, onSelect}) {
    return (
        <input ref={inputRef} type="file" className="hidden" accept={acceptedTypes.join(",")}
               onClick={(event) => event.stopPropagation()}
               onChange={(event) => {
                   const selected = firstFile(event.target.files);
                   if (selected) onSelect(selected);
                   event.target.value = null;
               }}
        />
    );
}

function DropZone({label, hint, file, onSelect}) {
    const inputRef = useRef();
    return (
        <div className="flex w-56 cursor-pointer flex-col items-center justify-center gap-1 rounded-sm border-2 border-dashed border-neutral-400 px-3 py-8 text-center"
             onClick={() => inputRef.current.click()}
             onDragOver={(event) => event.preventDefault()}
             onDrop={(event) => {
                 event.preventDefault();
                 event.stopPropagation();
                 const dropped = firstFile(event.dataTransfer.files);
                 if (dropped) onSelect(dropped);
             }}>
            <div className="font-bold">{label}</div>
            <div className="text-sm opacity-70">{file ? file.name : hint}</div>
            <FileInput inputRef={inputRef} onSelect={onSelect}/>
        </div>
    );
}

function Select({label, value, options, onChange, className = ""}) {
    return (
        <label className={`mt-4 flex items-center gap-2 ${className}`}>
            <span>{label}</span>
            <select className="rounded-xs border border-neutral-400 bg-transparent px-2 py-1"
                    value={value}
                    onChange={(event) => onChange(event.target.value)}>
                {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
        </label>
    );
}

function Summary({result}) {
    const parts = [`${result.width}×${result.height}`];
    if (result.sourceFrames > 1) {
        parts.push(`${result.frames} frames from ${result.sourceFrames}`);
        parts.push(`plays in ${result.playSeconds.toFixed(1)} s (original ${result.sourceSeconds.toFixed(1)} s)`);
    }
    if (result.padding > 0.005) parts.push(`${Math.round(result.padding * 100)}% padding`);
    parts.push(`${result.bytes.toLocaleString()} bytes`);
    if (result.swapLevel !== null) parts.push(`distant image from mip ${result.swapLevel} (${result.swapDimension} px) down`);
    return <div className="self-center text-center text-sm opacity-70">{parts.join(", ")}</div>;
}

function DownloadButton({name, blob}) {
    return (
        <button type="button" className="cursor-pointer self-center underline" onClick={() => downloadBlob(blob(), name)}>
            {name}
        </button>
    );
}

function App() {
    const [mode, setMode] = useState(modeSingle);
    const [file, setFile] = useState(null);
    const [farFile, setFarFile] = useState(null);
    const [swapPixels, setSwapPixels] = useState(64);
    const [preference, setPreference] = useState(preferBalanced);
    const [keepAllFrames, setKeepAllFrames] = useState(false);
    const [notice, setNotice] = useState(null);
    const input = useRef();

    // Rejects unsupported files here, where the reason can still be shown.
    const accept = (setter) => (selected) => {
        if (!acceptedTypes.includes(selected.type)) {
            setNotice(`${selected.name} is not a ${acceptedNames} image`);
            return;
        }
        setNotice(null);
        setter(selected);
    };
    const selectFile = accept(setFile);
    const selectFarFile = accept(setFarFile);

    const job = useMemo(() => {
        if (!file) return null;
        if (mode === modeMipTrick && !farFile) return null;
        return {
            file,
            options: {
                preference,
                keepAllFrames,
                mipTrick: mode === modeMipTrick ? {file: farFile, swapPixels} : null,
            },
        };
    }, [mode, file, farFile, swapPixels, preference, keepAllFrames]);

    const {status, progress, result, error} = useConversion(job);
    const done = status === "done";

    const baseName = file ? baseNameOf(file) : null;

    const converting = status === "converting";
    const waitingForFar = mode === modeMipTrick && !!file && !farFile;

    return (
        <>
            <main className="flex grow flex-col items-center justify-center"
                 onDragOver={(event) => event.preventDefault()}
                 onDrop={(event) => {
                     if (mode !== modeSingle) return;
                     event.preventDefault();
                     const dropped = firstFile(event.dataTransfer.files);
                     if (dropped) selectFile(dropped);
                 }}>
                <div className="mb-6 flex gap-2">
                    {[[modeSingle, "Single Image"], [modeMipTrick, "Mip Trick"]].map(([value, label]) => (
                        <button key={value} type="button"
                                className={`cursor-pointer rounded-xs px-4 py-2 ${mode === value ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-800"}`}
                                onClick={() => setMode(value)}>
                            {label}
                        </button>
                    ))}
                </div>

                {mode === modeSingle ? (
                    <>
                        <h1 className="text-3xl font-bold">
                            {converting ? `Converting ${file.name}` : "Drag and Drop Image"}
                        </h1>
                        <FileInput inputRef={input} onSelect={selectFile}/>
                        <button type="button"
                                className="mt-2 cursor-pointer rounded-xs bg-blue-600 px-6 py-3 text-white"
                                onClick={() => input.current.click()}>
                            Upload Image
                        </button>
                    </>
                ) : (
                    <>
                        <h1 className="text-3xl font-bold">
                            {converting ? `Converting ${file.name}` : "Two Images, One Spray"}
                        </h1>
                        <p className="mt-1 max-w-lg text-center text-sm opacity-70">
                            The close up image lives in the top mips, the distant image takes over
                            below the swap size and fills every mip under it.
                        </p>
                        <div className="mt-4 flex gap-4">
                            <DropZone label="Close up" hint="drop the near image" file={file} onSelect={selectFile}/>
                            <DropZone label="Distant" hint="drop the far image" file={farFile} onSelect={selectFarFile}/>
                        </div>
                        <Select label="Swap when the spray is under"
                                value={swapPixels}
                                options={swapOptions.map(({pixels, label, hint}) => ({value: pixels, label: `${label} — ${hint}`}))}
                                onChange={(value) => setSwapPixels(Number(value))}/>
                        {waitingForFar && <div className="mt-2 text-sm opacity-70">Waiting for the distant image</div>}
                    </>
                )}

                <Select label="When it will not all fit" className="text-sm"
                        value={preference} options={preferenceOptions} onChange={setPreference}/>
                <label className="mt-2 flex items-center gap-2 text-sm"
                       title="TF2 plays sprays at 5 frames per second, so extra frames make the animation slower">
                    <input type="checkbox" checked={keepAllFrames} onChange={(event) => setKeepAllFrames(event.target.checked)}/>
                    <span>Keep every frame (plays slower than the original)</span>
                </label>

                {notice && <div className="mt-4 text-red-600">{notice}</div>}
                {status === "error" && <div className="mt-4 text-red-600">Failed to convert image: {error.message}</div>}
                {(converting || done) && (
                    <div className="mt-6 flex flex-col gap-4">
                        <progress className="w-64 bg-neutral-50" max={1} value={progress}/>
                        {done && <Summary result={result}/>}
                        {done && (
                            <>
                                <DownloadButton name={`${baseName}.vtf`} blob={() => result.blob}/>
                                <DownloadButton name={`${baseName}.vmt`}
                                                blob={() => new Blob([buildVMT(baseName)], {type: "text/plain"})}/>
                            </>
                        )}
                    </div>
                )}
            </main>
            <footer className="py-4 text-center text-sm opacity-70">
                Spray Converter · <a href={siteUrl} className="underline">azuisleet.github.io</a>
                {" · "}<a href={sourceUrl} className="underline">source</a>
            </footer>
        </>
    )
}

export default App
