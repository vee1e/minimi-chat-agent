import type { Config } from "../config.js";
import { createMockLLM } from "./mock.js";
import { OpenAICompatClient } from "./openai.js";
import type { LLMPair } from "./types.js";

export function createLLM(cfg: Config): LLMPair {
  if (cfg.mock) return createMockLLM();
  return {
    strong: new OpenAICompatClient(cfg.llm.baseUrl, cfg.llm.apiKey, cfg.llm.model),
    fast: new OpenAICompatClient(cfg.llmFast.baseUrl, cfg.llmFast.apiKey, cfg.llmFast.model),
  };
}
