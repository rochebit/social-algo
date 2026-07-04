import { GoogleGenAI } from "@google/genai";

export interface EvaluationResult {
  isRelevant: boolean;
  score: number;
  reasoning: string;
}

const SYSTEM_INSTRUCTIONS = `
You are an AI assistant filtering social media posts for developer community content related to the AT Protocol (atproto) and Bluesky development.

Evaluate if the post is relevant to developers, builders, or researchers working on AT Protocol, Bluesky, PDS, AppView, Lexicons, XRPC, federation, self-hosting, or developer tools.

Output a JSON object matching this schema:
{
  "isRelevant": boolean,
  "score": number (0 to 100),
  "reasoning": string (brief explanation of why it is relevant or irrelevant)
}
`;

let aiClient: GoogleGenAI | null = null;
let mockEvaluator: ((text: string, authorHandle: string) => Promise<EvaluationResult>) | null = null;

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

export async function evaluatePost(text: string, authorHandle: string): Promise<EvaluationResult> {
  if (mockEvaluator) {
    return mockEvaluator(text, authorHandle);
  }
  const ai = getAiClient();

  const prompt = `Post Author: @${authorHandle}\nPost Text: ${JSON.stringify(text)}`;

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
