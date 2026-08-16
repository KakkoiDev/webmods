import type { AnnotationChatContext } from "../plugins/chat";

/**
 * Default serialization of the annotator's structured context into a system
 * prompt. This lives in the provider layer, not core — a provider is free to
 * ignore it and format the context however its model prefers.
 */
export const SYSTEM_PREAMBLE =
  "You are helping a user understand and annotate a web page. " +
  "Answer from the page context below when it is relevant, and say so plainly when it is not. " +
  "Be concise: lead with the answer, then supporting detail.";

export function buildSystemPrompt(context: AnnotationChatContext, preamble: string = SYSTEM_PREAMBLE): string {
  const parts = [preamble, "", "# Page", `Title: ${context.page.title ?? "(untitled)"}`, `URL: ${context.page.normalizedUrl}`];

  if (context.targetText) {
    parts.push("", "# Annotated block", "```", context.targetText, "```");
  }
  if (context.surroundingText) {
    parts.push("", "# Nearby text", "```", context.surroundingText, "```");
  }
  if (context.annotation) {
    parts.push("", "# The user's note on that block", "```", context.annotation.body.text, "```");
  }
  if (context.pageAnnotations?.length) {
    parts.push("", `# All ${context.pageAnnotations.length} note(s) on this page`);
    context.pageAnnotations.forEach((a, i) => {
      const quote = a.anchor.textQuote?.exact;
      parts.push("", `## Note ${i + 1}`);
      if (quote) parts.push(`Anchored to: ${quote.slice(0, 200)}`);
      parts.push("```", a.body.text, "```");
    });
  }
  if (context.pageText) {
    parts.push("", "# Page text", "```", context.pageText, "```");
  }
  return parts.join("\n");
}
