import { useState, useCallback, useRef, useEffect } from "react";
import ReelFeed from "./ReelFeed";

type UploadStatus = "idle" | "uploading" | "done" | "error";

interface UploadState {
    status: UploadStatus;
    file: File | null;
    message: string;
    jobId: string | null;
}

type JobPhase = "queued" | "running" | "complete" | "errored" | "unknown";

interface Reel {
    index: number;
    url: string;
}

interface JobProgress {
    phase: string;
    totalPages?: number;
    totalReels?: number;
    titles?: string[];
    audioCompleted: number;
    videoCompleted: number;
}

function progressMessage(progress: JobProgress | null, phase: JobPhase): string {
    if (!progress) {
        return phase === "queued" ? "Waiting to start..." : "Processing...";
    }
    switch (progress.phase) {
        case "parsing":
            return "Parsing your PDF...";
        case "parsed":
            return `Extracted ${progress.totalPages ?? "?"} pages. Generating scripts...`;
        case "generating_audio":
            return progress.totalReels
                ? `Generating audio... ${progress.audioCompleted}/${progress.totalReels}`
                : "Generating audio...";
        case "compositing_video":
            return progress.totalReels
                ? `Compositing videos... ${progress.videoCompleted}/${progress.totalReels}`
                : "Compositing videos...";
        case "complete":
            return `Done! ${progress.totalReels ?? ""} reels ready.`;
        default:
            return "Processing...";
    }
}

