// Chat agent slice 1 (PLAN-SLICE-1 §4, Fable R-3 / §12(d)): the slice-1 tool catalog. Four tools, none with an effect:
// no send, publish, website preview or outbox tool exists here (absent, not refused). The JSON Schemas are written out
// literally so their bytes are pinned: toolCatalogHash = digest({version, tools}) is part of the interactive profile's
// identity, so ANY change to a name, description or schema is a new profile and needs its own qualification (R-8).
// The runtime validates arguments itself (C-4); a schema here is what the model is shown, never the authority.
import {digest} from '../../content.js';

const str = (maxLength: number) => ({type: 'string', minLength: 1, maxLength});
const sources = {type: 'array', maxItems: 50, items: {type: 'object', additionalProperties: false, required: ['path', 'line'],
  properties: {path: str(300), line: {type: 'integer', minimum: 1}}}};
const link = {type: 'object', additionalProperties: false, required: ['text', 'url'], properties: {text: str(200), url: str(500)}};
const newsletter = {type: 'object', additionalProperties: false, required: ['title', 'sections', 'sources'], properties: {
  title: str(200),
  sections: {type: 'array', minItems: 1, maxItems: 20, items: {type: 'object', additionalProperties: false, required: ['heading', 'body'],
    properties: {heading: str(200), body: str(4000), links: {type: 'array', maxItems: 10, items: link},
      // Package F delta A-1 (Fable): up to four images per section, each placed above, below, left or right of the text.
      images: {type: 'array', maxItems: 4, items: {type: 'object', additionalProperties: false, required: ['url', 'alt', 'position'],
        properties: {url: str(500), alt: {type: 'string', maxLength: 200}, caption: str(300), position: {type: 'string', enum: ['above', 'below', 'left', 'right']}}}}}}},
  // Package E addendum 2 (Fable E-14): an optional per-issue header photo strip, exactly four image URLs (strings only).
  headerPhotos: {type: 'array', minItems: 4, maxItems: 4, items: str(500)},
  sources}};
