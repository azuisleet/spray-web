import {useMemo} from "react";
import {downloadBlob, useVtf} from "../useConversion.js";
import {uploadLimit} from "../vtfRead.js";
import Preview from "./Preview.jsx";
import {DropZone} from "./Source.jsx";
import {Panel} from "./ui.jsx";

const severityStyles = {
    error: "border-alarm text-alarm",
    warning: "border-amber-500 text-amber-800 dark:text-amber-300",
    info: "border-zinc-300 text-zinc-700 dark:border-zinc-600 dark:text-zinc-300",
};

/** What the file holds, as its header describes it. */
export function VtfFacts({vtf}) {
    const facts = [
        ["Version", vtf.version],
        ["Size", `${vtf.fileSize.toLocaleString()} bytes${vtf.fileSize > uploadLimit ? " (over 512 KB)" : ""}`],
        vtf.formatName && ["Format", vtf.formatName],
        vtf.width && ["Texture", `${vtf.width}×${vtf.height}`],
        vtf.frames > 1 && ["Frames", `${vtf.frames}`],
        vtf.mipCount > 1 && ["Mip levels", `${vtf.mipCount}`],
        vtf.flagNames?.length && ["Flags", vtf.flagNames.join(", ")],
    ].filter(Boolean);
    return (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            {facts.map(([term, value]) => (
                <div key={term} className="contents">
                    <dt className="text-steel dark:text-zinc-400">{term}</dt>
                    <dd className="tabular-nums">{value}</dd>
                </div>
            ))}
        </dl>
    );
}

/** The checks against what works as a spray, and what can be done with the file. */
export function VtfChecks({vtf, file, onConvert}) {
    const unreadable = vtf.checks.some(check => check.severity === "error");
    return (
        <div className="flex flex-col gap-3">
            <ul className="flex flex-col gap-2 text-sm">
                {vtf.checks.map(check => (
                    <li key={check.text} className={`border-l-4 py-0.5 pl-3 ${severityStyles[check.severity]}`}>{check.text}</li>
                ))}
            </ul>
            {!unreadable && (
                <>
                    <button type="button" onClick={onConvert}
                            className="cursor-pointer rounded-xs bg-paint px-4 py-2 font-semibold text-ink hover:bg-paint-strong">
                        Convert this
                    </button>
                    <p className="text-sm text-steel dark:text-zinc-400">
                        Makes a new spray from it, with every option here: to make it fit, change its size or format, or crop it.
                        It is encoded again, so it loses a little detail, and a mip trick keeps only its close-up image.
                    </p>
                </>
            )}
            <button type="button" onClick={() => downloadBlob(file, file.name)}
                    className="cursor-pointer self-start text-sm underline opacity-80">
                Download original
            </button>
        </div>
    );
}

/**
 * A VTF shown as it is, nothing converted: the same three columns as making a spray, with
 * the file's facts, the preview TF2 would show, and checks with what can be done next.
 */
export function VtfViewer({file, onSelect, onConvert, layoutClass}) {
    const vtf = useVtf(file);
    const unreadable = vtf?.checks.some(check => check.severity === "error");
    // In the shape the preview expects of a converted spray, already decoded.
    const result = useMemo(() => vtf && !unreadable ? {
        width: vtf.width, height: vtf.height, levels: vtf.levels, mipCount: vtf.mipCount,
        format: "decoded", pointSample: vtf.pointSample, swapLevel: null, swapDimension: null,
    } : null, [vtf, unreadable]);

    return (
        <main className={layoutClass}>
            <Panel title="Source">
                <DropZone label="Image, video or spray" hint="drop, choose or paste one" file={file} onSelect={onSelect} compact/>
                {vtf && <VtfFacts vtf={vtf}/>}
            </Panel>
            <Panel title="Preview">
                <Preview result={result} converting={false} progress={0}
                         emptyText={vtf ? "This file cannot be shown" : "Reading the spray"}/>
            </Panel>
            <Panel title="Spray file">
                {vtf && <VtfChecks vtf={vtf} file={file} onConvert={onConvert}/>}
            </Panel>
        </main>
    );
}
