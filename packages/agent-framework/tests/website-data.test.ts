// Website pack v0, W-2 data layer (Fable R-3/R-4/R-5/R-8): pinned schemas, the typed ops parser, the sanitizer, the surgical
// apply (untouched bytes identical; a no-op byte-identical), the deterministic summary and the line diff. Synthetic golden
// fixtures always; the real files of the local website clone too when it is present (read-only).
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { parseOps, parseBase, applyOps, summarize, lineDiff, opsSha, describeChanges, knownPlaces, WEBSITE_FILES } from "../src/org/website/data.js";

const EVENTS = `{
  "events": [
    {
      "id": "happy-hour-feb-2026",
      "title": "Community Happy Hour",
      "date": "2026-02-12",
      "time": "6:00 PM",
      "location": "Main Street Tavern",
      "address": "106 Birch St, Springfield, EX 00000",
      "description": "",
      "type": "social",
      "image": "/images/events/happy-hour.jpg",
      "contact": {
        "name": "Sam",
        "email": "sam@example.org"
      }
    },
    {
      "id": "east-bend-2026",
      "title": "East Bend Rezoning \\u2014 Community Input",
      "date": "2026-03-05",
      "time": "6:00 PM",
      "location": "Oakwood Community Center",
      "address": "101 Oak Street, Springfield, TN",
      "description": "Public input meeting.",
      "type": "meeting",
      "highlights": ["Free donuts — bring a friend"]
    }
  ],
  "meetingOverrides": {
    "x": 1
  },
  "pastEvents": []
}
`;
const MEETINGS = `{
  "meetings": [
    {
      "id": "2026-10",
      "date": "2026-10-08",
      "title": "Monthly Meeting Notes — October 8, 2026",
      "slug": "october-2026",
      "sections": [
        {
          "heading": "Public Safety",
          "body": "Report is [here](/meetings/crime-report-october-2026.pdf)."
        }
      ]
    }
  ]
}
`;
const TREE = new Set(["public/images/events/happy-hour.jpg", "public/images/events/tree-planting.jpg"]);
const TREE_PLANTING = { id: "tree-planting-nov-2026", title: "Tree planting", date: "2026-11-08", time: "9:00 AM", location: "Riverside Park", address: "Riverside Park, Springfield, TN",
  description: "Gloves and tools provided.", type: "community", image: "/images/events/tree-planting.jpg" };
const ops = (o: unknown) => JSON.stringify({ ops: o });

