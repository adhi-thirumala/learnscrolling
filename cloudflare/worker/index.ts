interface Env {
  ASSETS: Fetcher;
}

function log(level: "info" | "warn" | "error", msg: string, data?: Record<string, unknown>) {
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const start = Date.now();

    // API routes
    if (url.pathname.startsWith("/api/")) {
      log("info", "api request", {
        method: request.method,
        path: url.pathname,
      });

      const response = await handleApi(request, url);

      log("info", "api response", {
        method: request.method,
        path: url.pathname,
        status: response.status,
        durationMs: Date.now() - start,
      });

      return response;
    }

    // Everything else — serve static assets (React SPA)
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApi(
  request: Request,
  url: URL,
): Promise<Response> {
  // CORS headers for local dev
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // POST /api/upload — receive PDF, forward to Modal (stubbed)
  if (url.pathname === "/api/upload" && request.method === "POST") {
    try {
      const formData = await request.formData();
      const entry = formData.get("file");

      if (!entry || typeof entry === "string") {
        log("warn", "upload missing file");
        return Response.json(
          { message: "No file provided" },
          { status: 400, headers: corsHeaders },
        );
      }

      const file = entry as unknown as File;

      if (file.type !== "application/pdf") {
        log("warn", "upload rejected: wrong file type", { type: file.type, name: file.name });
        return Response.json(
          { message: "Only PDF files are accepted" },
          { status: 400, headers: corsHeaders },
        );
      }

      // TODO: Forward the PDF to Modal for processing
      // const modalResponse = await fetch("https://your-modal-endpoint.modal.run/process", {
      //   method: "POST",
      //   body: formData,
      // });

      const jobId = crypto.randomUUID();

      log("info", "upload accepted", {
        jobId,
        fileName: file.name,
        fileSize: file.size,
      });

      return Response.json(
        {
          jobId,
          message: `PDF "${file.name}" received (${(file.size / 1024).toFixed(1)} KB). Processing will begin shortly.`,
        },
        { headers: corsHeaders },
      );
    } catch (err) {
      log("error", "upload failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return Response.json(
        { message: "Failed to process upload" },
        { status: 500, headers: corsHeaders },
      );
    }
  }

  // GET /api/status/:id — check job status (stubbed)
  if (url.pathname.startsWith("/api/status/") && request.method === "GET") {
    const jobId = url.pathname.split("/api/status/")[1];
    log("info", "status check", { jobId });
    return Response.json(
      {
        jobId,
        status: "processing",
        message: "Your reel is being generated...",
      },
      { headers: corsHeaders },
    );
  }

  log("warn", "route not found", { path: url.pathname, method: request.method });
  return Response.json(
    { message: "Not found" },
    { status: 404, headers: corsHeaders },
  );
}
