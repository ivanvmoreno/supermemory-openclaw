import type { SupermemoryConfig } from "./config.ts";
import type { MemoryDB } from "./db.ts";
import type { EmbeddingProvider } from "./embeddings.ts";
import { hybridSearch } from "./search.ts";
import { getOrBuildProfile, buildUserProfile } from "./profile-builder.ts";

type Commander = any;

export function registerSupermemoryCli(
  program: Commander,
  db: MemoryDB,
  embeddings: EmbeddingProvider,
  cfg: SupermemoryConfig,
): void {
  const mem = program.command("supermemory").description("Supermemory graph memory commands");

  mem
    .command("search")
    .description("Search memories")
    .argument("<query>", "Search query")
    .option("--limit <n>", "Max results", String(cfg.maxRecallResults))
    .action(async (query: unknown, opts: unknown) => {
      const q = query as string;
      const limit = Number.parseInt(
        (opts as Record<string, string>).limit ?? String(cfg.maxRecallResults),
        10,
      );
      const results = await hybridSearch(q, db, embeddings, cfg, { maxResults: limit });
      if (results.length === 0) {
        console.log("No memories found.");
        return;
      }
      for (const r of results) {
        console.log(
          `[${r.memory.id.slice(0, 8)}] ${(r.score * 100).toFixed(0)}% [${r.memory.memory_type}] ${r.memory.text.slice(0, 120)}`,
        );
      }
    });

  mem
    .command("profile")
    .description("Show user profile")
    .option("--rebuild", "Force rebuild profile")
    .action(async (opts: unknown) => {
      const rebuild = !!(opts as Record<string, boolean>).rebuild;
      const profile = rebuild ? buildUserProfile(db, cfg) : getOrBuildProfile(db, cfg, 0);

      console.log("\n=== Long-Term Profile ===");
      if (profile.longTerm.length === 0) {
        console.log("  (empty)");
      } else {
        for (const item of profile.longTerm) {
          console.log(`  - ${item}`);
        }
      }

      console.log("\n=== Recent Context ===");
      if (profile.recent.length === 0) {
        console.log("  (empty)");
      } else {
        for (const item of profile.recent) {
          console.log(`  - ${item}`);
        }
      }
    });

  mem
    .command("stats")
    .description("Show memory statistics")
    .action(async () => {
      const stats = db.stats();
      console.log(`Total memories:      ${stats.totalMemories}`);
      console.log(`Active memories:     ${stats.activeMemories}`);
      console.log(`Superseded memories: ${stats.supersededMemories}`);
      console.log(`Entities:            ${stats.entities}`);
      console.log(`Relationships:       ${stats.relationships}`);
      console.log(`Vector search:       ${stats.vectorAvailable ? "available" : "unavailable"}`);
    });

  mem
    .command("wipe")
    .description("Delete all memories (requires confirmation)")
    .option("--confirm", "Confirm deletion")
    .action(async (opts: unknown) => {
      const confirm = !!(opts as Record<string, boolean>).confirm;
      if (!confirm) {
        console.log("Use --confirm to delete all memories.");
        return;
      }
      db.wipeAll();
      console.log("All memories deleted.");
    });
}
