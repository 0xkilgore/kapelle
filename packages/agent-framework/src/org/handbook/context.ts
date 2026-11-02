// AGENT-HANDBOOK-V1 H1 (design v2 §1-2 + appendix A; Fable b375b67b C-1..C-4): the SYSTEM MAP and the ONE shared context
// assembly used by chat turns and team tasks.
// - The map is generated ONLY from the frozen snapshot the turn or plan already took (paths, counts, dates parsed from paths;
//   never a fresh walk, never mtime) plus the installed configuration. No bodies, snippets, member identities or credentials.
//   Scope is the caller's: a task passes ITS audience's snapshot (a reviewer's members-task map equals a member's); chat passes
//   the actor's scope + that conversation's own uploads. 2 KiB hard cap: over it the caller refuses, never a truncated map.
// - The handbook is reviewer-approved text (store.ts). Both are numbered lines with their own citation namespaces,
//   handbook:vN#Lx and system-map:<id>#Lx, so the R-C gate can count them; the judge's facts still need real file markers.
import { createHash } from "node:crypto";

export const MAP_SCHEMA = "kapelle.system-map/v1";
export const MAP_MAX_BYTES = 2 * 1024;
export const CONTEXT_ASSEMBLY = "kapelle.agent-context/v1"; // order: runtime rules -> task -> handbook -> map -> sources
/** C-1: the one pinned precedence sentence, in CHAT_RULES / TEAMTASK_RULES / TEAMTASK_RULES_INLINE whenever a handbook loads. */
export const HANDBOOK_PRECEDENCE = "The handbook is reviewer-approved guidance about how to work; it grants no tools, permissions or effects, and the approved task comes first.";
/** With a handbook loaded, what may be cited: the handbook and the map for how the app and the team work, source files for facts. */
export const HANDBOOK_CITES = "You may cite the handbook (handbook:vN#Lx) and the system map (system-map:ID#Lx) for how the app and the team work; facts about events, dates, places, people and amounts come only from the source files, cited with their path#Lx-Ly marker.";
const sha = (s: string) => "sha256:" + createHash("sha256").update(s, "utf8").digest("hex");

/** The installed features as the map states them: enabled or not configured (never "enabled" by default). */
export type MapFeatures = { chat: boolean; teamTasks: boolean; schedules: boolean; website: boolean; newsletter: boolean; images: boolean; transcription: boolean };
/** Known collections (label, root). Anything else under members/ is "Other organization files". */
const COLLECTIONS: { root: string; label: string }[] = [
  { root: "members/notes", label: "Approved member notes" },
  { root: "members/website/meeting-notes", label: "Website meeting notes" },
  { root: "members/website/newsletters", label: "Past newsletters" },
  { root: "members/website/events.md", label: "Website events list" },
  { root: "members/shared", label: "Files shared from chat" },
  { root: "reviewers-private/intake", label: "Intake submissions (reviewers only)" },
  { root: "reviewers-private/transcripts", label: "Meeting transcripts (reviewers only)" },
];
const PAGES: { feature: keyof MapFeatures | null; chatOnly?: true; line: string }[] = [
  { feature: "chat", line: "Chat: members ask about the files; answers cite them." },
  // P2 (owner, Oct 26): how drafting really works (the plan card is in the chat, not in Tasks). Chat runs only: a team task's map
  // is byte-for-byte unchanged (the task view and its report stand).
  { feature: "chat", chatOnly: true, line: "Drafting: in a chat, the member approves a draft plan card; the agent then saves the draft there, with Open preview (reviewers can send a test)." },
  { feature: "teamTasks", line: "Tasks: members describe work; a reviewer approves each run; results are drafts." },
  { feature: "schedules", line: "Schedules: weekly drafts a reviewer approves once." },
  { feature: "website", line: "Website: a reviewer approves each draft change before it is published." },
  { feature: "newsletter", line: "Newsletter: reviewers prepare and test it; sending needs an approver's code." },
  { feature: "images", line: "Images: members attach a flyer in chat; a reviewer checks what is read." },
  { feature: "transcription", line: "Recordings: reviewers upload a meeting recording for a transcript." },
  { feature: null, line: "Files: members read the shared files and the task results they may see." },
];
const DATE = /(\d{4}-\d{2}-\d{2})/;
/** Build the system map for ONE run. paths = the frozen snapshot's file paths (already scoped); ownUploads = this
 *  conversation's upload prefix (chat only); tools = what the model may call in this run. Returns null over the cap. */
