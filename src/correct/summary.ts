/** Bedrock Converse summary rewrite; OpenAI fallback if AWS is not configured. */
import { env } from "../config.js";
import type { TokenUsage } from "../types.js";
import { SUMMARY_SYSTEM } from "./prompts.js";
import { withTimeout } from "../util.js";

export const bedrockConfigured = () => Boolean(env.BEDROCK_MODEL_ID && (env.AWS_ACCESS_KEY_ID || env.AWS_PROFILE || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || process.env.AWS_WEB_IDENTITY_TOKEN_FILE || process.env.AWS_EC2_METADATA_DISABLED === "false" || process.env.AWS_ROLE_ARN));

export async function bedrockSummary(claimTexts: string[]): Promise<{ text: string; model: string; usage: TokenUsage }> {
  const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
  const client = new BedrockRuntimeClient({ region: env.AWS_REGION });
  const started = Date.now();
  const r = await withTimeout(
    client.send(
      new ConverseCommand({
        modelId: env.BEDROCK_MODEL_ID,
        system: [{ text: SUMMARY_SYSTEM }],
        messages: [{ role: "user", content: [{ text: `Active claims:\n${claimTexts.map((t) => "- " + t).join("\n")}\n\nWrite the summary.` }] }],
        inferenceConfig: { maxTokens: 300, temperature: 0.2 },
      }),
    ),
    30000,
    "bedrock",
  );
  const text = r.output?.message?.content?.map((c) => c.text ?? "").join("").trim() ?? "";
  const ms = Date.now() - started;
  return { text, model: env.BEDROCK_MODEL_ID, usage: { step: "summary", provider: "bedrock", model: env.BEDROCK_MODEL_ID, prompt_tokens: r.usage?.inputTokens ?? 0, completion_tokens: r.usage?.outputTokens ?? 0, ms } };
}

/** Returns the summary and who wrote it. If Bedrock is not configured or fails, keep the OpenAI merge summary. */
export async function rewriteSummary(claimTexts: string[], openaiSummary: string): Promise<{ text: string; by: string; usage: TokenUsage[] }> {
  if (!bedrockConfigured() || !claimTexts.length) return { text: openaiSummary, by: "openai", usage: [] };
  try {
    const r = await bedrockSummary(claimTexts);
    if (r.text.length > 20) return { text: r.text, by: "bedrock", usage: [r.usage] };
    return { text: openaiSummary, by: "openai", usage: [r.usage] };
  } catch (e) {
    return { text: openaiSummary, by: `openai (bedrock failed: ${(e as Error).message.slice(0, 80)})`, usage: [] };
  }
}
