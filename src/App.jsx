import {useEffect, useRef, useState} from 'react'
import {convertImageToVTF, preferBalanced, preferDetail, preferMotion} from "./encoder.js";
import {buildVMT} from "./vtf.js";

const modeSingle = "single";
const modeMipTrick = "mipTrick";

const acceptedTypes = ["image/gif", "image/png", "image/apng", "image/jpeg", "image/webp", "image/avif"];

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

function sameJob(a, b) {
    return !!a && !!b
        && a.mode === b.mode
        && a.file === b.file
        && a.farFile === b.farFile
        && a.swapPixels === b.swapPixels
        && a.preference === b.preference;
}

// Plain helper rather than a component so the file stays free of prop-types.
function renderDropZone(inputRef, label, hint, file, onSelect) {
    return (
        <div className="flex w-56 cursor-pointer flex-col items-center justify-center gap-1 rounded border-2 border-dashed border-neutral-400 px-3 py-8 text-center"
             onClick={() => inputRef.current.click()}
             onDragOver={(e) => e.preventDefault()}
             onDrop={(event) => {
                 event.preventDefault();
                 const dropped = event.dataTransfer.files?.[0];
                 if (dropped) onSelect(dropped);
             }}>
            <div className="font-bold">{label}</div>
            <div className="text-sm opacity-70">{file ? file.name : hint}</div>
            <input ref={inputRef} type="file" className="hidden" accept={acceptedTypes.join(",")}
                   onClick={(event) => event.stopPropagation()}
                   onChange={(event) => {
                       const selected = event.target.files?.[0];
                       if (selected) onSelect(selected);
                       event.target.value = null;
                   }}
            />
        </div>
    );
}

