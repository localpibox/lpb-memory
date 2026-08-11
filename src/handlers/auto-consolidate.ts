/**
 * Auto-consolidation — when memory hits capacity, trigger automatic
 * consolidation instead of returning an error.
 *
 * Default transport: subprocess only. Consolidation runs in an isolated
 * `pi -p` subprocess with a fresh context window — it never shares the
 * current session's context, avoiding context-size overflow when the session
 * is near capacity.
 *
 * This matches the Qwen thinking-overflow mitigation strategy: fresh context
 * + thinking disabled guarantees the consolidation request fits within the
 * model's context window regardless of how bloated the active session is.
 *
 * The subprocess child process modifies files on disk, so the parent MUST
 * reload from disk after a subprocess-based consolidation completes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import type { DatabaseManager } from "../store/db.js";
import { CONSOLIDATION_PROMPT, ENTRY_DELIMITER, DEFAULT_CONSOLIDATION_TIMEOUT_MS, logMemory } from "../constants.js";
import type { ConsolidationResult, ConfigOrProvider, MemoryConfig } from "../types.js";
import { resolveConfig } from "../types.js";
import { execChildPrompt } from "./pi-child-process.js";

const MAX_CONSOLIDATION_CHARS = 4800; // Cap per-batch prompt size to avoid Qwen thinking loops

type MemoryTarget = "memory" | "user" | "failure";
type ToolMemoryTarget = MemoryTarget | "project";
type ConsolidationLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride">;




function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === "user") return store.getUserEntries();
  if (target === "failure") return store.getAllFailureEntries();
  return store.getMemoryEntries();
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === "project") return "Project Memory";
  if (target === "user") return "User Profile";
  if (target === "failure") return "Failure Memory";
  return "Memory";
}

/**
 * Split entries into character-bounded batches to prevent Qwen thinking loops.
 * Qwen3+llama.cpp enters an infinite reasoning loop when the prompt exceeds
 * ~10KB (model spends all max_tokens on reasoning_content).
 */