describe("website data (pinned v1)", () => {
  it("golden: add an event appends one element; every other byte is unchanged; summary + diff are deterministic", () => {
    parseBase("events", Buffer.from(EVENTS)); parseBase("meetings", Buffer.from(MEETINGS));
    const o = parseOps(ops([{ op: "upsert_event", event: TREE_PLANTING }]));
    const next = applyOps("events", EVENTS, o, TREE);
    expect(next.startsWith(EVENTS.slice(0, EVENTS.indexOf("\n    }\n  ],") + 6))).toBe(true); // the two existing events untouched, byte for byte
    expect(next.endsWith(EVENTS.slice(EVENTS.indexOf("\n  ],")))).toBe(true);
    expect(JSON.parse(next).events.at(-1)).toEqual(TREE_PLANTING);
    expect(next).toContain('\n    {\n      "id": "tree-planting-nov-2026",');
    expect(applyOps("meetings", MEETINGS, o, TREE)).toBe(MEETINGS); // ops for the other file never touch it
    expect(summarize(o)).toEqual({ title: 'Website: event "Tree planting" (2026-11-08)', lines: ['- event "Tree planting" (2026-11-08)'] });
    const d = lineDiff(EVENTS, next);
    expect(d.split("\n").filter((l) => l.startsWith("- "))).toEqual([]); // an append removes nothing
    expect(d.split("\n").filter((l) => l.startsWith("+ "))).toEqual(["+     },", "+     {", ...Object.entries(TREE_PLANTING).map(([k, v], i, a) => `+       "${k}": ${JSON.stringify(v)}${i < a.length - 1 ? "," : ""}`)]);
    expect(opsSha(o)).toMatch(/^sha256:/);
  });

  it("golden: update keeps unknown fields and escape style; remove first/last/only; no-op is byte-identical", () => {
    const upd = applyOps("events", EVENTS, parseOps(ops([{ op: "upsert_event", event: { id: "east-bend-2026", time: "6:30 PM" } }])), TREE);
    const e = JSON.parse(upd).events[1];
    expect(e).toMatchObject({ time: "6:30 PM", highlights: ["Free donuts — bring a friend"], title: "East Bend Rezoning — Community Input" });
    expect(upd).toContain('"title": "East Bend Rezoning \\u2014 Community Input"'); // the element kept its \u escapes
    expect(upd.slice(0, upd.indexOf('"id": "east-bend-2026"'))).toBe(EVENTS.slice(0, EVENTS.indexOf('"id": "east-bend-2026"')));
    expect(applyOps("events", EVENTS, parseOps(ops([{ op: "upsert_event", event: { id: "east-bend-2026", time: "6:00 PM" } }])), TREE)).toBe(EVENTS); // no-op
    const r0 = applyOps("events", EVENTS, parseOps(ops([{ op: "remove_event", id: "happy-hour-feb-2026" }])), TREE);
    expect(JSON.parse(r0).events.map((x: any) => x.id)).toEqual(["east-bend-2026"]);
    const r1 = applyOps("events", EVENTS, parseOps(ops([{ op: "remove_event", id: "east-bend-2026" }])), TREE);
    expect(JSON.parse(r1).events.map((x: any) => x.id)).toEqual(["happy-hour-feb-2026"]);
    const none = applyOps("events", r1, parseOps(ops([{ op: "remove_event", id: "happy-hour-feb-2026" }])), TREE);
    expect(JSON.parse(none).events).toEqual([]);
    expect(JSON.parse(none).meetingOverrides).toEqual({ x: 1 });
    const m = applyOps("meetings", MEETINGS, parseOps(ops([{ op: "upsert_meeting", meeting: { id: "2026-11", date: "2026-11-12", title: "Monthly Meeting Notes — November 12, 2026",
      slug: "november-2026", sections: [{ heading: "Tree planting", body: "Saturday Nov 8 at Riverside Park." }] } }])), TREE);
    expect(JSON.parse(m).meetings.map((x: any) => x.id)).toEqual(["2026-10", "2026-11"]);
    expect(m.startsWith(MEETINGS.slice(0, MEETINGS.lastIndexOf("\n  ]")))).toBe(true);
  });

  it("refusals: not JSON, not ops, unsafe content, non-https links, missing image, incomplete new item, unknown target, base drift", () => {
    const bad = (answer: string) => { try { parseOps(answer); return null; } catch (e: any) { return e.label; } };
    expect(bad("Sure! I added the event.")).toBe("website_ops_not_json");
    expect(bad(ops([]))).toBe("website_ops_invalid");
    expect(bad(JSON.stringify({ ops: [{ op: "write_file", path: ".github/workflows/x.yml", content: "x" }] }))).toBe("website_ops_invalid");
    expect(bad(JSON.stringify({ ops: [{ op: "upsert_event", event: TREE_PLANTING }], push_to: "main" }))).toBe("website_ops_invalid");
    for (const description of ["<script>alert(1)</script>", "see javascript:alert(1)", "[x](data:text/html,hi)", "[x](http://insecure.example)", "[x](//evil.example)", "<img src=x>"])
      expect(bad(ops([{ op: "upsert_event", event: { ...TREE_PLANTING, description } }])), description).toBe("website_content_unsafe");
    expect(bad(ops([{ op: "upsert_event", event: { ...TREE_PLANTING, link: { label: "x", url: "http://x.example" } } }]))).toBe("website_ops_invalid");
    expect(bad(ops([{ op: "upsert_event", event: { ...TREE_PLANTING, type: "party" } }]))).toBe("website_ops_invalid");
    expect(bad(ops([{ op: "upsert_event", event: { ...TREE_PLANTING, id: "../../x" } }]))).toBe("website_ops_invalid");
    expect(bad("```json\n" + ops([{ op: "remove_event", id: "east-bend-2026" }]) + "\n```")).toBeNull(); // a json fence is tolerated
    const apply = (o: unknown, file: "events" | "meetings" = "events", base = EVENTS) => { try { applyOps(file, base, parseOps(ops(o)), TREE); return null; } catch (e: any) { return e.label; } };
    expect(apply([{ op: "upsert_event", event: { ...TREE_PLANTING, image: "/images/events/missing.jpg" } }])).toBe("website_image_missing");
    expect(apply([{ op: "upsert_event", event: { id: "brand-new", title: "Only a title" } }])).toBe("website_op_incomplete");
    expect(apply([{ op: "remove_event", id: "nope" }])).toBe("website_op_target_unknown");
    const drift = (b: string, f: "events" | "meetings" = "events") => { try { parseBase(f, Buffer.from(b)); return null; } catch (e: any) { return e.label; } };
    expect(drift(EVENTS.replace('"pastEvents": []', '"pastEvents": [], "newTopLevel": 1'))).toBe("website_base_shape_changed");
    expect(drift(EVENTS.replace('"type": "social",', '"type": "social", "ticketPrice": 5,'))).toBe("website_base_shape_changed");
    expect(drift("not json")).toBe("website_base_shape_changed");
    expect(drift("{}", "meetings")).toBe("website_base_shape_changed");
  });
});

