import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

// Re-export the Workflow class so wrangler can discover it
export { ReelGenerationWorkflow } from "./workflow";

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

// --- App ---

const api = new Hono<{ Bindings: Env }>()
  .use("*", cors())
  .use("*", logger());

// POST /api/upload -- receive PDF, store in R2, trigger Workflow
api.post("/api/upload", async (c) => {
  const formData = await c.req.formData();
  const entry = formData.get("file");

  if (!entry || typeof entry === "string") {
    log("warn", "upload missing file");
    return c.json({ message: "No file provided" }, 400);
  }

  const file = entry as unknown as File;

  if (file.type !== "application/pdf") {
    log("warn", "upload rejected: wrong file type", {
      type: file.type,
      name: file.name,
    });
    return c.json({ message: "Only PDF files are accepted" }, 400);
  }

  const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
  if (file.size > MAX_FILE_SIZE) {
    log("warn", "upload rejected: file too large", {
      size: file.size,
      name: file.name,
      maxSize: MAX_FILE_SIZE,
    });
    return c.json({ message: "File exceeds the 10 MB size limit" }, 413);
  }

  const jobId = crypto.randomUUID();
  const pdfKey = `pdfs/${jobId}.pdf`;

  log("info", "uploading PDF to R2", { jobId, pdfKey, fileSize: file.size });
  await c.env.BUCKET.put(pdfKey, file.stream(), {
    httpMetadata: { contentType: "application/pdf" },
    customMetadata: { originalName: file.name, jobId },
  });
  log("info", "PDF uploaded to R2", { jobId, pdfKey });

  log("info", "triggering workflow", { jobId, pdfKey });
  const instance = await c.env.REEL_WORKFLOW.create({
    id: jobId,
    params: { jobId, pdfKey },
  });
  log("info", "workflow triggered", { jobId, instanceId: instance.id });

  return c.json({
    jobId,
    message: `PDF "${file.name}" received (${(file.size / 1024).toFixed(1)} KB). Processing started.`,
  });
});

// GET /api/status/:id -- job status via Workflow API + KV progress
api.get("/api/status/:id", async (c) => {
  const jobId = c.req.param("id");
  const startTime = Date.now();
  log("info", "status check", { jobId });

  try {
    const instance = await c.env.REEL_WORKFLOW.get(jobId);
    const instanceStatus = await instance.status();

    log("info", "status check: got workflow status", {
      jobId,
      status: instanceStatus.status,
      durationMs: Date.now() - startTime,
    });

    // Read granular progress from KV
    const progressJson = await c.env.PROGRESS_KV.get(`progress:${jobId}`);
    const progress = progressJson
      ? (JSON.parse(progressJson) as {
          phase: string;
          totalPages?: number;
          totalReels?: number;
          titles?: string[];
        })
      : null;

    // Count per-reel completions via KV list (only when relevant)
    let audioCompleted = 0;
    let videoCompleted = 0;

    if (progress?.totalReels) {
      const phase = progress.phase;
      if (
        phase === "generating_audio" ||
        phase === "compositing_video" ||
        phase === "complete"
      ) {
        const audioKeys = await c.env.PROGRESS_KV.list({
          prefix: `progress:${jobId}:audio:`,
        });
        audioCompleted = audioKeys.keys.length;
      }
      if (phase === "compositing_video" || phase === "complete") {
        const videoKeys = await c.env.PROGRESS_KV.list({
          prefix: `progress:${jobId}:video:`,
        });
        videoCompleted = videoKeys.keys.length;
      }
    }

    // Build response based on workflow status
    const response: {
      jobId: string;
      status: string;
      progress: {
        phase: string;
        totalPages?: number;
        totalReels?: number;
        titles?: string[];
        audioCompleted: number;
        videoCompleted: number;
      } | null;
      reels?: { index: number; url: string }[];
      error?: string;
    } = {
      jobId,
      status: instanceStatus.status,
      progress: progress
        ? {
            phase: progress.phase,
            totalPages: progress.totalPages,
            totalReels: progress.totalReels,
            titles: progress.titles,
            audioCompleted,
            videoCompleted,
          }
        : null,
    };

    // When workflow is complete, extract video keys from the output and
    // return URLs that point to our /api/reels proxy endpoint.
    if (instanceStatus.status === "complete" && instanceStatus.output) {
      const output = instanceStatus.output as {
        videoResults?: { videoKey: string }[];
      };
      if (output.videoResults && Array.isArray(output.videoResults)) {
        response.reels = output.videoResults.map(
          (v: { videoKey: string }, i: number) => ({
            index: i,
            url: `/api/reels/${jobId}/${i}`,
          }),
        );
        log("info", "status check: returning reel URLs", {
          jobId,
          reelCount: response.reels.length,
        });
      }
    }

    if (instanceStatus.status === "errored") {
      response.error =
        instanceStatus.error instanceof Error
          ? instanceStatus.error.message
          : String(instanceStatus.error ?? "Unknown error");
      log("warn", "status check: workflow errored", {
        jobId,
        error: response.error,
      });
    }

    log("info", "status check: response", {
      jobId,
      status: instanceStatus.status,
      phase: progress?.phase ?? "none",
      audioCompleted,
      videoCompleted,
      durationMs: Date.now() - startTime,
    });

    return c.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log("error", "status check: failed to get workflow instance", {
      jobId,
      error: message,
    });
    return c.json(
      { jobId, status: "not_found", error: "Job not found" },
      404,
    );
  }
});

// GET /api/reels/:jobId/:index -- proxy video file from R2
api.get("/api/reels/:jobId/:index", async (c) => {
  const jobId = c.req.param("jobId");
  const index = c.req.param("index");
  const startTime = Date.now();

  log("info", "reel fetch", { jobId, reelIndex: index });

  const reelKey = `reels/${jobId}/${index}.mp4`;
  const object = await c.env.BUCKET.get(reelKey);

  if (!object) {
    log("warn", "reel fetch: not found in R2", { jobId, reelIndex: index, reelKey });
    return c.json({ error: "Reel not found" }, 404);
  }

  log("info", "reel fetch: streaming from R2", {
    jobId,
    reelIndex: index,
    reelKey,
    sizeBytes: object.size,
    durationMs: Date.now() - startTime,
  });

  return new Response(object.body, {
    headers: {
      "Content-Type": "video/mp4",
      "Content-Length": String(object.size),
      "Cache-Control": "public, max-age=86400",
      "Content-Disposition": `inline; filename="reel-${jobId}-${index}.mp4"`,
    },
  });
});

// --- Entrypoint ---

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return api.fetch(request, env, ctx);
    }

    // Everything else -- serve static assets (React SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
