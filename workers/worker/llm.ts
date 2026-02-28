/**
 * LLM Script Generation
 *
 * ============================================================
 * SPEC FOR LLM ENDPOINT IMPLEMENTER
 * ============================================================
 *
 * This module calls an OpenAI-compatible chat completions API
 * to generate "brainrot" reel scripts from extracted PDF text.
 *
 * ENDPOINT:
 *   POST {LLM_API_URL}/v1/chat/completions
 *
 * REQUEST:
 *   Standard OpenAI chat completions request. Uses the official
 *   `openai` SDK, so your endpoint just needs to be compatible
 *   with the OpenAI API spec.
 *
 * EXPECTED JSON OUTPUT (in assistant message content):
 *   {
 *     "reels": [
 *       {
 *         "index": 0,
 *         "title": "Newton's First Law",
 *         "script": "Holy crap, Lois! So basically objects just keep doing ...",
 *         "sourceSection": "Chapter 3: Laws of Motion, pages 45-52"
 *       },
 *       ...
 *     ]
 *   }
 *
 * FIELD DESCRIPTIONS:
 *   - index:         0-based reel number, sequential
 *   - title:         Short, catchy title for the reel (max ~8 words)
 *   - script:        The narration text Peter Griffin will speak.
 *                    Target ~150 words per script (~60 seconds at 150 wpm).
 *                    Written in Peter Griffin's voice. Funny, educational, brainrot style.
 *                    NO stage directions, NO speaker labels, ONLY spoken words.
 *   - sourceSection: Which part of the source document this reel covers.
 *                    For traceability. Free-form text (e.g. "Chapter 2, Section 2.3").
 *
 * NOTES:
 *   - The full PDF text can be very large (50K+ words / 70K+ tokens).
 *     The model MUST have a context window large enough to handle this.
 *   - The number of reels is determined by the LLM based on how much
 *     content is in the document. Typical range: 3-20 reels.
 *   - Temperature 0.9 for creative/funny output.
 *   - response_format uses json_schema with strict schema enforcement.
 *     vLLM will use guided decoding (outlines/xgrammar) to guarantee
 *     the output conforms to the schema at the token level.
 *
 * ============================================================
 */

import OpenAI from "openai";

// --- Types ---

export interface ReelScript {
  /** 0-based reel number */
  index: number;
  /** Short catchy title for this reel */
  title: string;
  /** The narration text (~150 words, ~60 seconds of speech) */
  script: string;
  /** Which part of the source document this covers */
  sourceSection: string;
}

export interface LLMResponse {
  reels: ReelScript[];
}

export interface LLMConfig {
  apiUrl: string;
  apiKey: string;
  model: string;
}

// --- System Prompt ---

export const SYSTEM_PROMPT = `You are Peter Griffin from Family Guy, and you've been hired to make educational TikTok/Instagram Reels that explain textbook content to students.

YOUR TASK:
You will receive the full text of a document (textbook chapter, paper, notes, etc.). You must:
1. Read and understand ALL the content.
2. Identify natural topic boundaries (chapters, sections, key concepts).
3. Break the content into a series of short reel scripts — one reel per major topic or concept.
4. Write each script as a ~150 word narration that Peter Griffin would speak aloud.

SCRIPT RULES:
- Each script should be roughly 150 words (targeting ~60 seconds of speech at 150 wpm).
- Write ONLY the spoken words. No stage directions, no "[laughs]", no "(pauses)", no speaker labels.
- Be genuinely educational — the viewer should actually learn the concept.
- Be funny and engaging in Peter Griffin's voice:
  - Use his catchphrases naturally: "Holy crap, Lois!", "Freakin' sweet!", "You know what really grinds my gears?", "It's like that time I..."
  - Use absurd analogies and Family Guy-style tangents to explain concepts.
  - Relate complex ideas to everyday/ridiculous scenarios Peter would understand.
  - Keep the humor but NEVER sacrifice accuracy of the educational content.
- Start each script with a hook that grabs attention in the first 5 seconds.
- End each script with a clear takeaway or transition.

CONTENT RULES:
- Cover ALL the important content from the document. Don't skip sections.
- Each reel should be self-contained — a viewer should understand it without seeing the others.
- Order the reels logically (following the document's structure).
- If a topic is too complex for one reel, split it into multiple reels.
- If a topic is too small for a full reel, combine it with related content.

OUTPUT FORMAT:
Respond with a JSON object containing a "reels" array. Each reel has:
- "index": 0-based sequential number
- "title": Short catchy title (max ~8 words)
- "script": The full narration text (~150 words)
- "sourceSection": Which part of the source document this covers

Example output structure:
{
  "reels": [
    {
      "index": 0,
      "title": "What Even Is Thermodynamics",
      "script": "Holy crap, Lois! Okay so thermodynamics — big word, I know — it's basically the study of heat and energy and how they move around. Think of it like this: you know when I eat a whole bucket of chicken and then I'm sweating on the couch? That's thermodynamics, baby! The heat from my body is trying to reach equilibrium with the room. The first law says energy can't be created or destroyed, it just changes form. So that chicken? It became pure Griffin energy. Which I then used to... sit there. But the energy didn't disappear! It became heat. Freakin' sweet, right? This is literally how engines, refrigerators, and the entire universe works. Same rules, whether it's a star exploding or me microwaving leftover meatloaf at 2 AM.",
      "sourceSection": "Chapter 1: Introduction to Thermodynamics"
    }
  ]
}`;

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

