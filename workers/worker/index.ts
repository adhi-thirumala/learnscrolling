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

// GET /api/status/:id -- job status (stub)
api.get("/api/status/:id", async (c) => {
  const jobId = c.req.param("id");
  log("info", "status check (stubbed)", { jobId });
  return c.json(
    {
      jobId,
      status: "not_implemented",
      message: "Job status tracking is not yet implemented.",
    },
    501,
  );
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