function splitIntoBatches(entries: string[], maxChars: number): string[][] {
  if (entries.length === 0) return [];
  const batches: string[][] = [];
  let batch: string[] = [];
  let batchSize = 0;

  for (const entry of entries) {
    const entrySize = entry.length;
    const totalEntry = entrySize + 4; // ENTRY_DELIMITER ≈ 4 chars (section delimiter)

    if (batchSize + totalEntry > maxChars && batch.length > 0) {
      batches.push(batch);
      batch = [];
      batchSize = 0;
    }
    batch.push(entry);
    batchSize += totalEntry;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * Filter out circular meta-entries that describe the consolidation process itself.
 * These are self-referential entries (e.g., "consolidation hangs because...") that
 * get added during debugging sessions and create a feedback loop: more entries →
 * bigger prompt → more failures → more meta entries.
 *
 * Note: This filter is a defensive measure. The primary fix is in the review prompt
 * which instructs the agent not to create entries about the consolidation/repair process.
 * Entries about the tool should only be created for genuine environmental facts
 * (e.g., "consolidation is slow on this hardware") not for debugging commentary
 * (e.g., "consolidation hangs because timeout is too short").
 */
function filterConsolidationEntries(entries: string[]): string[] {
  const metaPatterns = [
    // Only filter entries that are clearly debugging commentary about the tool
    // itself failing, not legitimate environmental observations.
    /consolidation.*(hang|timeout|stuck|freezes|blocks.*session|causes.*hang|prevents.*consolidation|causes.*overflow)/i,
    /consolidation.*(subprocess|process).*(fail|hang|timeout|error|crash|die|kill|not.*work|broken|stuck)/i,
    /enable_thinking.*(reduce|lower|disable|turn.*off|not.*enable|remove)/i,
    /reasoning_effort.*(too small|too large|insufficient|needs|should|adjust)/i,
    /max_tokens.*(too small|too large|insufficient|budget|increase|decrease)/i,
    /Qwen3.*(enter|get|fall).*(infinite|endless|runaway).*(loop|thinking|reasoning)/i,
    /deterministic pre-filter.*(problem|issue|limitation|bug|fail|skip|break|wrong)/i,
    /recovery file.*(accumulate|pile|stale|wrong|bad|not.*delete|orphan)/i,
    /subprocess.*(timeout|hang|stuck|fail|error).*(too.*long|exceed|exceeded|never.*complete|broke|not.*work|broken)/i,
  ];
  return entries.filter(entry => !metaPatterns.some(p => p.test(entry)));
}

function describeConsolidationFailure(
  result: { code: number; stderr?: string; killed?: boolean },
  timeoutMs: number,
): string {
  const stderr = result.stderr?.trim();
  const terminated = result.killed || result.code === 124 || result.code === 143;

  if (terminated) {
    const msg = `Consolidation subprocess was terminated (likely timeout or cancellation). Timeout: ${timeoutMs}ms. Consider increasing consolidationTimeoutMs if this is a manual run.`;
    logMemory(msg, "warn");
    return msg;
  }

  const msg = `Consolidation process exited with code ${result.code}: ${stderr?.slice(0, 200) || "unknown error"}`;
  logMemory(msg, "error");
  return msg;
}

export async function triggerConsolidation(
  pi: ExtensionAPI,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  toolTarget: ToolMemoryTarget = target,
  llmConfig: ConsolidationLlmConfig = {},
  _directCtx: Pick<ExtensionContext, "model" | "modelRegistry"> | null = null,
  _dbManager: DatabaseManager | null = null,
  _projectName?: string | null,
  _deps?: Record<string, never>,
): Promise<ConsolidationResult> {
  let entries = entriesForTarget(store, target);
  const label = labelForTarget(target, toolTarget);

  // Deterministic pre-filter: remove circular meta-entries before batching
  entries = filterConsolidationEntries(entries);

  logMemory(`triggerConsolidation: starting for target '${toolTarget}', timeout=${timeoutMs}ms, entries=${entries.length} (filtered from original count)`);

  // Guard: if pi is stale (session was replaced), execChildPrompt will throw.
  // Best-effort: try a no-op call to detect staleness before spawning subprocesses.
  // We can't check ctx here (no ctx available), so we rely on execChildPrompt's
  // internal runtime.assertActive() which throws on stale ctx.
  // The caller wraps each batch in a try/catch to handle this gracefully.

  // Split entries into batches to keep each prompt under the Qwen thinking-loop threshold.
  // Qwen3+llama.cpp enters an infinite reasoning loop when the prompt exceeds ~10KB.
  const batches = splitIntoBatches(entries, MAX_CONSOLIDATION_CHARS);
  if (batches.length === 0) {
    return { consolidated: false, error: "No entries to consolidate" };
  }

  // Run consolidation with bounded concurrency (default 4) to prevent resource
  // spikes from spawning too many subprocesses. With N batches and cap C,
  // at most C subprocesses run in parallel.
  const MAX_CONCURRENT_CONSOLIDATIONS = 4;
  const results: Array<{ batch: number; success: boolean; error?: string }> = new Array(batches.length);

  let nextIdx = 0;
  const runNext = async (): Promise<void> => {
    while (true) {
      const idx = nextIdx++;
      if (idx >= batches.length) return;
      const batch = batches[idx];

      const currentContent = batch.join(ENTRY_DELIMITER);
      const batchPrompt = [
        CONSOLIDATION_PROMPT,
        "",
        `--- ${label} Entries (batch ${idx + 1}/${batches.length}) ---`,
        currentContent || "(empty)",
        "",
        `Use the memory tool to consolidate. Target: '${toolTarget}'`,
      ].join("\n");

      const subprocessConfig: ConsolidationLlmConfig = {
        ...llmConfig,
        llmThinkingOverride: undefined,
      };

      try {
        const result = await execChildPrompt(pi, batchPrompt, subprocessConfig, {
          signal,
          timeoutMs,
          retryWithoutOverrides: true,
        }) as { code: number; stdout?: string; stderr?: string; killed?: boolean };
        if (result.code !== 0) {
          results[idx] = { batch: idx, success: false, error: describeConsolidationFailure(result, timeoutMs) };
        } else {
          results[idx] = { batch: idx, success: true };
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        results[idx] = { batch: idx, success: false, error: errMsg.slice(0, 300) };
      }
    }
  };

  // Launch at most MAX_CONCURRENT_CONSOLIDATIONS workers. When a worker finishes
  // one batch, it picks up the next from the shared nextIdx counter.
  const workers = Array.from({ length: Math.min(batches.length, MAX_CONCURRENT_CONSOLIDATIONS) }, () => runNext());
  await Promise.all(workers);

  const failures = results.filter((r): r is { batch: number; success: false; error: string } => !r.success);
  if (failures.length > 0) {
    return { consolidated: false, error: failures[0].error };
  }

  logMemory(`triggerConsolidation: success for '${toolTarget}' (${batches.length} batch(es))`);
  return { consolidated: true };
}

/**
 * Register the /memory-consolidate command for manual consolidation.
 */
export function registerConsolidateCommand(
  pi: ExtensionAPI,
  store: MemoryStore,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  projectStore: MemoryStore | null = null,
  projectName?: string | null,
  llmConfig: ConfigOrProvider<ConsolidationLlmConfig> = {},
  _dbManager: DatabaseManager | null = null,
  _deps?: Record<string, never>,
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger memory consolidation to free up space (subprocess only, thinking disabled)",
    handler: async (_args, ctx) => {
      const cfg = resolveConfig(llmConfig);
      const manualTimeoutMs = Math.max(timeoutMs, 180000);
      const results: string[] = [];
      const targets: Array<{
        label: string;
        store: MemoryStore;
        target: MemoryTarget;
        toolTarget: ToolMemoryTarget;
      }> = [
        { label: "memory", store, target: "memory", toolTarget: "memory" },
        { label: "user", store, target: "user", toolTarget: "user" },
        { label: "failure", store, target: "failure", toolTarget: "failure" },
      ];

      if (projectStore) {
        targets.push({
          label: projectName ? `project:${projectName}` : "project",
          store: projectStore,
          target: "memory",
          toolTarget: "project",
        });
      }

      try {
        ctx.ui.notify(
          `🔄 Starting memory consolidation for ${targets.length} target${targets.length === 1 ? "" : "s"}...`,
          "info",
        );
      } catch {
        // Best-effort only. If the command context is already stale, continue
        // with the consolidation work rather than failing before it starts.
      }

      for (const item of targets) {
        const entries = entriesForTarget(item.store, item.target);

        if (entries.length === 0) {
          results.push(`${item.label}: (empty, nothing to consolidate)`);
          continue;
        }

        try {
          ctx.ui.notify(
            `⏳ Consolidating ${item.label}...`,
            "info",
          );
        } catch {
          // Best-effort progress feedback only.
        }

        try {
          const result = await triggerConsolidation(
            pi,
            item.store,
            item.target,
            ctx.signal,
            manualTimeoutMs,
            item.toolTarget,
            cfg,
            null,
            null,
            null,
          );

          if (result.consolidated) {
            await item.store.loadFromDisk();
            results.push(`${item.label}: ✅ consolidated`);
          } else {
            results.push(`${item.label}: ❌ ${result.error}`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes("stale after session replacement")) {
            results.push(`${item.label}: ⏭️ session replaced, consolidation skipped`);
          } else {
            results.push(`${item.label}: ❌ ${errMsg.slice(0, 200)}`);
          }
        }
      }

      const summary = `\n  🔄 Memory Consolidation\n  ${"─".repeat(30)}\n${results.map((r) => `  ${r}`).join("\n")}`;

      try {
        ctx.ui.notify(summary, "info");
      } catch {
        // Child consolidation can indirectly trigger a runtime reload/session
        // replacement. If that happens, the original command ctx is stale by
        // the time we reach the final summary, so the command should exit
        // quietly instead of surfacing a stale-ctx error.
      }
    },
  });
}