// --- JSON Schema for structured output ---
// This schema is sent to the LLM via response_format.json_schema.
// vLLM uses guided decoding to enforce this at the token level --
// the model literally cannot produce output that doesn't match.

const REEL_SCRIPTS_SCHEMA = {
  type: "object",
  properties: {
    reels: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: {
            type: "integer",
            description: "0-based sequential reel number",
          },
          title: {
            type: "string",
            description: "Short catchy title for this reel (max ~8 words)",
          },
          script: {
            type: "string",
            description:
              "The narration text (~150 words, ~60 seconds of speech). ONLY spoken words, no stage directions.",
          },
          sourceSection: {
            type: "string",
            description:
              'Which part of the source document this covers (e.g. "Chapter 2, Section 2.3")',
          },
        },
        required: ["index", "title", "script", "sourceSection"],
        additionalProperties: false,
      },
    },
  },
  required: ["reels"],
  additionalProperties: false,
} as const;

// --- LLM Client ---

export async function generateScripts(
  text: string,
  config: LLMConfig,
): Promise<ReelScript[]> {
  const { apiUrl, apiKey, model } = config;

  log("info", "llm: sending request", {
    model,
    apiUrl,
    inputLengthChars: text.length,
  });

  const client = new OpenAI({
    baseURL: `${apiUrl.replace(/\/$/, "")}/v1`,
    apiKey,
  });

  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: text },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "reel_scripts",
        strict: true,
        schema: REEL_SCRIPTS_SCHEMA,
      },
    },
    temperature: 0.9,
  });

  const content = completion.choices?.[0]?.message?.content;
  if (!content) {
    log("error", "llm: empty response", {
      finishReason: completion.choices?.[0]?.finish_reason,
      usage: completion.usage as unknown as Record<string, unknown>,
    });
    throw new Error("LLM returned an empty response");
  }

  // Schema enforcement guarantees valid JSON + correct shape,
  // but we still parse defensively in case of edge cases.
  let parsed: LLMResponse;
  try {
    parsed = JSON.parse(content) as LLMResponse;
  } catch {
    log("error", "llm: invalid JSON despite schema enforcement", {
      content: content.slice(0, 500),
    });
    throw new Error("LLM response was not valid JSON");
  }

  if (!Array.isArray(parsed.reels) || parsed.reels.length === 0) {
    log("error", "llm: no reels in response", {
      parsed: JSON.stringify(parsed).slice(0, 500),
    });
    throw new Error("LLM response contained no reels");
  }

  log("info", "llm: scripts generated", {
    totalReels: parsed.reels.length,
    avgScriptLength: Math.round(
      parsed.reels.reduce((sum, r) => sum + r.script.length, 0) /
        parsed.reels.length,
    ),
    usage: completion.usage as unknown as Record<string, unknown>,
  });

  return parsed.reels;
}
