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

                const textLengthBytes = new TextEncoder().encode(text).byteLength;

                log("info", "parse-pdf: extraction complete", {
                    jobId,
                    totalPages,
                    textLengthChars: text.length,
                    textLengthBytes,
                });

                // Store extracted text in R2 to avoid workflow step state limit (1 MiB).
                const textKey = `${jobId}/extracted-text.txt`;
                await this.env.BUCKET.put(textKey, text, {
                    httpMetadata: { contentType: "text/plain; charset=utf-8" },
                });
                log("info", "parse-pdf: extracted text stored in R2", {
                    jobId,
                    textKey,
                    textLengthBytes,
                });

                await this.env.BUCKET.delete(pdfKey);
                log("info", "parse-pdf: PDF deleted from R2", { jobId, pdfKey });

                return { totalPages, textKey, textLengthBytes } satisfies ParsedPdf;
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
                log("info", "generate-scripts: fetching extracted text from R2", {
                    jobId,
                    textKey: parsed.textKey,
                });

                const textObject = await this.env.BUCKET.get(parsed.textKey);
                if (!textObject) {
                    log("error", "generate-scripts: extracted text not found in R2", {
                        jobId,
                        textKey: parsed.textKey,
                    });
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
                log("info", "generate-scripts: extracted text deleted from R2", {
                    jobId,
                    textKey: parsed.textKey,
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