export default function App() {
    const [upload, setUpload] = useState<UploadState>({
        status: "idle",
        file: null,
        message: "",
        jobId: null,
    });
    const [dragOver, setDragOver] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    // Job polling state
    const [jobPhase, setJobPhase] = useState<JobPhase>("unknown");
    const [jobProgress, setJobProgress] = useState<JobProgress | null>(null);
    const [reels, setReels] = useState<Reel[]>([]);
    const [jobError, setJobError] = useState<string | null>(null);
    const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // Download-all state
    const [downloadingAll, setDownloadingAll] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState(0);

    const safeFilename = (title: string) =>
        title.replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_").slice(0, 80);

    const handleDownloadAll = useCallback(async () => {
        if (reels.length === 0 || downloadingAll) return;
        setDownloadingAll(true);
        setDownloadProgress(0);

        for (let i = 0; i < reels.length; i++) {
            const reel = reels[i];
            if (!reel) continue;
            try {
                const res = await fetch(reel.url);
                const blob = await res.blob();
                const title = jobProgress?.titles?.[i];
                const filename = title
                    ? `${safeFilename(title)}.mp4`
                    : `reel-${i + 1}.mp4`;
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                a.click();
                URL.revokeObjectURL(a.href);
            } catch {
                // Skip failed downloads silently
            }
            setDownloadProgress(i + 1);
            // Small delay between downloads so the browser doesn't choke
            if (i < reels.length - 1) {
                await new Promise((r) => setTimeout(r, 500));
            }
        }

        setDownloadingAll(false);
    }, [reels, downloadingAll, jobProgress]);

    const handleFile = useCallback((file: File) => {
        if (file.type !== "application/pdf") {
            setUpload((prev) => ({
                ...prev,
                status: "error",
                message: "Only PDF files are supported",
                file: null,
            }));
            return;
        }

        setUpload({
            status: "idle",
            file,
            message: "",
            jobId: null,
        });
    }, []);

    const handleDrop = useCallback(
        (e: React.DragEvent) => {
            e.preventDefault();
            setDragOver(false);
            const file = e.dataTransfer.files[0];
            if (file) handleFile(file);
        },
        [handleFile],
    );

    const handleDragOver = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(true);
    }, []);

    const handleDragLeave = useCallback((e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
    }, []);

    const handleInputChange = useCallback(
        (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) handleFile(file);
        },
        [handleFile],
    );

    const handleUpload = useCallback(async () => {
        if (!upload.file) return;

        setUpload((prev) => ({
            ...prev,
            status: "uploading",
            message: "Uploading...",
        }));

        try {
            const formData = new FormData();
            formData.append("file", upload.file);

            const res = await fetch("/api/upload", {
                method: "POST",
                body: formData,
            });

            if (!res.ok) {
                let errorMessage = "Upload failed";

                // Try to extract an error message from a JSON response, if present
                try {
                    const errorData = (await res.json()) as { message?: string };
                    if (errorData && typeof errorData.message === "string" && errorData.message.trim() !== "") {
                        errorMessage = errorData.message;
                    }
                } catch {
                    // If the body isn't valid JSON, fall back to plain text (if any)
                    try {
                        const text = await res.text();
                        if (text.trim() !== "") {
                            errorMessage = text;
                        }
                    } catch {
                        // Ignore secondary errors and keep the default message
                    }
                }

                throw new Error(errorMessage);
            }

            let data: { jobId: string; message: string };
            try {
                data = (await res.json()) as { jobId: string; message: string };
            } catch {
                throw new Error("Invalid server response");
            }
            setUpload((prev) => ({
                ...prev,
                status: "done",
                message: data.message,
                jobId: data.jobId,
            }));
        } catch (err) {
            setUpload((prev) => ({
                ...prev,
                status: "error",
                message: err instanceof Error ? err.message : "Upload failed",
            }));
        }
    }, [upload.file]);

    const stopPolling = useCallback(() => {
        if (pollingRef.current) {
            clearInterval(pollingRef.current);
            pollingRef.current = null;
        }
    }, []);

    const reset = useCallback(() => {
        stopPolling();
        setUpload({ status: "idle", file: null, message: "", jobId: null });
        setJobPhase("unknown");
        setJobProgress(null);
        setReels([]);
        setJobError(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
    }, [stopPolling]);

    // Poll for job status once we have a jobId
    const pollJob = useCallback(
        async (jobId: string) => {
            try {
                const res = await fetch(`/api/status/${jobId}`);
                if (!res.ok) return;
                const data = (await res.json()) as {
                    status: string;
                    progress: JobProgress | null;
                    reels?: Reel[];
                    error?: string;
                };

                // Map workflow status string to our phase
                let phase: JobPhase = "unknown";
                if (data.status === "queued") phase = "queued";
                else if (data.status === "running") phase = "running";
                else if (data.status === "complete") phase = "complete";
                else if (
                    data.status === "errored" ||
                    data.status === "terminated"
                )
                    phase = "errored";

                setJobPhase(phase);
                setJobProgress(data.progress);

                if (phase === "complete" && data.reels) {
                    setReels(data.reels);
                    stopPolling();
                }

                if (phase === "errored") {
                    setJobError(data.error ?? "Processing failed");
                    stopPolling();
                }
            } catch {
                // Network error -- keep polling
            }
        },
        [stopPolling],
    );

    // Start polling when upload completes
    useEffect(() => {
        if (upload.status === "done" && upload.jobId) {
            setJobPhase("queued");
            setJobProgress(null);
            setReels([]);
            setJobError(null);

            // Poll immediately, then every 3 seconds
            pollJob(upload.jobId);
            pollingRef.current = setInterval(
                () => pollJob(upload.jobId!),
                3000,
            );
        }

        return () => stopPolling();
    }, [upload.status, upload.jobId, pollJob, stopPolling]);

    const formatSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    };

    return (
        <div className="min-h-screen flex flex-col">
            {/* Header */}
            <header className="border-b border-border-subtle px-6 py-4">
                <div className="max-w-3xl mx-auto flex items-center gap-3">

                    <h1 className="text-xl font-semibold bg-gradient-to-r from-green-start to-green-end bg-clip-text text-transparent">
                        LearnScrolling
                    </h1>
                </div>
            </header>

            {/* Main */}
            <main className="flex-1 flex items-center justify-center px-6 py-12">
                <div className="w-full max-w-xl space-y-8">
                    {/* Title */}
                    <div className="text-center space-y-2">
                        <h2 className="text-3xl font-bold">
                            Turn textbooks into{" "}
                            <span className="bg-gradient-to-r from-green-start via-green-mid to-green-end bg-clip-text text-transparent">
                                Reels
                            </span>
                        </h2>
                        <p className="text-neutral-400">
                            Upload a PDF of your textbook (up to 10MB) and we'll generate short-form video with Peter and Stewie Griffin from Family Guy<sup>1</sup> discussing the content over Minecraft parkour gameplay.
                        </p>
                    </div>

                    {/* Drop Zone */}
                    <div
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onClick={() => fileInputRef.current?.click()}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                fileInputRef.current?.click();
                            }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-label="Upload PDF file"
                        className={`
              relative cursor-pointer rounded-2xl border-2 border-dashed p-12
              transition-all duration-200 text-center
              ${dragOver
                                ? "border-green-mid bg-green-mid/5 scale-[1.01]"
                                : upload.file
                                    ? "border-green-start/40 bg-surface-raised"
                                    : "border-border-subtle bg-surface hover:border-green-start/30 hover:bg-surface-raised"
                            }
            `}
                    >
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".pdf,application/pdf"
                            onChange={handleInputChange}
                            className="hidden"
                        />

                        {upload.file ? (
                            <div className="space-y-3">
                                <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface-overlay">
                                    <svg
                                        className="size-5 text-green-mid"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        strokeWidth={1.5}
                                        stroke="currentColor"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z"
                                        />
                                    </svg>
                                    <span className="text-sm font-medium text-neutral-200">
                                        {upload.file.name}
                                    </span>
                                    <span className="text-xs text-neutral-500">
                                        ({formatSize(upload.file.size)})
                                    </span>
                                </div>
                                <p className="text-xs text-neutral-500">
                                    Click or drop to replace
                                </p>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="inline-flex items-center justify-center size-14 rounded-2xl bg-surface-raised border border-border-subtle">
                                    <svg
                                        className="size-7 text-green-mid"
                                        fill="none"
                                        viewBox="0 0 24 24"
                                        strokeWidth={1.5}
                                        stroke="currentColor"
                                    >
                                        <path
                                            strokeLinecap="round"
                                            strokeLinejoin="round"
                                            d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5"
                                        />
                                    </svg>
                                </div>
                                <div>
                                    <p className="text-neutral-300 font-medium">
                                        Drop your PDF here
                                    </p>
                                    <p className="text-sm text-neutral-500 mt-1">
                                        or click to browse files
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleUpload}
                            disabled={!upload.file || upload.status === "uploading" || upload.status === "done"}
                            className={`
                flex-1 py-3 px-6 rounded-xl font-semibold text-sm transition-all duration-200
                ${upload.file && upload.status !== "uploading" && upload.status !== "done"
                                    ? "bg-gradient-to-r from-green-start to-green-mid text-black hover:shadow-lg hover:shadow-green-start/20 hover:scale-[1.01] active:scale-[0.99]"
                                    : "bg-surface-raised text-neutral-600 cursor-not-allowed"
                                }
              `}
                        >
                            {upload.status === "uploading" ? (
                                <span className="inline-flex items-center gap-2">
                                    <svg
                                        className="animate-spin size-4"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                    >
                                        <circle
                                            className="opacity-25"
                                            cx="12"
                                            cy="12"
                                            r="10"
                                            stroke="currentColor"
                                            strokeWidth="4"
                                        />
                                        <path
                                            className="opacity-75"
                                            fill="currentColor"
                                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                                        />
                                    </svg>
                                    Uploading...
                                </span>
                            ) : upload.status === "done" ? (
                                "Reel Queued ✓"
                            ) : (
                                "Generate Reel"
                            )}
                        </button>
                        {upload.file && upload.status !== "uploading" && (
                            <button
                                onClick={reset}
                                className="py-3 px-4 rounded-xl text-sm text-neutral-400 hover:text-neutral-200 hover:bg-surface-raised transition-colors"
                            >
                                Clear
                            </button>
                        )}
                    </div>

                    {/* Upload Status */}
                    {upload.message && (
                        <div
                            className={`rounded-xl px-4 py-3 text-sm ${upload.status === "error"
                                ? "bg-red-500/10 text-red-400 border border-red-500/20"
                                : upload.status === "done"
                                    ? "bg-green-start/10 text-green-end border border-green-start/20"
                                    : "bg-surface-raised text-neutral-400"
                                }`}
                        >
                            {upload.message}
                            {upload.jobId && (
                                <span className="block mt-1 text-xs text-neutral-500">
                                    Job ID: {upload.jobId}
                                </span>
                            )}
                        </div>
                    )}

                    {/* Job Progress */}
                    {upload.status === "done" && jobPhase !== "unknown" && jobPhase !== "complete" && (
                        <div className="rounded-xl border border-border-subtle bg-surface-raised px-4 py-4 space-y-3">
                            <div className="flex items-center gap-3">
                                {jobPhase === "errored" ? (
                                    <div className="size-5 rounded-full bg-red-500/20 flex items-center justify-center">
                                        <svg className="size-3 text-red-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                                        </svg>
                                    </div>
                                ) : (
                                    <svg className="animate-spin size-5 text-green-mid" viewBox="0 0 24 24" fill="none">
                                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                    </svg>
                                )}
                                <div>
                                    {jobPhase === "errored" ? (
                                        <>
                                            <p className="text-sm font-medium text-red-400">Failed</p>
                                            {jobError && (
                                                <p className="text-xs text-red-400/70 mt-0.5">{jobError}</p>
                                            )}
                                        </>
                                    ) : (
                                        <p className="text-sm font-medium text-neutral-200">
                                            {progressMessage(jobProgress, jobPhase)}
                                        </p>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Download All + Completed Reels */}
                    {reels.length > 0 && (
                        <>
                            <button
                                onClick={handleDownloadAll}
                                disabled={downloadingAll}
                                className={`
                                    w-full py-3 px-6 rounded-xl font-semibold text-sm transition-all duration-200
                                    flex items-center justify-center gap-2
                                    ${downloadingAll
                                        ? "bg-surface-raised text-neutral-400 cursor-not-allowed"
                                        : "bg-gradient-to-r from-green-start to-green-mid text-black hover:shadow-lg hover:shadow-green-start/20 hover:scale-[1.01] active:scale-[0.99]"
                                    }
                                `}
                            >
                                {downloadingAll ? (
                                    <>
                                        <svg className="animate-spin size-4" viewBox="0 0 24 24" fill="none">
                                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        Downloading {downloadProgress}/{reels.length}...
                                    </>
                                ) : (
                                    <>
                                        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                                            <polyline points="7 10 12 15 17 10" />
                                            <line x1="12" y1="15" x2="12" y2="3" />
                                        </svg>
                                        Download All Reels ({reels.length})
                                    </>
                                )}
                            </button>
                            <ReelFeed reels={reels} titles={jobProgress?.titles} />
                        </>
                    )}
                </div>
            </main>

            {/* Footer */}
            <footer className="border-t border-border-subtle px-6 py-4 text-center text-xs text-neutral-600 space-y-1">
                <p>ML inference and reel generation powered by Modal &middot; Hosted on Cloudflare Workers</p>
                <p><sup>1</sup> Family Guy and all related characters are property of 20th Television. Minecraft is a trademark of Mojang Studios / Microsoft. LearnScrolling is not affiliated with or endorsed by any of these entities.</p>
            </footer>
        </div>
    );
}
