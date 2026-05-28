import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { PermissionState } from "./types";
import { loadUnifiedConfig } from "./config-loader";

/**
 * Result of a persistent-approval write.
 *
 * `added` is true when a new rule was written to disk.
 * `added` is false when the rule was already present (idempotent no-op write).
 * `error` is set when the write was skipped due to a corrupt config or I/O error.
 */
export interface PersistentApprovalResult {
  added: boolean;
  error?: string;
}

/**
 * Writer that persists "allow forever" permission rules to the global config.
 *
 * Reads the current global `config.json`, inserts the approved pattern
 * under the correct surface in the `permission` map, and writes atomically
 * (temp file + rename). The PermissionManager's mtime-based cache will
 * automatically pick up the change on the next checkPermission() call.
 *
 * If the config file cannot be parsed, the write is skipped (never overwrite
 * a corrupt config) and an error is returned.
 */
export class PersistentRulesWriter {
  constructor(
    private readonly globalConfigPath: string,
    private readonly notify: (msg: string, kind: "info" | "warning" | "error") => void,
    private readonly writeDebugLog: (event: string, details?: Record<string, unknown>) => void,
  ) {}

  /**
   * Persist an allow rule for the given surface and pattern.
   *
   * The pattern is inserted into `config.permission[surface]`:
   * - If the surface entry is absent → `{ [pattern]: "allow" }`.
   * - If the surface entry is a string shorthand (e.g. `"ask"`) → upgrade to
   *   `{ "*": <shorthand>, [pattern]: "allow" }`.
   * - If the surface entry is an object map → add/overwrite `[pattern]: "allow"`.
   * - If the pattern already equals `"allow"` → no-op (idempotent).
   */
  approve(surface: string, pattern: string): PersistentApprovalResult {
    const { config, issues } = loadUnifiedConfig(this.globalConfigPath);

    // If the config has parse issues and the file exists, don't overwrite it.
    if (issues.length > 0 && existsSync(this.globalConfigPath)) {
      const error = `Cannot persist rule: config at '${this.globalConfigPath}' has parse errors`;
      this.notify(error, "error");
      this.writeDebugLog("persistent_rule.write_skipped", { surface, pattern, reason: "parse_error", issues });
      return { added: false, error };
    }

    const permission = config.permission ?? {};
    const entry = permission[surface];

    // Idempotent check: pattern already allowed
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      if ((entry as Record<string, unknown>)[pattern] === "allow") {
        this.writeDebugLog("persistent_rule.already_present", { surface, pattern });
        this.notify(`"${pattern}" is already permanently allowed under ${surface}`, "info");
        return { added: false };
      }
    }

    // Insert or upgrade the surface entry
    permission[surface] = this.upgradeEntry(entry, pattern);

    const merged = { ...config, permission: permission as Record<string, unknown> };
    this.writeAtomically(merged);

    this.writeDebugLog("persistent_rule.added", { surface, pattern });
    this.notify(`Saved permanent rule: ${surface} "${pattern}" → allow`, "info");
    return { added: true };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  /**
   * Upgrade a permission entry to include the new allow pattern.
   *
   * - `undefined` / absent → `{ [pattern]: "allow" }`
   * - String shorthand (e.g. `"ask"`) → `{ "*": <shorthand>, [pattern]: "allow" }`
   * - Object map → `{ ...existing, [pattern]: "allow" }`
   */
  private upgradeEntry(
    entry: unknown,
    pattern: string,
  ): Record<string, PermissionState> {
    if (entry === undefined || entry === null) {
      return { [pattern]: "allow" };
    }

    if (typeof entry === "string") {
      // Upgrade shorthand: "ask" → { "*": "ask", "<pattern>": "allow" }
      if (entry === "allow" || entry === "deny" || entry === "ask") {
        return { "*": entry, [pattern]: "allow" };
      }
      return { [pattern]: "allow" };
    }

    if (typeof entry === "object" && !Array.isArray(entry)) {
      return { ...(entry as Record<string, PermissionState>), [pattern]: "allow" };
    }

    // Unexpected type — replace with just the pattern
    return { [pattern]: "allow" };
  }

  /**
   * Atomic write: temp file + rename. Cleans up the temp file on failure.
   * Reuses the same idiom as saveExtensionConfig in runtime.ts.
   */
  private writeAtomically(config: Record<string, unknown>): void {
    const tmpPath = `${this.globalConfigPath}.tmp`;
    try {
      mkdirSync(dirname(this.globalConfigPath), { recursive: true });
      writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
      renameSync(tmpPath, this.globalConfigPath);
    } catch (error) {
      try {
        if (existsSync(tmpPath)) {
          unlinkSync(tmpPath);
        }
      } catch {
        // Ignore cleanup failures.
      }
      const message = error instanceof Error ? error.message : String(error);
      this.notify(`Failed to save permission config: ${message}`, "error");
      this.writeDebugLog("persistent_rule.write_failed", { error: message });
    }
  }
}
