import { GoogleGenAI } from "@google/genai";

export interface EvaluationResult {
  isRelevant: boolean;
  score: number;
  reasoning: string;
}

export interface PostContext {
  uri: string;
  authorHandle: string;
  text: string;
}

const SYSTEM_INSTRUCTIONS = `You are a relevance filter for an open social web developer feed. Your job is to evaluate social media posts and determine whether they are worth surfacing to a software engineer who is active in the AT Protocol (atproto) and ActivityPub developer ecosystems and works at Google.

The engineer wants to:
- Stay current on technical developments across atproto, ActivityPub, the fediverse, and the broader open/decentralized social web.
- Find posts worth reading for learning or situational awareness.
- Find posts with a natural opening to reply — such as technical questions, proposals, pain points, or discussions — where a knowledgeable response would be valuable and help build their reputation in the community.

Evaluate the post based on these criteria:

HIGH RELEVANCE (score 80-100):
- Someone asking a technical question about atproto, ActivityPub, PDS hosting, Lexicon design, feed generators, federation, or related protocol internals.
- Proposals, RFCs, or design discussions for new protocol features or changes.
- Posts discussing interoperability between atproto, ActivityPub, Nostr, or other decentralized protocols.
- Developer experience pain points, bug reports, or frustrations with protocol tooling.
- Posts about Google's involvement with the open social web, social interoperability, or related standards work.
- Any post where a thoughtful technical reply would be especially impactful.

MEDIUM RELEVANCE (score 50-79):
- Announcements of new tools, libraries, bots, or projects built on atproto or ActivityPub.
- Technical blog posts, tutorials, or documentation being shared.
- General developer discussion about federation architecture, self-hosting, or decentralized identity.
- Posts from developers sharing what they are building, with enough technical detail to be interesting.

LOW RELEVANCE (score 20-49):
- Tangential ecosystem commentary with little technical substance.
- Posts that mention relevant keywords but are primarily about non-technical topics (e.g., moderation policy debates, social commentary).
- Simple project announcements with no technical depth.

IRRELEVANT (score 0-19, mark isRelevant = false):
- Casual "I love Bluesky" or "I joined Mastodon" sentiment with no technical content.
- Memes, jokes, or shitposts that happen to mention a relevant keyword.
- Pure news resharing or link drops with no added commentary.
- Marketing, self-promotion spam, or engagement bait.
- Culture war or political content that tangentially references decentralized social media.

IMPORTANT RULES:
- Evaluate the post on its own content merit. Do not factor in who the author is.
- If parent or quoted post context is provided, use it to better understand the conversation. A reply that seems vague on its own may be highly relevant in the context of a technical thread.
- A post routed via a like or repost from someone the engineer follows has already passed a social signal check; still evaluate it on content merit but recognize it reached the pipeline through trusted network activity.
- When scoring, give higher weight to posts where there is a clear opportunity to respond and add value versus posts that are just interesting to read.
- Be concise in your reasoning (1-2 sentences).`;

export function constructUserPrompt(
  postText: string,
  parentContext: PostContext | null,
  quotedContext: PostContext | null,
  matchRules: string[]
): string {
  let prompt = `Evaluate this post for relevance:

--- POST ---
${postText}
--- END POST ---`;

  if (parentContext) {
    prompt += `\n\n--- PARENT POST (this post is a reply to) ---\nAuthor: ${parentContext.authorHandle}\n${parentContext.text}\n--- END PARENT POST ---`;
  }

  if (quotedContext) {
    prompt += `\n\n--- QUOTED POST (this post is quoting) ---\nAuthor: ${quotedContext.authorHandle}\n${quotedContext.text}\n--- END QUOTED POST ---`;
  }

  prompt += `\n\nCapture path: ${matchRules.join(", ")}`;
  return prompt;
}

let aiClient: GoogleGenAI | null = null;
let mockEvaluator: (
  (
    text: string,
    authorHandle: string,
    parentContext: PostContext | null,
    quotedContext: PostContext | null,
    matchRules: string[]
  ) => Promise<EvaluationResult>
) | null = null;

export function setMockEvaluator(fn: typeof mockEvaluator) {
  mockEvaluator = fn;
}

function getAiClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY is not defined in the environment.");
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

export async function evaluatePost(
  text: string,
  authorHandle: string,
  parentContext: PostContext | null = null,
  quotedContext: PostContext | null = null,
  matchRules: string[] = []
): Promise<EvaluationResult> {
  if (mockEvaluator) {
    return mockEvaluator(text, authorHandle, parentContext, quotedContext, matchRules);
  }
  const ai = getAiClient();

  const prompt = constructUserPrompt(text, parentContext, quotedContext, matchRules);

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTIONS,
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            isRelevant: { type: "BOOLEAN" },
            score: { type: "INTEGER" },
            reasoning: { type: "STRING" }
          },
          required: ["isRelevant", "score", "reasoning"]
        }
      }
    });

    const textResult = response.text;
    if (!textResult) {
      throw new Error("Empty response from Gemini model.");
    }

    const result = JSON.parse(textResult) as EvaluationResult;
    return {
      isRelevant: !!result.isRelevant,
      score: typeof result.score === "number" ? result.score : 0,
      reasoning: result.reasoning || ""
    };
  } catch (error: any) {
    console.error("Gemini evaluation error:", error);
    return {
      isRelevant: false,
      score: 0,
      reasoning: `Failed to evaluate post via Gemini: ${error.message || error}`
    };
  }
}
