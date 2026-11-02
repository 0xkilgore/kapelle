// N-5: every refusal label a browser session can receive has UI words (or a family sentence), so the review UI never
// regresses to "That didn't work (code)". Scans the runtime, access and hub sources; server-only labels are listed explicitly.
import { it, expect } from "vitest";
import { readFileSync } from "node:fs";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");
// Reachable only from Ops, config, the socket layer or provider ingress — never from a signed-in browser.
// Option A: the Ops-socket member/policy routes' labels, and two table names the column migration mentions.
const SERVER_ONLY = new Set(["access_config_invalid", "access_envelope_key_invalid", "access_last_admin", "access_member_unknown", "access_ops_action_not_permitted",
  "access_role_invalid", "access_authorizations", "access_challenges", "access_socket_directory_not_private", "access_socket_path_occupied",
  "access_method", "access_route", "hub_ingress_config_invalid", "hub_key_file_not_private", "hub_org_config_invalid", "hub_signature_invalid", "hub_signature_missing"]);

it("every session-reachable refusal label has UI words", () => {
  const labels = new Set<string>();
  for (const f of ["org/org-runtime.ts", "org/notes.ts", "org/member-reply.ts", "access/org-access.ts", "access/socket.ts", "hub/hub.ts"])
    for (const [, l] of src(f).matchAll(/"((?:access|hub|notes|adopt|plan|intake_installation|reply_policy|trigger|member|setup|approve)_[a-z_]+)"/g)) if (!SERVER_ONLY.has(l)) labels.add(l);
  const app = src("hub/ui/app.js");
  const keys = new Set([...app.matchAll(/\b([a-z]+_[a-z_]+):\s*"/g)].map((m) => m[1]));
  const families = [...app.matchAll(/\["([a-z_]+_)",\s*"/g)].map((m) => m[1]);
  expect(labels.size).toBeGreaterThan(60);
  expect([...labels].filter((l) => !keys.has(l) && !families.some((f) => l.startsWith(f))).sort()).toEqual([]);
});

// Fable USABILITY v1 F-2: Safari/iOS before 16.4 cannot parse RegExp lookbehind; one in app.js (built at load) would blank the
// whole app there. No "(?<" (lookbehind or named groups) anywhere in the served script.
it("app.js uses no RegExp lookbehind or named groups", () => {
  expect(src("hub/ui/app.js").includes("(?<")).toBe(false);
});

// Fable F-1 on 0091459e: EVERY team-task label (TEAMTASK_REASONS) and the inline path's tools-off refusal have UI words.
it("every TEAMTASK_REASONS label and chat_finish_inconsistent have UI words", async () => {
  const { TEAMTASK_REASONS } = await import("../src/org/teamtasks/labels.js");
  const app = src("hub/ui/app.js"), keys = new Set([...app.matchAll(/\b([a-z]+_[a-z_]+):\s*"/g)].map((m) => m[1]));
  expect([...TEAMTASK_REASONS, "chat_finish_inconsistent"].filter((l) => !keys.has(l))).toEqual([]);
});

// SCHEDULED-TASKS-V1 S2 (design §4): every fixed teamtask_schedule_* label has UI words.
it("every teamtask_schedule_* label has UI words", async () => {
  const { TEAMTASK_REASONS } = await import("../src/org/teamtasks/labels.js");
  const app = src("hub/ui/app.js"), keys = new Set([...app.matchAll(/\b([a-z]+_[a-z_]+):\s*"/g)].map((m) => m[1]));
  const sched = TEAMTASK_REASONS.filter((l) => l.startsWith("teamtask_schedule_"));
  expect(sched).toHaveLength(7);
  expect(sched.filter((l) => !keys.has(l))).toEqual([]);
});

// AGENT-HANDBOOK-V1 H1 (Fable B-4): the chat handbook refusals and the handbook store labels have words too (tasks: covered above).
it("the H1 chat and handbook labels have UI words where a browser can see them", () => {
  const app = src("hub/ui/app.js"), keys = new Set([...app.matchAll(/\b([a-z]+_[a-z_]+):\s*"/g)].map((m) => m[1]));
  expect(["chat_handbook_missing", "chat_system_map_unavailable", "teamtask_handbook_missing", "teamtask_handbook_changed", "teamtask_system_map_unavailable"].filter((l) => !keys.has(l))).toEqual([]);
});

// AGENT-HANDBOOK-V1 H2 (Fable C-D): the handbook store/action labels are browser-reachable now; each has words.
it("every HANDBOOK_REASONS label has UI words", async () => {
  const { HANDBOOK_REASONS } = await import("../src/org/handbook/labels.js");
  const app = src("hub/ui/app.js"), keys = new Set([...app.matchAll(/\b([a-z]+_[a-z_]+):\s*"/g)].map((m) => m[1]));
  expect(HANDBOOK_REASONS.filter((l) => !keys.has(l))).toEqual([]);
});