function App() {
    const [error, setError] = useState();
    const [mode, setMode] = useState(modeSingle);
    const [file, setFile] = useState();
    const [farFile, setFarFile] = useState();
    const [swapPixels, setSwapPixels] = useState(64);
    const [preference, setPreference] = useState(preferBalanced);
    const [baseName, setBaseName] = useState();
    const [progress, setProgress] = useState(0);
    const [converting, setConverting] = useState(false);
    const [result, setResult] = useState();
    const [vtfBlobUrl, setVtfBlobUrl] = useState();
    const [vmtBlobUrl, setVmtBlobUrl] = useState();
    const job = useRef();
    const lastJob = useRef();
    const input = useRef();
    const farInput = useRef();

    const clearOutput = () => {
        if (vtfBlobUrl) window.URL.revokeObjectURL(vtfBlobUrl);
        setVtfBlobUrl(null);
        if (vmtBlobUrl) window.URL.revokeObjectURL(vmtBlobUrl);
        setVmtBlobUrl(null);
        setResult(null);
        setProgress(0);
    };

    const selectFile = (selected) => {
        if (job.current || !acceptedTypes.includes(selected.type)) return;

        setFile(selected);

        const split = selected.name.split(".");
        setBaseName(split.slice(0, split.length - 1).join('.'));
        clearOutput();
    };

    const selectFarFile = (selected) => {
        if (job.current || !acceptedTypes.includes(selected.type)) return;

        setFarFile(selected);
        clearOutput();
    };

    useEffect(() => {
        if (!file || job.current) return;
        if (mode === modeMipTrick && !farFile) return;

        const descriptor = {mode, file, farFile: mode === modeMipTrick ? farFile : null, swapPixels, preference};
        if (sameJob(lastJob.current, descriptor)) return;

        console.log(`Converting ${file.name}`);
        job.current = descriptor;
        setConverting(true);
        setError(null);
        setProgress(0);

        convertImageToVTF(file, setProgress, {
            mipTrick: descriptor.farFile ? {file: descriptor.farFile, swapPixels} : null,
            preference,
        })
            .then(({blob, ...info}) => {
                job.current = null;
                lastJob.current = descriptor;
                setConverting(false);
                setResult(info);
                setVtfBlobUrl(window.URL.createObjectURL(blob));
                setVmtBlobUrl(window.URL.createObjectURL(new Blob([buildVMT(baseName)], {type: "application/binary"})));
            })
            .catch(err => {
                console.error(err);
                setError(`Failed to convert image: ${err.message}`);
                job.current = null;
                lastJob.current = descriptor;
                setConverting(false);
                setResult(null);
                setVtfBlobUrl(null);
                setVmtBlobUrl(null);
            });
    }, [file, farFile, mode, swapPixels, preference, baseName]);

    const waitingForFar = mode === modeMipTrick && !!file && !farFile;

    return (
        <div className="flex flex-grow flex-col items-center justify-center"
             onDragOver={(e) => e.preventDefault()}
             onDrop={(event) => {
                 if (mode !== modeSingle) return;
                 event.preventDefault();
                 const dropped = event.dataTransfer.files?.[0];
                 if (dropped) selectFile(dropped);
             }}>
            <div className="mb-6 flex gap-2">
                {[[modeSingle, "Single Image"], [modeMipTrick, "Mip Trick"]].map(([value, label]) => (
                    <button key={value} type="button"
                            className={`rounded-sm px-4 py-2 ${mode === value ? "bg-blue-600 text-white" : "bg-neutral-200 text-neutral-800"}`}
                            onClick={() => setMode(value)}>
                        {label}
                    </button>
                ))}
            </div>

            {mode === modeSingle ? (
                <>
                    <h1 className="text-3xl font-bold">
                        {!converting ? "Drag and Drop Image" : `Converting ${file.name}`}
                    </h1>
                    <input ref={input} type="file" className="hidden" accept={acceptedTypes.join(",")}
                           onChange={(event) => {
                               const selected = event.target.files?.[0];
                               if (selected) selectFile(selected);
                               event.target.value = null;
                           }}
                    />
                    <button type="button"
                            className="mt-2 rounded-sm bg-blue-600 px-6 py-3 text-white"
                            onClick={() => input.current.click()}>
                        Upload Image
                    </button>
                </>
            ) : (
                <>
                    <h1 className="text-3xl font-bold">
                        {!converting ? "Two Images, One Spray" : `Converting ${file.name}`}
                    </h1>
                    <p className="mt-1 max-w-lg text-center text-sm opacity-70">
                        The close up image lives in the top mips, the distant image takes over
                        below the swap size and fills every mip under it.
                    </p>
                    <div className="mt-4 flex gap-4">
                        {renderDropZone(input, "Close up", "drop the near image", file, selectFile)}
                        {renderDropZone(farInput, "Distant", "drop the far image", farFile, selectFarFile)}
                    </div>
                    <label className="mt-4 flex items-center gap-2">
                        <span>Swap when the spray is under</span>
                        <select className="rounded-sm border border-neutral-400 bg-transparent px-2 py-1"
                                value={swapPixels}
                                onChange={(event) => setSwapPixels(Number(event.target.value))}>
                            {swapOptions.map(({pixels, label, hint}) => (
                                <option key={pixels} value={pixels}>{label} — {hint}</option>
                            ))}
                        </select>
                    </label>
                    {waitingForFar && <div className="mt-2 text-sm opacity-70">Waiting for the distant image</div>}
                </>
            )}

            <label className="mt-4 flex items-center gap-2 text-sm">
                <span className="opacity-70">When it will not all fit</span>
                <select className="rounded-sm border border-neutral-400 bg-transparent px-2 py-1"
                        value={preference}
                        onChange={(event) => setPreference(event.target.value)}>
                    {preferenceOptions.map(({value, label}) => (
                        <option key={value} value={value}>{label}</option>
                    ))}
                </select>
            </label>

            {error && <div className="mt-4 text-red-600">{error}</div>}
            {(converting || vtfBlobUrl) && (
                <div className="mt-6 flex flex-col gap-4">
                    <progress className="w-64 bg-neutral-50" max={1} value={progress}/>
                    {result && (
                        <div className="self-center text-center text-sm opacity-70">
                            {result.width}×{result.height}
                            {result.sourceFrames > 1 && `, ${result.frames}/${result.sourceFrames} frames`}
                            {result.padding > 0.005 && `, ${Math.round(result.padding * 100)}% padding`}
                            {`, ${result.bytes.toLocaleString()} bytes`}
                            {result.swapLevel !== null &&
                                `, distant image from mip ${result.swapLevel} (${result.swapDimension} px) down`}
                        </div>
                    )}
                    {vtfBlobUrl && (
                        <div className="self-center">
                            <a href={vtfBlobUrl} download={`${baseName}.vtf`} className="underline">{baseName}.vtf</a>
                        </div>
                    )}
                    {vmtBlobUrl && (
                        <div className="self-center">
                            <a href={vmtBlobUrl} download={`${baseName}.vmt`} className="underline">{baseName}.vmt</a>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

export default App