describe("website v0.1: plain-language changes, preview path, diff order", () => {
  it("before -> after per field from the files themselves; added / removed entries; the changed page's path", () => {
    const xmas = { id: "christmas-party-2026", title: "Joint Neighborhood Christmas Party", date: "2026-12-12", time: "6:30 PM", location: "Oakwood Community Center",
      address: "101 Oak Street, Springfield, TN", description: "Food and music.", type: "social" };
    const base = EVENTS.replace('  "meetingOverrides"', "  \"meetingOverrides\"").replace(/\n    \}\n  \],/, `\n    },\n    ${JSON.stringify(xmas, null, 2).split("\n").join("\n    ")}\n  ],`);
    expect(JSON.parse(base).events.at(-1)).toEqual(xmas);
    const ops = parseOps(ops2([{ op: "upsert_event", event: { id: "christmas-party-2026", title: "Joint Hillcrest Park & Example Park Christmas Party", time: "6:00 PM",
      location: "Hillcrest Park Community Center", address: "105 Cedar St, Springfield, TN" } }]));
    const after = applyOps("events", base, ops, TREE);
    expect(describeChanges({ events: base, meetings: MEETINGS }, { events: after, meetings: MEETINGS }, ops)).toEqual([{ kind: "event", id: "christmas-party-2026", action: "changed",
      title: "Joint Hillcrest Park & Example Park Christmas Party", date: "2026-12-12", path: "/events/christmas-party-2026", fields: [
        { field: "Title", before: "Joint Neighborhood Christmas Party", after: "Joint Hillcrest Park & Example Park Christmas Party" },
        { field: "Time", before: "6:30 PM", after: "6:00 PM" },
        { field: "Location", before: "Oakwood Community Center", after: "Hillcrest Park Community Center" },
        { field: "Address", before: "101 Oak Street, Springfield, TN", after: "105 Cedar St, Springfield, TN" }] }]);
    // Owner feedback (4): a changed line reads "- old" THEN "+ new".
    const d = lineDiff(base, after).split("\n").filter((l) => /^[-+] /.test(l));
    expect(d[0]).toMatch(/^- .*"title": "Joint Neighborhood Christmas Party"/);
    expect(d[1]).toMatch(/^\+ .*"title": "Joint Hillcrest Park & Example Park Christmas Party"/);
    // Within every run of changed lines, all "-" lines come before any "+" line.
    let seenPlus = false;
    for (const l of lineDiff(base, after).split("\n").slice(1)) { if (l.startsWith("+ ")) seenPlus = true; else if (l.startsWith("- ")) expect(seenPlus, l).toBe(false); else seenPlus = false; }
    // Added and removed entries; meetings link by slug; removal links the list page.
    const add = parseOps(ops2([{ op: "upsert_event", event: TREE_PLANTING }]));
    expect(describeChanges({ events: EVENTS, meetings: MEETINGS }, { events: applyOps("events", EVENTS, add, TREE), meetings: MEETINGS }, add)[0])
      .toMatchObject({ action: "added", path: "/events/tree-planting-nov-2026", title: "Tree planting", fields: expect.arrayContaining([{ field: "Date", before: "", after: "2026-11-08" }]) });
    const rm = parseOps(ops2([{ op: "remove_event", id: "east-bend-2026" }]));
    expect(describeChanges({ events: EVENTS, meetings: MEETINGS }, { events: applyOps("events", EVENTS, rm, TREE), meetings: MEETINGS }, rm)[0]).toMatchObject({ action: "removed", path: "/events", fields: [] });
    const mt = parseOps(ops2([{ op: "upsert_meeting", meeting: { id: "2026-10", title: "Monthly Meeting Notes — October 8 (corrected)" } }]));
    expect(describeChanges({ events: EVENTS, meetings: MEETINGS }, { events: EVENTS, meetings: applyOps("meetings", MEETINGS, mt, TREE) }, mt)[0])
      .toMatchObject({ kind: "meeting", action: "changed", path: "/meetings/october-2026", fields: [{ field: "Title", before: "Monthly Meeting Notes — October 8, 2026", after: "Monthly Meeting Notes — October 8 (corrected)" }] });
  });
});
const ops2 = (o: unknown) => JSON.stringify({ ops: o });

