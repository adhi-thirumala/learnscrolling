import { useState, useCallback, useRef } from "react";

type UploadStatus = "idle" | "uploading" | "done" | "error";

interface UploadState {
    status: UploadStatus;
    file: File | null;
    message: string;
    jobId: string | null;
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

    const reset = useCallback(() => {
        setUpload({ status: "idle", file: null, message: "", jobId: null });
        if (fileInputRef.current) fileInputRef.current.value = "";
    }, []);

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
                            Upload a PDF of your textbook and we'll generate short-form video with Peter and Stewie Griffin from Family Guy<sup>1</sup> discussing the content over Minecraft parkour gameplay.
                        </p>
                    </div>

                    {/* Drop Zone */}
                    <div
                        onDrop={handleDrop}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onClick={() => fileInputRef.current?.click()}
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

                    {/* Status */}
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
