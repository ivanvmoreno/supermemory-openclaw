// ---------------------------------------------------------------------------
// LLM-powered fact extraction via OpenClaw subagent
// ---------------------------------------------------------------------------

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type SubagentRuntime = {
  run: (params: {
    sessionKey: string;
    message: string;
    extraSystemPrompt?: string;
    deliver?: boolean;
    idempotencyKey?: string;
  }) => Promise<{ runId: string }>;
  waitForRun: (params: {
    runId: string;
    timeoutMs?: number;
  }) => Promise<{ status: string; error?: string }>;
  getSessionMessages: (params: {
    sessionKey: string;
    limit?: number;
  }) => Promise<{ messages: unknown[] }>;
  deleteSession: (params: {
    sessionKey: string;
    deleteTranscript?: boolean;
  }) => Promise<void>;
};

const EXTRACT_SESSION_KEY = "__supermemory-fact-extract";

const EXTRACTION_SYSTEM_PROMPT = `You are a fact extraction engine. Extract discrete, entity-centric facts from the conversation below.

Rules:
- Output one fact per line, nothing else
- Entity-centric phrasing: "User prefers TypeScript" not "they said they like TS"
- Atomic: one fact per line, never compound sentences
- Skip greetings, filler, questions with no factual content, code snippets, error messages
- Preserve temporal markers: "User has an exam tomorrow", "Meeting on January 15"
- Use "User" for the human speaker's facts
- Use the person/entity name when the fact is about someone else
- For preferences: "User prefers X" or "User likes X"
- For decisions: "User decided to use X" or "User switched to X"
- For identity: "User works at X" or "User's name is X"
- For projects: "User is working on X" or "Project X uses Y"
- Maximum 10 facts per extraction
- If nothing worth remembering, output exactly: NONE`;

export async function extractFacts(
  turnText: string,
  subagent: SubagentRuntime,
  log: Logger,
): Promise<string[]> {
  if (!turnText || turnText.trim().length < 15) return [];

  try {
    // Clean up any previous extraction session
    try {
      await subagent.deleteSession({
        sessionKey: EXTRACT_SESSION_KEY,
        deleteTranscript: true,
      });
    } catch {
      // session may not exist yet
    }

    // Run the extraction subagent
    const idempotencyKey = `smex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const { runId } = await subagent.run({
      sessionKey: EXTRACT_SESSION_KEY,
      message: turnText,
      extraSystemPrompt: EXTRACTION_SYSTEM_PROMPT,
      deliver: false,
      idempotencyKey,
    });

    // Wait for completion (30s timeout — local models may need warmup time)
    const result = await subagent.waitForRun({
      runId,
      timeoutMs: 30_000,
    });

    if (result.status !== "ok") {
      log.warn(`memory-supermemory: fact extraction failed: ${result.error ?? result.status}`);
      return [];
    }

    // Read the assistant's response
    const { messages } = await subagent.getSessionMessages({
      sessionKey: EXTRACT_SESSION_KEY,
      limit: 5,
    });

    // Find the last assistant message
    let extractedText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && typeof msg === "object" && (msg as Record<string, unknown>).role === "assistant") {
        const content = (msg as Record<string, unknown>).content;
        if (typeof content === "string") {
          extractedText = content;
          break;
        }
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block &&
              typeof block === "object" &&
              (block as Record<string, unknown>).type === "text" &&
              typeof (block as Record<string, unknown>).text === "string"
            ) {
              extractedText = (block as Record<string, unknown>).text as string;
              break;
            }
          }
          if (extractedText) break;
        }
      }
    }

    // Clean up session
    try {
      await subagent.deleteSession({
        sessionKey: EXTRACT_SESSION_KEY,
        deleteTranscript: true,
      });
    } catch {
      // best-effort cleanup
    }

    if (!extractedText || extractedText.trim() === "NONE") return [];

    // Parse: one fact per line, filter empties and noise
    const facts = extractedText
      .split("\n")
      .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
      .filter((line) => line.length >= 10 && line.length <= 500)
      .filter((line) => line !== "NONE")
      .filter((line) => !/^(here|these|the following|i found|extracted|facts?:)/i.test(line));

    if (facts.length > 0) {
      log.info(`memory-supermemory: extracted ${facts.length} facts from conversation turn`);
    }

    return facts.slice(0, 10);
  } catch (err) {
    log.warn(`memory-supermemory: fact extraction error: ${String(err)}`);
    return [];
  }
}
