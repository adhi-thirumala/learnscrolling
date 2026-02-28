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
    text: string;
    textLengthBytes: number;
}

// --- Helpers ---

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

                const document = await getDocumentProxy(new Uint8Array(pdfBytes));
                const { totalPages, text } = await extractText(document, {
                    mergePages: true,
                });

                // Workflow step state limit is 1 MiB. Check extracted text fits.
                const textLengthBytes = new TextEncoder().encode(text).byteLength;
                if (textLengthBytes > 900_000) {
                    log("warn", "parse-pdf: extracted text is very large", {
                        jobId,
                        textLengthBytes,
                        totalPages,
                    });
                }

                log("info", "parse-pdf: extraction complete", {
                    jobId,
                    totalPages,
                    textLengthChars: text.length,
                    textLengthBytes,
                });

                await this.env.BUCKET.delete(pdfKey);
                log("info", "parse-pdf: PDF deleted from R2", { jobId, pdfKey });

                return { totalPages, text, textLengthBytes } satisfies ParsedPdf;
            },
        );

        // Step 2: Send full text to LLM, get back reel scripts
        const scripts = await step.do(
            "generate-scripts",
            {
                retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
                timeout: "5 minutes",
            },
            async () => {
                log("info", "generate-scripts: calling LLM", {
                    jobId,
                    inputLengthChars: parsed.text.length,
                    totalPages: parsed.totalPages,
                });

                const reels = await generateScripts(parsed.text, {
                    apiUrl: this.env.LLM_API_URL,
                    apiKey: this.env.LLM_API_KEY,
                    model: this.env.LLM_MODEL,
                });

                log("info", "generate-scripts: complete", {
                    jobId,
                    totalReels: reels.length,
                });

                return reels;
            },
        );

        log("info", "workflow complete", {
            jobId,
            totalPages: parsed.totalPages,
            totalReels: scripts.length,
        });

        return { jobId, totalPages: parsed.totalPages, scripts };
    }
}