describe("website v0.1 polish: known places, never a copied or invented address", () => {
  const ev = (id: string, location: string, address: string) => ({ id, title: id, date: "2026-12-12", time: "6:00 PM", location, address, description: "", type: "social" });
  const BASE = JSON.stringify({ events: [ev("xmas-2026", "Example Park Community Center", "102 Pine St, Springfield, EX 00000"),
    ev("jane-1", "Plane Jane", "907 Main St, Springfield, EX 00000"), ev("jane-2", "Plane Jane", "107 Walnut Ave, Springfield, EX 00000"),
    ev("east", "East Park Community Center", "East Park Community Center")] }, null, 2) + "\n";
  it("known places: one distinct address per place; ambiguous places and place-name 'addresses' are not known", () => {
    const k = knownPlaces(BASE);
    expect([...k.keys()]).toEqual(["example park community center"]);
    expect(k.get("example park community center")).toMatchObject({ location: "Example Park Community Center", address: "102 Pine St, Springfield, EX 00000" });
  });
  it("an address that repeats the place name: the known address of that exact place, else empty + flagged; a real address is kept", () => {
    const add = (location: string, address: string) => { const o = parseOps(ops2([{ op: "upsert_event", event: { ...ev("test-event", location, address), date: "2026-12-31" } }]));
      const after = applyOps("events", BASE, o, new Set()); return { item: JSON.parse(after).events.at(-1), change: describeChanges({ events: BASE, meetings: MEETINGS }, { events: after, meetings: MEETINGS }, o)[0] }; };
    const o0 = parseOps(ops2([{ op: "upsert_event", event: ev("t0", "Example Park Community Center", "Example Park Community Center") }])), before0 = JSON.stringify(o0);
    applyOps("events", BASE, o0, new Set());
    expect(JSON.stringify(o0)).toBe(before0); // the parsed ops are never mutated (their hash is bound by the approval)
    const known = add("Example Park Community Center", "Example Park Community Center");
    expect(known.item.address).toBe("102 Pine St, Springfield, EX 00000");
    expect(known.change).toMatchObject({ date: "2026-12-31", notes: ["address_from_known_place"] });
    const unknown = add("Community Center", "Community Center"); // the owner's case: the agent copied the place name
    expect(unknown.item.address).toBe("");
    expect(unknown.change.notes).toEqual(["address_not_provided"]);
    expect(add("Plane Jane", "").item.address).toBe(""); // ambiguous place: never guessed
    const real = add("Riverside Park", "104 Maple Ave, Springfield, TN");
    expect(real.item.address).toBe("104 Maple Ave, Springfield, TN");
    expect(real.change.notes).toBeUndefined();
    // Changing only the time of an existing event never touches its address (even a place-name one).
    const t = parseOps(ops2([{ op: "upsert_event", event: { id: "east", time: "7:00 PM" } }]));
    expect(JSON.parse(applyOps("events", BASE, t, new Set())).events.find((e: any) => e.id === "east").address).toBe("East Park Community Center");
  });
});

const CLONE = "/Users/owner/Workspace/example-org/example-org-website";
describe.skipIf(!existsSync(CLONE))("the live files (local clone, read-only)", () => {
  it("parse against the pinned v1 schemas; a no-op is byte-identical; an added event changes only the array tail", () => {
    const ev = readFileSync(`${CLONE}/${WEBSITE_FILES.events}`, "utf8"), mt = readFileSync(`${CLONE}/${WEBSITE_FILES.meetings}`, "utf8");
    const E = parseBase("events", Buffer.from(ev)), M = parseBase("meetings", Buffer.from(mt));
    const first = E.events[0];
    expect(applyOps("events", ev, parseOps(ops([{ op: "upsert_event", event: { id: first.id, time: first.time } }])), new Set())).toBe(ev);
    expect(applyOps("meetings", mt, parseOps(ops([{ op: "upsert_meeting", meeting: { id: M.meetings[0].id, date: M.meetings[0].date } }])), new Set())).toBe(mt);
    const next = applyOps("events", ev, parseOps(ops([{ op: "upsert_event", event: { ...TREE_PLANTING, image: "" } }])), new Set());
    const d = lineDiff(ev, next);
    expect(d.split("\n").filter((l) => /^[-+] /.test(l)).length).toBeLessThanOrEqual(16);
    expect(JSON.parse(next).events.length).toBe(E.events.length + 1);
  });
});
