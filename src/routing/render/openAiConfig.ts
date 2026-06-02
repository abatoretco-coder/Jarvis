export type RenderOpenAiConfig = {
  temperature: number;
  maxTokens: number;
};

export const RENDER_DOMAIN_REPHRASE_OPENAI_CONFIG: RenderOpenAiConfig = {
  temperature: 0.1,
  maxTokens: 180,
};
