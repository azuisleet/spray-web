import {useEffect, useRef, useState} from "react";
import {decodeDXT1} from "../dxt1.js";
import {engineFrameRate, mipAt} from "../plan.js";
import {ProgressBar, Spinner} from "./ui.jsx";

// Canvas resolution until the preview box has been measured.
const initialCanvasSize = 768;

// Distance slider range, as log2 of the spray's size on screen in pixels.
const nearestLog2 = 10;
const farthestLog2 = 2;

// A wall by default, since that is where a spray ends up; the checkerboard shows exactly
// which texels are transparent.
const backgrounds = [
    {key: "light", label: "Light concrete", className: "wall-light"},
    {key: "dark", label: "Dark concrete", className: "wall-dark"},
    {key: "checker", label: "Checkerboard", className: "checker"},
];

/** Decodes every mip level of every frame into bitmaps, as bitmaps[level][frame]. */
function useLevels(result) {
    const [decoded, setDecoded] = useState({result: null, levels: null});

    useEffect(() => {
        if (!result) return;
        let cancelled = false;
        const {width, height, levels} = result;
        Promise.all(levels.map((frames, level) => {
            const w = Math.max(1, width >> level);
            const h = Math.max(1, height >> level);
            return Promise.all(frames.map(blocks =>
                createImageBitmap(new ImageData(new Uint8ClampedArray(decodeDXT1(w, h, blocks).buffer), w, h))));
        })).then(bitmaps => {
            if (!cancelled) setDecoded({result, levels: bitmaps});
        });
        return () => {
            cancelled = true;
        };
    }, [result]);

    return decoded.result === result ? decoded.levels : null;
}

// Drawn rather than taken from a font: Windows turns the usual triangle characters into
// coloured emoji.
const icons = {
    previous: "M15 5v14L6 12zM5 5h2v14H5z",
    next: "M9 5v14l9-7zM17 5h2v14h-2z",
    play: "M7 5v14l12-7z",
    pause: "M7 5h4v14H7zM13 5h4v14h-4z",
};

function Icon({name}) {
    return (
        <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden="true">
            <path d={icons[name]}/>
        </svg>
    );
}

function IconButton({label, onClick, children}) {
    return (
        <button type="button" title={label} aria-label={label} onClick={onClick}
                className="cursor-pointer rounded-xs px-2 py-1 hover:bg-zinc-200 dark:hover:bg-zinc-700">
            {children}
        </button>
    );
}

function DistanceControl({result, screenLog2, onChange, mip, magnify, onMagnify}) {
    const screenPixels = Math.round(2 ** screenLog2);
    const level = (n) => `mip ${n} (${Math.max(1, result.width >> n)}×${Math.max(1, result.height >> n)})`;
    const showing = (n) => n >= result.swapLevel ? "distant image" : "close-up image";
    const swapPixels = result.swapDimension;
    // Where the swap sits along the track, which runs from close on the left to far.
    const swapAt = (nearestLog2 - Math.log2(swapPixels)) / (nearestLog2 - farthestLog2) * 100;

    return (
        <div className="flex flex-col gap-2 rounded-sm border border-zinc-300 p-3 text-sm dark:border-zinc-700">
            <div className="flex items-start gap-3">
                <span className="opacity-70">Distance</span>
                <div className="flex grow flex-col">
                    {/* Inverted rather than drawn right to left, so the fill grows from "close". */}
                    <input type="range" className="w-full" min={farthestLog2} max={nearestLog2} step={0.05}
                           value={nearestLog2 + farthestLog2 - screenLog2}
                           onChange={(event) => onChange(nearestLog2 + farthestLog2 - Number(event.target.value))}
                           aria-label="Distance: how small the spray is on screen"/>
                    <div className="relative h-4 text-xs opacity-60">
                        <span className="absolute left-0">close</span>
                        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{left: `${swapAt}%`}}>▲ swap at {swapPixels} px</span>
                        <span className="absolute right-0">far</span>
                    </div>
                </div>
            </div>
            <div className="flex items-center gap-3">
                <span className="opacity-70">Show</span>
                <div className="flex rounded-sm border border-zinc-400" role="radiogroup" aria-label="Preview size">
                    {[[false, "Actual size", "As big as it would be on your screen"], [true, "Magnified", "Enlarged to fill the box, each screen pixel a block"]].map(([value, label, hint]) => (
                        <button key={label} type="button" role="radio" aria-checked={magnify === value} title={hint}
                                onClick={() => onMagnify(value)}
                                className={`cursor-pointer px-3 py-0.5 first:rounded-l-xs last:rounded-r-xs ${magnify === value ? "bg-paint text-ink" : "hover:bg-zinc-200 dark:hover:bg-zinc-700"}`}>
                            {label}
                        </button>
                    ))}
                </div>
            </div>
            <div className="tabular-nums">
                Seen at <strong>{screenPixels} px</strong>: the GPU draws {level(mip.lower)}, the <strong>{showing(mip.lower)}</strong>
                {mip.blend > 0.05 && mip.upper !== mip.lower && (
                    <>, blending {Math.round(mip.blend * 100)}% of {level(mip.upper)}{showing(mip.upper) !== showing(mip.lower) && ` (${showing(mip.upper)})`}</>
                )}
            </div>
        </div>
    );
}