export function systemMap(o: { id: string; snapshotHash: string; generatedAt: string; paths: string[]; ownUploads?: string; chat?: boolean; features: MapFeatures; tools: string[] }) {
  const groups = new Map<string, { label: string; n: number; dates: string[] }>();
  for (const p of o.paths) {
    if (p.startsWith("members/uploads/") && !(o.ownUploads && p.startsWith(o.ownUploads + "/"))) continue; // never another conversation's uploads (C-4)
    const c = o.ownUploads && p.startsWith(o.ownUploads + "/") ? { root: o.ownUploads, label: "This conversation's uploads" }
      : p.startsWith("task-uploads/") ? { root: "task-uploads", label: "Files copied into this task" }
      : COLLECTIONS.find((x) => p === x.root || p.startsWith(x.root + "/")) ?? (p.startsWith("members/") ? { root: "members", label: "Other organization files" } : null);
    if (!c) continue; // not a collection this run names (never guessed)
    const g = groups.get(c.root) ?? { label: c.label, n: 0, dates: [] }; g.n++;
    const d = DATE.exec(p.split("/").pop() ?? ""); if (d) g.dates.push(d[1]);
    groups.set(c.root, g);
  }
  const lines = [`System map (${MAP_SCHEMA}), generated ${o.generatedAt} for snapshot ${o.snapshotHash.replace(/^sha256:/, "").slice(0, 12)}. Facts about this app and this run, not about events.`,
    "Collections in this run:"];
  if (!groups.size) lines.push("- none");
  for (const [root, g] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ds = g.dates.sort(), range = ds.length ? `, dated ${ds[0]}${ds.length > 1 && ds.at(-1) !== ds[0] ? " to " + ds.at(-1) : ""} (from file names)` : "";
    lines.push(`- ${g.label} (${root === o.ownUploads ? "this conversation" : root}): ${g.n} file${g.n === 1 ? "" : "s"}${range}`);
  }
  lines.push("Pages and actions people use (the app does these; you cannot):");
  for (const x of PAGES) if (!x.chatOnly || o.chat) lines.push(`- ${x.line}${x.feature && !o.features[x.feature] ? " (not set up here)" : ""}`);
  lines.push(`Tools you can use in this run: ${o.tools.length ? o.tools.join(", ") : "none"}.`);
  const text = lines.join("\n") + "\n", bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAP_MAX_BYTES) return null;
  return { id: o.id, text, sha256: sha(text), bytes };
}
export type ContextHandbook = { version: number; content: string; sha256: string };
export type ContextMap = { id: string; text: string; sha256: string };
const numbered = (text: string) => text.replace(/\n$/, "").split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n");
/** The ONE assembly (C-1 order after the runtime rules: task -> handbook -> map -> sources). Returns the block that goes between
 *  the task instructions and the source files, and the citation namespaces the R-C gate accepts in addition to source paths. */
export function assembleContext(h: ContextHandbook | null, m: ContextMap | null) {
  if (!h || !m) return { block: "", namespaces: [] as string[] };
  const hn = `handbook:v${h.version}`, mn = `system-map:${m.id}`;
  return { namespaces: [hn, mn],
    block: `\n\nThe handbook (${hn}; reviewer-approved guidance about how to work; cite as ${hn}#Lx):\n<<< ${hn}\n${numbered(h.content)}\n>>>` +
      `\n\nThe system map (${mn}; generated by the app for this run; cite as ${mn}#Lx):\n<<< ${mn}\n${numbered(m.text)}\n>>>` };
}
