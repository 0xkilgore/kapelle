// Package F delta A (Fable FABLE-REVIEW-PACKAGE-F-DELTA-A.md): the golden cases for section images (each position, a caption, the
// Outlook fallback) and numbered lists (resumed, continued, mixed). Shared by the unit goldens and the browser layout test.
const S = "https://www.example.org", IMG = `${S}/images/events/block-party.jpg`;
const body = "Over 300 neighbors came out for Block Party.\nThanks to the 24 volunteers who made it happen.";
const sec = (images: unknown[]) => ({ title: "November in Example Park", sections: [{ heading: "Block Party", body, images }] });
const cap = "Neighbors at Block Party, Nov 8 [photo](https://evil.net) **bold** <b>x</b>";
export const F_CASES: Record<string, any> = {
  "image-above": sec([{ url: IMG, alt: "Neighbors at Block Party", caption: cap, position: "above" }]),
  "image-below": sec([{ url: IMG, alt: "Neighbors at Block Party", position: "below" }]),
  "image-left": sec([{ url: IMG, alt: "Neighbors at Block Party", caption: "Block Party 2026", position: "left" }]),
  "image-right": sec([{ url: IMG, alt: "Neighbors \"at\" Block Party", caption: "Block Party 2026", position: "right" }]),
  "lists-mixed": { title: "T", sections: [{ heading: "Agenda", body: "1. Welcome\n\n2. Tree planting\n   Bring gloves.\n\n3. Budget\n\nThen:\n5. Questions\n- Snacks\n- Raffle\n999. Last\n1000. not a list" }] },
};