/**
 * The size of element's content box in device pixels, so a canvas can match the screen one
 * to one. Left to CSS, a canvas is resampled to fit, which with pixelated rendering drops
 * whole rows and columns of the enlarged view.
 */
function useDevicePixels(ref) {
    const [size, setSize] = useState(initialCanvasSize);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            const device = entry.devicePixelContentBoxSize?.[0]?.inlineSize;
            setSize(Math.max(1, Math.round(device ?? entry.contentRect.width * window.devicePixelRatio)));
        });
        try {
            observer.observe(element, {box: "device-pixel-content-box"});
        } catch {
            observer.observe(element);  // browsers without device-pixel boxes
        }
        return () => observer.disconnect();
    }, [ref]);

    return size;
}

/**
 * The spray as TF2 draws it: the texture stretched onto a square, frames at the engine's
 * 5 fps on a shared clock, so every spray in a match is on the same frame. A spray with
 * mips also gets a distance control, showing the spray at a given size on screen, made
 * from the mip levels the GPU would use there: at that actual size, so it shrinks as it
 * would walking away, or magnified to fill the box for a closer look.
 */
export default function Preview({result, converting, progress, emptyText}) {
    const boxRef = useRef(null);
    const canvasRef = useRef(null);
    const deviceSize = useDevicePixels(boxRef);
    const levels = useLevels(result);
    const [playing, setPlaying] = useState(true);
    const [pausedFrame, setPausedFrame] = useState(0);
    const [clockFrame, setClockFrame] = useState(0);
    const [background, setBackground] = useState(backgrounds[0].key);
    const [smooth, setSmooth] = useState(true);
    const [screenLog2, setScreenLog2] = useState(nearestLog2);
    const [magnify, setMagnify] = useState(false);

    const frameCount = levels?.[0].length ?? 0;
    const shown = frameCount ? (playing ? clockFrame : pausedFrame) % frameCount : 0;
    const hasMips = !!result && result.mipCount > 1;
    const screenPixels = 2 ** screenLog2;
    const mip = hasMips ? mipAt(result.width, result.height, result.mipCount, screenPixels) : null;
    // Screen pixels are device pixels here, as they are in the game.
    const screenSize = Math.max(1, Math.round(screenPixels));
    const magnified = hasMips && magnify && screenSize < deviceSize;

    // Follows the engine's clock while playing; state changes only when the frame does.
    useEffect(() => {
        if (!playing || frameCount <= 1) return;
        let request;
        const tick = (now) => {
            setClockFrame(Math.floor(now / 1000 * engineFrameRate));
            request = requestAnimationFrame(tick);
        };
        request = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(request);
    }, [playing, frameCount]);

    useEffect(() => {
        const context = canvasRef.current?.getContext("2d");
        if (!context) return;
        context.clearRect(0, 0, deviceSize, deviceSize);
        if (!levels?.[0][shown]) return;

        if (!hasMips) {
            context.imageSmoothingEnabled = smooth;
            context.imageSmoothingQuality = "high";
            context.drawImage(levels[0][shown], 0, 0, deviceSize, deviceSize);
            return;
        }

        // The spray at its size on screen, or at the box's size if it is bigger than that:
        // bilinear samples from the chosen levels, the finer one blended with the coarser
        // as the GPU does between whole levels.
        const size = Math.min(screenSize, deviceSize);
        const screen = new OffscreenCanvas(size, size);
        const screenContext = screen.getContext("2d");
        screenContext.imageSmoothingEnabled = true;
        screenContext.imageSmoothingQuality = "low";
        screenContext.drawImage(levels[mip.lower][shown], 0, 0, size, size);
        if (mip.upper !== mip.lower && mip.blend > 0) {
            screenContext.globalAlpha = mip.blend;
            screenContext.drawImage(levels[mip.upper][shown], 0, 0, size, size);
        }

        if (magnified) {
            // Each screen pixel as a block filling the box. The canvas is at device
            // resolution, so blocks differ by a device pixel at most.
            context.imageSmoothingEnabled = false;
            context.drawImage(screen, 0, 0, deviceSize, deviceSize);
        } else {
            // Pixel for pixel, centred: the size it would be on screen.
            const offset = Math.floor((deviceSize - size) / 2);
            context.drawImage(screen, offset, offset);
        }
    }, [levels, shown, smooth, hasMips, screenSize, deviceSize, magnified, mip?.lower, mip?.upper, mip?.blend]);

    const step = (delta) => {
        setPlaying(false);
        setPausedFrame((shown + delta + frameCount) % frameCount);
    };

    return (
        <div className="flex w-full flex-col gap-2">
            <div ref={boxRef}
                 className={`relative aspect-square w-full overflow-hidden rounded-sm shadow-[inset_0_2px_12px_rgb(0_0_0/0.35)] ring-1 ring-black/20 ${backgrounds.find(b => b.key === background).className}`}>
                <canvas ref={canvasRef} width={deviceSize} height={deviceSize}
                        className={`block h-full w-full transition-opacity ${converting ? "opacity-40" : ""}`}/>
                {magnified && (
                    <div className="absolute top-2 left-2 rounded-xs bg-black/60 px-1.5 py-0.5 text-xs text-white tabular-nums"
                         title="Each screen pixel is shown as a block this many pixels across">
                        magnified ×{(deviceSize / screenSize).toFixed(1)}
                    </div>
                )}
                {!result && !converting && (
                    <div className="absolute inset-0 flex items-center justify-center p-6">
                        {/* On its own plate, since the wall or checkerboard behind can be any shade. */}
                        <p className="max-w-xs rounded-sm bg-concrete/85 px-4 py-2 text-center text-zinc-100 shadow-lg backdrop-blur-sm">
                            {emptyText}
                        </p>
                    </div>
                )}
                {converting && (
                    <div className="absolute inset-0 flex items-center justify-center p-6" aria-live="polite">
                        <div className="flex w-56 flex-col gap-2 rounded-sm bg-concrete/85 px-4 py-3 text-zinc-100 shadow-lg backdrop-blur-sm">
                            <div className="flex items-center gap-2 font-display text-xl font-semibold">
                                <Spinner className="h-4 w-4 text-paint"/>
                                Converting
                                <span className="ml-auto tabular-nums">{Math.round(progress * 100)}%</span>
                            </div>
                            <ProgressBar value={progress}/>
                        </div>
                    </div>
                )}
            </div>

            <div className="flex flex-wrap items-center gap-1 text-sm">
                {frameCount > 1 && (
                    <>
                        <IconButton label="Previous frame" onClick={() => step(-1)}><Icon name="previous"/></IconButton>
                        <IconButton label={playing ? "Pause" : "Play"} onClick={() => {
                            if (playing) setPausedFrame(shown);
                            setPlaying(!playing);
                        }}><Icon name={playing ? "pause" : "play"}/></IconButton>
                        <IconButton label="Next frame" onClick={() => step(1)}><Icon name="next"/></IconButton>
                        <span className="text-steel tabular-nums dark:text-zinc-400">frame {shown + 1} of {frameCount} at {engineFrameRate} fps</span>
                    </>
                )}
                <span className="grow"/>
                {backgrounds.map(b => (
                    <button key={b.key} type="button" title={b.label} aria-label={b.label}
                            onClick={() => setBackground(b.key)}
                            className={`h-5 w-5 cursor-pointer rounded-full border ${b.className} ${background === b.key ? "border-paint ring-2 ring-paint" : "border-zinc-400"}`}/>
                ))}
                <IconButton label={smooth ? "Show texels" : "Smooth, as in game"} onClick={() => setSmooth(!smooth)}>
                    {smooth ? "Smooth" : "Texels"}
                </IconButton>
            </div>

            {hasMips && levels && (
                <DistanceControl result={result} screenLog2={screenLog2} onChange={setScreenLog2} mip={mip}
                                 magnify={magnify} onMagnify={setMagnify}/>
            )}
        </div>
    );
}
