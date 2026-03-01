import {
    WorkflowEntrypoint,
    WorkflowStep,
    WorkflowEvent,
} from "cloudflare:workers";
import { extractText, getDocumentProxy } from "unpdf";
import { generateScripts, type ReelScript } from "./llm";

// --- Types ---

export interface WorkflowParams {
    jobId: string;
    pdfKey: string;
}

export interface ParsedPdf {
    totalPages: number;
    textKey: string;
    textLengthBytes: number;
}

// --- Helpers ---

/** 24 hours in seconds — progress keys auto-expire after this */
const PROGRESS_TTL = 86400;

function log(
    level: "info" | "warn" | "error",
    msg: string,
    data?: Record<string, unknown>,
) {
    const entry = {
        timestamp: new Date().toISOString(),
        level,
        msg,
        ...data,
    };
    if (level === "error") {
        console.error(JSON.stringify(entry));
    } else if (level === "warn") {
        console.warn(JSON.stringify(entry));
    } else {
        console.log(JSON.stringify(entry));
    }
}

// --- Workflow ---

export class ReelGenerationWorkflow extends WorkflowEntrypoint<
    Env,
    WorkflowParams
> {
    async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
        const { jobId, pdfKey } = event.payload;

        log("info", "workflow started", { jobId, pdfKey });

        // Write initial progress
        await this.env.PROGRESS_KV.put(
            `progress:${jobId}`,
            JSON.stringify({ phase: "parsing", updatedAt: new Date().toISOString() }),
            { expirationTtl: PROGRESS_TTL },
        );

        // Step 1: Fetch PDF from R2 and extract text
        const parsed = await step.do(
            "parse-pdf",
            {
                retries: { limit: 3, delay: "5 seconds", backoff: "linear" },
                timeout: "2 minutes",
            },
            async () => {
                log("info", "parse-pdf: fetching from R2", { jobId, pdfKey });

                const object = await this.env.BUCKET.get(pdfKey);
                if (!object) {
                    throw new Error(`PDF not found in R2 at key: ${pdfKey}`);
                }

                const pdfBytes = await object.arrayBuffer();
                log("info", "parse-pdf: PDF fetched", {
                    jobId,
                    sizeBytes: pdfBytes.byteLength,
                });

                const document = await getDocumentProxy(
                    new Uint8Array(pdfBytes),
                );
                const { totalPages, text } = await extractText(document, {
                    mergePages: true,
                });

                const textLengthBytes =
                    new TextEncoder().encode(text).byteLength;

                log("info", "parse-pdf: extraction complete", {
                    jobId,
                    totalPages,
                    textLengthChars: text.length,
                    textLengthBytes,
                });

                // Store extracted text in R2 to avoid workflow step state limit (1 MiB).
                const textKey = `${jobId}/extracted-text.txt`;
                await this.env.BUCKET.put(textKey, text, {
                    httpMetadata: {
                        contentType: "text/plain; charset=utf-8",
                    },
                });
                log("info", "parse-pdf: extracted text stored in R2", {
                    jobId,
                    textKey,
                    textLengthBytes,
                });

                return {
                    totalPages,
                    textKey,
                    textLengthBytes,
                } satisfies ParsedPdf;
            },
        );

        // Progress: PDF parsed
        await this.env.PROGRESS_KV.put(
            `progress:${jobId}`,
            JSON.stringify({
                phase: "parsed",
                totalPages: parsed.totalPages,
                updatedAt: new Date().toISOString(),
            }),
            { expirationTtl: PROGRESS_TTL },
        );

        // Step 2: Cleanup PDF from R2 (best-effort, after parse output is persisted)
        await step.do(
            "cleanup-pdf",
            {
                retries: { limit: 3, delay: "5 seconds", backoff: "linear" },
                timeout: "30 seconds",
            },
            async () => {
                try {
                    await this.env.BUCKET.delete(pdfKey);
                    log("info", "cleanup-pdf: PDF deleted from R2", {
                        jobId,
                        pdfKey,
                    });
                } catch (err) {
                    log("warn", "cleanup-pdf: failed to delete PDF from R2", {
                        jobId,
                        pdfKey,
                        error:
                            err instanceof Error ? err.message : String(err),
                    });
                }
            },
        );

        // Step 3: Send full text to LLM, get back reel scripts
        const scripts = await step.do(
            "generate-scripts",
            {
                retries: {
                    limit: 3,
                    delay: "30 seconds",
                    backoff: "exponential",
                },
                timeout: "5 minutes",
            },
            async () => {
                log(
                    "info",
                    "generate-scripts: fetching extracted text from R2",
                    {
                        jobId,
                        textKey: parsed.textKey,
                    },
                );

                const textObject = await this.env.BUCKET.get(parsed.textKey);
                if (!textObject) {
                    log(
                        "error",
                        "generate-scripts: extracted text not found in R2",
                        {
                            jobId,
                            textKey: parsed.textKey,
                        },
                    );
                    throw new Error(
                        `Extracted text not found in R2 at key: ${parsed.textKey}`,
                    );
                }
                const text = await textObject.text();

                log("info", "generate-scripts: calling LLM", {
                    jobId,
                    inputLengthChars: text.length,
                    totalPages: parsed.totalPages,
                });

                const reels = await generateScripts(text, {
                    apiUrl: this.env.LLM_API_URL,
                    apiKey: this.env.LLM_API_KEY,
                    model: this.env.LLM_MODEL,
                });

                await this.env.BUCKET.delete(parsed.textKey);
                log(
                    "info",
                    "generate-scripts: extracted text deleted from R2",
                    {
                        jobId,
                        textKey: parsed.textKey,
                    },
                );

                log("info", "generate-scripts: complete", {
                    jobId,
                    totalReels: reels.length,
                });

                return reels;
            },
        );

        // Progress: scripts generated, about to start audio
        await this.env.PROGRESS_KV.put(
            `progress:${jobId}`,
            JSON.stringify({
                phase: "generating_audio",
                totalPages: parsed.totalPages,
                totalReels: scripts.length,
                titles: scripts.map((s: ReelScript) => s.title),
                updatedAt: new Date().toISOString(),
            }),
            { expirationTtl: PROGRESS_TTL },
        );

        // Step 4: Generate audio + timestamps for each reel (parallel via Modal TTS)
        const audioResults = await Promise.all(
            scripts.map((script: ReelScript, index: number) =>
                step.do(
                    `generate-audio-${index}`,
                    {
                        retries: {
                            limit: 2,
                            delay: "10 seconds",
                            backoff: "exponential",
                        },
                        timeout: "5 minutes",
                    },
                    async () => {
                        log("info", "generate-audio: calling Modal TTS", {
                            jobId,
                            reelIndex: index,
                            textLength: script.script.length,
                        });

                        const response = await fetch(this.env.TTS_API_URL, {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                                api_key: this.env.TTS_API_KEY,
                                text: script.script,
                                job_id: jobId,
                                reel_index: index,
                            }),
                        });

                        if (!response.ok) {
                            const errorBody = await response.text();
                            log("error", "generate-audio: Modal TTS failed", {
                                jobId,
                                reelIndex: index,
                                status: response.status,
                                error: errorBody.slice(0, 500),
                            });
                            throw new Error(
                                `TTS failed for reel ${index}: ${response.status} ${errorBody.slice(0, 200)}`,
                            );
                        }

                        const result = (await response.json()) as {
                            success: boolean;
                            audioKey: string;
                            timestampsKey: string;
                            durationSeconds: number;
                            wordCount: number;
                        };

                        log("info", "generate-audio: complete", {
                            jobId,
                            reelIndex: index,
                            durationSeconds: result.durationSeconds,
                            wordCount: result.wordCount,
                            audioKey: result.audioKey,
                            timestampsKey: result.timestampsKey,
                        });

                        // Progress: mark this reel's audio as done
                        await this.env.PROGRESS_KV.put(
                            `progress:${jobId}:audio:${index}`,
                            JSON.stringify({
                                durationSeconds: result.durationSeconds,
                                completedAt: new Date().toISOString(),
                            }),
                            { expirationTtl: PROGRESS_TTL },
                        );

                        return result;
                    },
                ),
            ),
        );

        // Progress: audio done, about to start video compositing
        await this.env.PROGRESS_KV.put(
            `progress:${jobId}`,
            JSON.stringify({
                phase: "compositing_video",
                totalPages: parsed.totalPages,
                totalReels: scripts.length,
                titles: scripts.map((s: ReelScript) => s.title),
                updatedAt: new Date().toISOString(),
            }),
            { expirationTtl: PROGRESS_TTL },
        );

        // Step 5: Composite video for each reel (parallel via Modal compositor)
        const videoResults = await Promise.all(
            audioResults.map((audio, index: number) =>
                step.do(
                    `composite-video-${index}`,
                    {
                        retries: {
                            limit: 2,
                            delay: "10 seconds",
                            backoff: "exponential",
                        },
                        timeout: "10 minutes",
                    },
                    async () => {
                        log("info", "composite-video: calling Modal compositor", {
                            jobId,
                            reelIndex: index,
                            audioKey: audio.audioKey,
                            timestampsKey: audio.timestampsKey,
                            durationSeconds: audio.durationSeconds,
                        });

                        const response = await fetch(
                            this.env.VIDEO_COMPOSITOR_URL,
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                },
                                body: JSON.stringify({
                                    api_key:
                                        this.env.VIDEO_COMPOSITOR_API_KEY,
                                    job_id: jobId,
                                    reel_index: index,
                                    audio_key: audio.audioKey,
                                    timestamps_key: audio.timestampsKey,
                                    duration_seconds: audio.durationSeconds,
                                }),
                            },
                        );

                        if (!response.ok) {
                            const errorBody = await response.text();
                            log(
                                "error",
                                "composite-video: Modal compositor failed",
                                {
                                    jobId,
                                    reelIndex: index,
                                    status: response.status,
                                    error: errorBody.slice(0, 500),
                                },
                            );
                            throw new Error(
                                `Compositor failed for reel ${index}: ${response.status} ${errorBody.slice(0, 200)}`,
                            );
                        }

                        const result = (await response.json()) as {
                            success: boolean;
                            videoKey: string;
                        };

                        log("info", "composite-video: complete", {
                            jobId,
                            reelIndex: index,
                            videoKey: result.videoKey,
                        });

                        // Progress: mark this reel's video as done
                        await this.env.PROGRESS_KV.put(
                            `progress:${jobId}:video:${index}`,
                            JSON.stringify({ completedAt: new Date().toISOString() }),
                            { expirationTtl: PROGRESS_TTL },
                        );

                        return result;
                    },
                ),
            ),
        );

        // Step 6: Cleanup intermediate files (audio + timestamps) from R2
        await step.do(
            "cleanup-intermediates",
            {
                retries: { limit: 3, delay: "5 seconds", backoff: "linear" },
                timeout: "30 seconds",
            },
            async () => {
                const keysToDelete = audioResults.flatMap((audio) => [
                    audio.audioKey,
                    audio.timestampsKey,
                ]);

                log("info", "cleanup-intermediates: deleting temp files from R2", {
                    jobId,
                    keys: keysToDelete,
                });

                try {
                    await this.env.BUCKET.delete(keysToDelete);
                    log("info", "cleanup-intermediates: temp files deleted", {
                        jobId,
                        deletedCount: keysToDelete.length,
                    });
                } catch (err) {
                    log("warn", "cleanup-intermediates: failed to delete temp files", {
                        jobId,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            },
        );

        // Progress: workflow complete
        await this.env.PROGRESS_KV.put(
            `progress:${jobId}`,
            JSON.stringify({
                phase: "complete",
                totalPages: parsed.totalPages,
                totalReels: scripts.length,
                titles: scripts.map((s: ReelScript) => s.title),
                updatedAt: new Date().toISOString(),
            }),
            { expirationTtl: PROGRESS_TTL },
        );

        log("info", "workflow complete", {
            jobId,
            totalPages: parsed.totalPages,
            totalReels: scripts.length,
            totalDurationSeconds: audioResults.reduce(
                (sum, r) => sum + r.durationSeconds,
                0,
            ),
        });

        return {
            jobId,
            totalPages: parsed.totalPages,
            scripts,
            audioResults,
            videoResults,
        };
    }
}