// PACKAGE P: the edit tool reuses the entry shapes (a newsletter section, an agenda item) and the list item shapes.
const sectionEntry = (newsletter.properties.sections as {items: Record<string, unknown>}).items;
const imageItem = ((sectionEntry as {properties: {images: {items: unknown}}}).properties.images).items;
const agendaItem = {type: 'object', additionalProperties: false, required: ['title'], properties: {title: str(200), owner: str(100), note: str(1000)}};
const agenda = {type: 'object', additionalProperties: false, required: ['meeting', 'date', 'items', 'sources'], properties: {
  meeting: str(200), date: {type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'},
  items: {type: 'array', minItems: 1, maxItems: 30, items: {type: 'object', additionalProperties: false, required: ['title'],
    properties: {title: str(200), owner: str(100), note: str(1000)}}},
  sources}};
const listValue = {type: 'array', maxItems: 10, items: {anyOf: [str(500), link, imageItem]}};
// PACKAGE P (Fable PP-4): a link the member asked to drop or not use, with the reason shown to the member.
const leaveOut = {type: 'array', maxItems: 10, items: {type: 'object', additionalProperties: false, required: ['url', 'reason'], properties: {url: str(500), reason: str(200)}}};
const edit = {anyOf: [
  {type: 'object', additionalProperties: false, required: ['op', 'field', 'old', 'new'], properties: {op: {type: 'string', enum: ['replace_text']},
    field: {type: 'string', pattern: '^(title|meeting|date|sections\\[[0-9]{1,2}\\]\\.(heading|body)|items\\[[0-9]{1,2}\\]\\.(title|owner|note))$'},
    old: {type: 'string', maxLength: 4000}, new: {type: 'string', maxLength: 4000}}},
  {type: 'object', additionalProperties: false, required: ['op', 'field', 'old', 'new'], properties: {op: {type: 'string', enum: ['set_list']},
    field: {type: 'string', pattern: '^(headerPhotos|sections\\[[0-9]{1,2}\\]\\.(images|links))$'}, old: listValue, new: listValue}},
  {type: 'object', additionalProperties: false, required: ['op', 'after', 'entry'], properties: {op: {type: 'string', enum: ['add_entry']},
    after: {type: 'integer', minimum: -1, maximum: 29}, entry: {anyOf: [sectionEntry, agendaItem]}}},
  {type: 'object', additionalProperties: false, required: ['op', 'index', 'oldTitle'], properties: {op: {type: 'string', enum: ['remove_entry']},
    index: {type: 'integer', minimum: 0, maximum: 29}, oldTitle: str(200)}}]};

export const CHAT_TOOL_NAMES = ['read_org_file', 'search_org_history', 'write_draft_artifact', 'edit_draft_artifact', 'render_newsletter_preview', 'list_site_images'] as const;
export type ChatToolName = typeof CHAT_TOOL_NAMES[number];
export type ChatToolSpec = {name: ChatToolName; description: string; parameters: Record<string, unknown>};

export const CHAT_TOOL_CATALOG: {version: 'kapelle.chat-tools/v1'; tools: readonly ChatToolSpec[]} = Object.freeze({version: 'kapelle.chat-tools/v1', tools: Object.freeze([
  {name: 'read_org_file', description: 'Read lines of one admitted organization file. Returns path#Lx-Ly lines and the file sha256.',
    parameters: {type: 'object', additionalProperties: false, required: ['path'],
      properties: {path: str(300), fromLine: {type: 'integer', minimum: 1}, toLine: {type: 'integer', minimum: 1}}}},
  {name: 'search_org_history', description: 'Search admitted organization files for words. Returns up to 8 short cited line windows.',
    parameters: {type: 'object', additionalProperties: false, required: ['query'],
      properties: {query: str(200), limit: {type: 'integer', minimum: 1, maximum: 8}}}},
  // Package E addendum 2 (Fable E-12..E-15): the inline link syntax and the header photo field are described here (the rules are unchanged).
  {name: 'write_draft_artifact', description: 'Save a new version of a newsletter or agenda draft. Plain text fields only, except that a newsletter body may contain inline links written as [text](https://...); a link is kept only if its exact URL appears in the sources or in the member\'s own messages (or is mailto:hello@example.org). A body line "1. text" starts a numbered list and "- text" a bulleted one. headerPhotos (exactly four) and each section\'s images (up to four; position above, below, left or right, at most one beside the text; alt text; an optional plain caption) must be addresses from list_site_images: call it before placing or swapping photos. For a NEW draft, or when the member asks for a complete rewrite, save the whole draft. To change a saved draft, use edit_draft_artifact instead. Every https link the member gives in their message must be in the draft; if the member asks to drop or not use a link, list it in leaveOut with a short reason (the member sees it). Every source must be a cited path and line.',
    parameters: {type: 'object', additionalProperties: false, required: ['kind', 'content'],
      properties: {kind: {type: 'string', enum: ['newsletter', 'agenda']}, content: {anyOf: [newsletter, agenda]}, leaveOut}}},
  // PACKAGE P (Astra STACK-AND-HARNESS-REVIEW §3; Fable): an exact, atomic edit of the latest saved version; code keeps every other field.
  {name: 'edit_draft_artifact', description: 'Change a saved draft without retyping it: name the latest version and its sha256 (from the save result), then up to 8 edits applied in order. replace_text: in one field (title, meeting, date, sections[N].heading, sections[N].body, items[N].title/owner/note) replace text that occurs exactly once there with new text; old "" sets an empty field. set_list: replace headerPhotos, sections[N].images or sections[N].links, giving their exact current value as old. add_entry: insert a section (or agenda item) after index N (-1 = first). remove_entry: remove the entry at index N whose heading (or title) is oldTitle. Indexes start at 0 and later edits see earlier ones (adding or removing shifts the indexes after it); one field may be named only once per call. Every other field stays exactly as it was; if any edit does not match, nothing changes (a stale version gets the latest version back). If an edit does not match, the error returns the current values of that field and of every list field; retry with exactly those as old. The draft is not a file. Images, links and leaveOut follow the same rules as write_draft_artifact.',
    parameters: {type: 'object', additionalProperties: false, required: ['artifactId', 'parentVersion', 'parentSha256', 'edits'],
      properties: {artifactId: {type: 'string', pattern: '^art_[a-f0-9]{32}$'}, parentVersion: {type: 'integer', minimum: 1},
        parentSha256: {type: 'string', pattern: '^sha256:[a-f0-9]{64}$'}, edits: {type: 'array', minItems: 1, maxItems: 8, items: edit}, leaveOut}}},
  {name: 'render_newsletter_preview', description: 'Render a saved newsletter draft version as a preview for the member.',
    parameters: {type: 'object', additionalProperties: false, required: ['artifactId', 'version'],
      properties: {artifactId: {type: 'string', pattern: '^art_[a-f0-9]{32}$'}, version: {type: 'integer', minimum: 1}}}},
  // Package F delta A-4 (Fable): read-only, from the turn's frozen copy of the website (no fetch at chat time).
  {name: 'list_site_images', description: 'List the website images a newsletter may use: each address with a hint from its file name.',
    parameters: {type: 'object', additionalProperties: false, properties: {}}},
] as ChatToolSpec[])});

/** The catalog identity bound by the interactive profile (and so by every plan card and qualification report). */
export const toolCatalogHash = (c: typeof CHAT_TOOL_CATALOG = CHAT_TOOL_CATALOG) => digest({version: c.version, tools: c.tools});
/** PACKAGE P + evidence-inheritance (A) (Director, brief 0380b436): a team task WITH tools is sent ONLY the two tools it may use
 *  (never the chat catalog, so it never sees a tool it would be refused), and its pins bind exactly that view. A chat-only tool
 *  change then leaves every task pin, report and schedule unchanged. */
export const TASK_TOOL_NAMES = ['read_org_file', 'search_org_history'] as const;
export const TASK_TOOL_CATALOG: typeof CHAT_TOOL_CATALOG = Object.freeze({version: CHAT_TOOL_CATALOG.version,
  tools: Object.freeze(CHAT_TOOL_CATALOG.tools.filter((t) => (TASK_TOOL_NAMES as readonly string[]).includes(t.name))) as readonly ChatToolSpec[]});
export const taskToolCatalogHash = () => toolCatalogHash(TASK_TOOL_CATALOG);
/** The request-body form (OpenAI-compatible function tools). */
export const catalogRequestTools = (c: typeof CHAT_TOOL_CATALOG = CHAT_TOOL_CATALOG) =>
  c.tools.map((t) => ({type: 'function' as const, function: {name: t.name, description: t.description, parameters: t.parameters}}));
