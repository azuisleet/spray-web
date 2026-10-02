// Shared visual pieces, so every view draws columns and progress the same way.
import {headingClass} from "./styles.js";

/** One column: a heading and its contents, with no box around it; the wall is the box. */
export function Panel({title, aside, children}) {
    return (
        <section className="flex min-w-0 flex-col gap-4">
            <div className="flex items-baseline justify-between gap-2 border-b border-zinc-300 pb-1 dark:border-zinc-700">
                <h2 className={`truncate ${headingClass}`}>{title}</h2>
                {aside && <span className="shrink-0 text-sm text-steel tabular-nums dark:text-zinc-400">{aside}</span>}
            </div>
            {children}
        </section>
    );
}

/** A caption above a control. */
export function Label({children}) {
    return <span className="text-sm text-steel dark:text-zinc-400">{children}</span>;
}

// No width transition: most conversions finish faster than an eased bar could follow,
// so the bar shows each reported value as it arrives.
export function ProgressBar({value, className = ""}) {
    return (
        <div className={`h-1.5 overflow-hidden rounded-full bg-zinc-300 dark:bg-zinc-700 ${className}`}
             role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
            <div className="h-full rounded-full bg-paint" style={{width: `${Math.round(value * 100)}%`}}/>
        </div>
    );
}

export function Spinner({className = "h-5 w-5"}) {
    return (
        <svg viewBox="0 0 24 24" className={`animate-spin ${className}`} aria-hidden="true">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3"/>
            <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"/>
        </svg>
    );
}
