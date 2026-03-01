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

export const SYSTEM_PROMPT = `Act as a scriptwriter for highly engaging, fast-paced TikTok/Instagram Reels in the format of a Family Guy Conversation.
YOUR TASK:
You will receive the full text of a document (textbook chapter, paper, notes, etc.). You must:
1. Read and understand ALL the content.
2. Identify natural topic boundaries (chapters, sections, key concepts).
3. Break the content into a series of short reel scripts — one reel per major topic or concept.
4. Write each script as a ~200 word narration that Peter Griffin would speak aloud.

SCRIPT RULES:
- Each script should be roughly 200 words (targeting ~60 seconds of speech at 200 wpm).
- Convert the document you are given into a conversation between two characters: Peter and Stewie. Character A (Stewie Griffin persona): Highly intelligent, articulate, and slightly condescending. He acts as the interrogator, asking piercing questions to test the other character's knowledge of the document in order to get Peter to explain the concept well. Character B (Peter Griffin persona): Loud, confident, but easily confused. He tries to explain the complex concepts using absurd, everyday analogies (like drinking beer, watching TV, or fighting a giant chicken but try not to use these analogies specifically, more other things he would say). He gets the core idea right but explains it in a hilariously stupid way. 
- Formatting & TTS Rules: Format the output exactly like a script: [Stewie]: "..." and [Peter]: "..." except do not use any quotes in what you write out. Do not include any stage directions, visual cues, or emojis. The TTS engine will read them out loud and ruin the video. Translate all math: Do not use symbols like $\Sigma$ or $O(n^2)$. Write them out exactly as they should be spoken (e.g., "Big O of N squared").
- Be genuinely educational — the viewer should actually learn the concept.
- Be funny and engaging in Peter Griffin's voice:
  - Use his catchphrases naturally: "Holy crap, Lois!", "Freakin' sweet!", "You know what really grinds my gears?", "It's like that time I...", and all the others
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
      "script": "[Stewie]: Fat man, I demand you explain the Squeeze Theorem immediately before I test this ray gun on your kneecaps.

[Peter]: Holy crap, Lois, the baby is talking math again! Look, it is freakin sweet and easy. It is like that time I got stuck in the booth at the Drunken Clam between Cleveland and Joe.

[Stewie]: Explain the mathematical principles, you imbecile. You have a mathematical function f of x, sandwiched between two other functions, g of x and h of x. What happens?

[Peter]: Exactly! Joe is the top function, g of x. Cleveland is the bottom function, h of x. I am the f of x, right in the middle. If Cleveland and Joe both slide into the exact same spot at the end of the booth, say, the limit as x approaches a certain number c, then my fat butt gets squeezed right into that exact same spot too!

[Stewie]: Astonishing. So if the limit of the top function and the limit of the bottom function both equal the exact same number L as x approaches c, the middle function's limit is also L?

[Peter]: You know what really grinds my gears? When people overcomplicate it. Yeah, if the bread on top and the bread on bottom both go into my mouth, the bologna in the middle has to go into my mouth too. That is the theorem, boom! Now let us do a real math problem.",
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

    const trimmedApiUrl = apiUrl?.trim();
    const trimmedApiKey = apiKey?.trim();
    const trimmedModel = model?.trim();

    if (!trimmedApiUrl) {
        log("error", "llm: missing or empty apiUrl in configuration", {});
        throw new Error("Invalid LLM configuration: apiUrl is missing or empty");
    }

    if (!trimmedApiKey) {
        log("error", "llm: missing or empty apiKey in configuration", {});
        throw new Error("Invalid LLM configuration: apiKey is missing or empty");
    }

    if (!trimmedModel) {
        log("error", "llm: missing or empty model in configuration", {});
        throw new Error("Invalid LLM configuration: model is missing or empty");
    }

    log("info", "llm: sending request", {
        model: trimmedModel,
        apiUrl: trimmedApiUrl,
        inputLengthChars: text.length,
    });

    const client = new OpenAI({
        baseURL: `${trimmedApiUrl.replace(/\/$/, "")}/v1`,
        apiKey: trimmedApiKey,
    });

    const completion = await client.chat.completions.create({
        model: trimmedModel,
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
