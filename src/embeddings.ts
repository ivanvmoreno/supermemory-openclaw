import { createHash } from "node:crypto";
import type { EmbeddingConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";

export interface EmbeddingProvider {
  embed(text: string): Promise<Float64Array>;
  embedBatch(texts: string[]): Promise<Float64Array[]>;
  readonly dimensions: number;
  readonly providerId: string;
  readonly modelId: string;
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly providerId = "ollama";
  readonly modelId: string;
  readonly dimensions: number;
  private readonly baseUrl: string;

  constructor(
    model: string,
    dims: number,
    baseUrl?: string,
  ) {
    this.modelId = model;
    this.dimensions = dims;
    this.baseUrl = baseUrl ?? "http://localhost:11434";
  }

  async embed(text: string): Promise<Float64Array> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.modelId, input: text }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama embed failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (!data.embeddings?.[0]) {
      throw new Error("Ollama returned empty embeddings");
    }
    return new Float64Array(data.embeddings[0]);
  }

  async embedBatch(texts: string[]): Promise<Float64Array[]> {
    const response = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.modelId, input: texts }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      throw new Error(`Ollama embed batch failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { embeddings: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) {
      throw new Error(`Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} texts`);
    }
    return data.embeddings.map((e) => new Float64Array(e));
  }
}

class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly providerId: string;
  readonly modelId: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    provider: string,
    model: string,
    dims: number,
    apiKey: string,
    baseUrl?: string,
  ) {
    this.providerId = provider;
    this.modelId = model;
    this.dimensions = dims;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? "https://api.openai.com/v1";
  }

  async embed(text: string): Promise<Float64Array> {
    const results = await this.callApi([text]);
    return results[0];
  }

  async embedBatch(texts: string[]): Promise<Float64Array[]> {
    return this.callApi(texts);
  }

  private async callApi(input: string[]): Promise<Float64Array[]> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.modelId, input }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "unknown error");
      throw new Error(`Embedding API failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => new Float64Array(d.embedding));
  }
}

class CachedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly db: MemoryDB,
  ) {}

  get dimensions(): number {
    return this.inner.dimensions;
  }
  get providerId(): string {
    return this.inner.providerId;
  }
  get modelId(): string {
    return this.inner.modelId;
  }

  async embed(text: string): Promise<Float64Array> {
    const hash = this.cacheKey(text);
    const cached = this.db.getCachedEmbedding(hash);
    if (cached) return cached;

    const vector = await this.inner.embed(text);
    this.db.setCachedEmbedding(hash, vector);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<Float64Array[]> {
    const results: (Float64Array | null)[] = texts.map((t) => {
      const hash = this.cacheKey(t);
      return this.db.getCachedEmbedding(hash);
    });

    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];
    for (let i = 0; i < results.length; i++) {
      if (!results[i]) {
        uncachedIndices.push(i);
        uncachedTexts.push(texts[i]);
      }
    }

    if (uncachedTexts.length > 0) {
      const fresh = await this.inner.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = fresh[j];
        this.db.setCachedEmbedding(this.cacheKey(texts[idx]), fresh[j]);
      }
    }

    return results as Float64Array[];
  }

  private cacheKey(text: string): string {
    return `${this.inner.providerId}:${this.inner.modelId}:${hashText(text)}`;
  }
}

export function createEmbeddingProvider(
  config: EmbeddingConfig,
  vectorDims: number,
  db: MemoryDB,
): EmbeddingProvider {
  if (!config.enabled) {
    return {
      providerId: "none",
      modelId: "disabled",
      dimensions: vectorDims,
      async embed() { return new Float64Array(vectorDims); },
      async embedBatch(texts) { return texts.map(() => new Float64Array(vectorDims)); }
    };
  }

  let inner: EmbeddingProvider;

  if (config.provider === "ollama") {
    inner = new OllamaEmbeddingProvider(config.model, vectorDims, config.baseUrl);
  } else {
    if (!config.apiKey) {
      throw new Error(`API key required for embedding provider "${config.provider}"`);
    }
    inner = new OpenAICompatEmbeddingProvider(
      config.provider,
      config.model,
      vectorDims,
      config.apiKey,
      config.baseUrl,
    );
  }

  return new CachedEmbeddingProvider(inner, db);
}
