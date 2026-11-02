// Kapelle org review UI (lean runtime). Static, served by the hub; every view reads through the session routes, which the
// org runtime authorizes. All content is inserted as TEXT (never innerHTML). Consequential steps (adopt, approve plan,
// approve member notes) complete a single-use challenge minted by the org runtime for this sign-in (option A: no passkeys;
// approvals need an email-link sign-in from the last hour, and member, policy and address changes are done by Ops).
"use strict";
const org = (location.pathname.match(/^\/o\/([a-z0-9][a-z0-9-]{1,62})\/?/) || [])[1];
const main = document.getElementById("main"), nav = document.getElementById("nav");
let me = null;
// B1: an invite link (/o/<org>/invite#token=...) is read once and removed from the address bar and history straight away.
// The token is in the fragment, so it never reaches any server log.
let inviteToken = /\/invite$/.test(location.pathname) ? new URLSearchParams(location.hash.slice(1)).get("token") : null;
if (inviteToken !== null) history.replaceState(null, "", `/o/${org}/`);
// S1-b (Fable R-6): an authenticator enrollment link (/o/<org>/#totp?token=...) is read once and removed from the address bar
// and history before any request; the page calls enroll.start at most once for it.
let totpToken = /^#totp\?/.test(location.hash) ? new URLSearchParams(location.hash.split("?")[1]).get("token") : null;
if (totpToken !== null) history.replaceState(null, "", `/o/${org}/#totp`);

function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "on") for (const [e, f] of Object.entries(v)) n.addEventListener(e, f);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return n;
}
async function post(path, body) {
  const r = await fetch(`/o/${org}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({ ok: false, error: "unreadable_response" }));
  // A 401 means a signed-in session ended (expired, member removed): show sign-in ONCE. With no session yet (the sign-in page
  // itself calls member.me) re-rendering would call member.me again, loop, and rebuild the email box faster than anyone can
  // click it (CP prod bug 2026-10-16).
  if (r.status === 401 && me) { me = null; render(); }
  return j;
}
const api = (name, body) => post(`api/${name.replaceAll(".", "/")}`, body);
async function sha256(text) { const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return "sha256:" + [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join(""); }
// Volunteers see readable sources, never file names: "[2026-10-08.v1.md#L2]" markers are removed from the answer text and the
// source line reads "Oct 8, 2026 meeting notes" (the citation itself is still validated by the runtime).
const plainAnswer = (a) => String(a).replace(/\s*\[[^\]\s]+\.md#L\d+(-L?\d+)?\]/g, "").trim();
const noteTitle = (path) => { const m = /(\d{4}-\d{2}-\d{2})\.v(\d+)\.md$/.exec(String(path)); return m ? meetingDate(m[1]) + " meeting notes" + (m[2] !== "1" ? " (version " + m[2] + ")" : "") : "the approved notes"; };
const meetingDate = (d) => { try { return new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); } catch { return d; } };
const shortTime = (iso) => { try { return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); } catch { return iso; } };
const words = { access_role_not_permitted: "Your role can't do this.", adopt_already_adopted: "Already adopted.", access_membership_stale: "Membership changed. Sign in again.",
  hub_no_session: "Please sign in.", access_challenge_consumed: "That approval was already used. Try again.", notes_approval_mismatch: "The notes changed after you approved. Try again.",
  access_session_not_fresh: "Approvals need a sign-in from the last hour. We can email you a fresh link.",
  access_step_up_required: "This needs an extra check that isn't available yet. Ask an admin.",
  access_challenge_session_mismatch: "That approval was started in a different sign-in. Try again.",
  hub_length_required: "The upload didn't say how large the recording is. Try again from this page.",
  transcription_not_configured: "Transcription isn't set up for this org.", transcription_no_policy: "No transcription policy is approved yet, so recordings can't be transcribed. Ask an admin.",
  transcription_policy_profile_mismatch: "The transcription setup changed. Reload and try again.", transcription_profile_not_qualified: "Transcription isn't available yet (the service isn't qualified).",
  transcription_monthly_cap_exceeded: "This org's transcription budget for the month is used up.", transcription_job_cap_exceeded: "That recording is too long to transcribe in one job.",
  transcription_reservation_failed: "Transcription couldn't start. Try again.", transcript_attestation_required: "Fill in the recording notice first.",
  transcript_job_unknown: "That recording can't be found. Reload.", transcript_job_state: "That recording isn't in a state for this. Reload.",
  transcript_audio_digest_mismatch: "The recording changed. Reload and try again.", transcript_audio_missing: "The audio has been deleted, so it can't be transcribed.",
  transcript_part_unknown: "That transcript part doesn't exist.", transcript_discarded: "Discarded.", transcription_output_empty: "No speech was found in the recording.",
  transcription_internal_error: "Transcription failed on our side. Try again.", transcription_write_interrupted: "The transcript couldn't be saved. Try again.",
  transcription_outcome_unknown_after_restart: "The service restarted mid-transcription; an admin will check it.", media_retention_expired: "The audio expired before it was transcribed.",
  adopt_transcript_parts_invalid: "Pick a valid range of parts.", adopt_transcript_parts_overlap: "Some of those parts are already in another Task. Pick parts that aren't adopted yet.", adopt_transcript_parts_over_cap: "That's too much for one plan: pick at most 7 parts (about 110 KB).",
  media_type_not_admitted: "That isn't an audio file we can use (WAV, MP3, M4A, Ogg, WebM or FLAC).", media_too_large: "That recording is larger than the upload limit.",
  media_too_long: "That recording is longer than the limit.", media_duration_unknown: "We couldn't tell how long that recording is. Try exporting it as M4A or MP3.",
  media_duration_implausible: "That file doesn't look like a normal recording. Try exporting it again.", media_size_mismatch: "The upload was incomplete. Try again.",
  media_upload_session_mismatch: "Start the upload again from this page.", media_upload_unknown: "Start the upload again from this page.", media_upload_expired: "The upload took too long to start. Try again.",
  media_upload_consumed: "Start the upload again from this page.", media_upload_rate_limited: "Too many uploads in an hour. Try again later.", media_upload_aborted: "The upload stopped. Try again.",
  media_file_name_invalid: "Rename the file and try again.", access_bootstrap_not_empty: "This organization is already set up. Ask for a new invitation." };
// N-5: every refusal a session can receive has words (tests/ui-labels.test.ts scans the runtime and hub sources).
// WC-2: the website copy (the last good copy is always kept on a failure).
Object.assign(words, { website_content_refresh_cap: "The website copy has been refreshed as many times as allowed today. Try again tomorrow.",
  website_content_deadline: "GitHub took too long to answer. The last copy is kept.", website_content_too_large: "The website content is too large to copy. The last copy is kept.",
  website_content_malformed: "The website's data couldn't be read. The last copy is kept.", website_content_failed: "The website copy couldn't be updated. The last copy is kept.",
  website_content_path_reserved: "That folder holds the website copy and can't be written to.",
  chat_no_files: "No files are connected yet.",
  // AGENT-HANDBOOK-V1 H2: the handbook store and actions.
  handbook_oversize: "The handbook is over 6 KiB. Shorten it, then preview again.", handbook_approval_conflict: "Someone approved a newer version, or the text changed. Reload and preview again.",
  handbook_input_invalid: "The handbook text is empty or has characters it can't keep.", handbook_not_enabled: "The agent handbook isn't switched on for this organization.",
  handbook_digest_mismatch: "The text changed after the preview. Preview again, then approve.",
  // AGENT-HANDBOOK-V1 H1 (Fable B-4): chat refusals at turn start (nothing was sent).
  chat_handbook_missing: "The agent's handbook isn't approved yet, so chat is paused. Ask a reviewer.", chat_system_map_unavailable: "The agent couldn't describe this app's setup for this chat. Ask an admin.",
  totp_not_configured: "Authenticator codes aren't set up for this organization.", totp_key_unavailable: "Authenticator codes are unavailable here. Ask an admin for a new setup link.",
  totp_enroll_token_invalid: "This setup link isn't valid any more. Ask an admin for a new one.", totp_enroll_not_pending: "There's no setup in progress. Ask an admin for a new setup link.",
  totp_enroll_codes_invalid: "Those codes didn't match. Enter the code your app shows, then the next one.", totp_not_enrolled: "Set up your authenticator first.",
  totp_code_invalid: "That code didn't work. Enter the current code from your app.", totp_factor_locked: "Too many wrong codes. Ask an admin to set up your authenticator again.",
  totp_clock_skew: "This server's clock is behind. Ask an admin to check it.", totp_mint_rate_limited: "Too many attempts this hour. Try again later.",
  newsletter_release_unknown: "That newsletter release can't be found.", newsletter_release_changed: "The newsletter changed since you opened it. Review it again.",
  newsletter_release_state: "This newsletter release was already approved.", newsletter_killed: "Newsletter sending is paused for now.",
  newsletter_uncertain_release: "An earlier release's outcome isn't settled yet. An admin must check it first.",
  newsletter_approver_not_permitted: "You aren't one of the newsletter's approvers.", newsletter_slug_invalid: "The release needs a dated name (YYYY-MM-DD-…).",
  newsletter_slug_reused: "That release name was already used for different content.", newsletter_history_incomplete: "The send history isn't complete, so sending is held.",
  newsletter_duplicate: "This exact newsletter was already sent.", newsletter_test_missing: "Send yourself a test of this exact newsletter first.",
  newsletter_test_mismatch: "Your latest test is of a different version. Send a new test.", newsletter_test_wrong_recipient: "The test must go to your own address.",
  newsletter_test_stale: "Your test is more than a day old. Send a new test.", newsletter_preflight_failed: "The image check didn't pass for this version.",
  newsletter_images_unserved: "Some images aren't live on the website yet.", newsletter_transfer_missing: "Sending isn't switched over to this app yet.",
  newsletter_installation_not_authorized: "This installation isn't the authorized sender.", newsletter_suppression_stale: "Unsubscribes haven't been checked in the last day. Reload the release card to check again.",
  newsletter_recipients_unknown: "The subscriber list can't be read right now.", newsletter_recipients_changed: "Subscribers were added since approval. Review it again.",
  newsletter_release_cap: "This month's release limit is reached.", newsletter_package_invalid: "That newsletter package isn't complete.",
  newsletter_test_cap: "Too many tests today. Try again tomorrow.", newsletter_overrun: "The send reached more people than approved. The admins have been emailed.",
  newsletter_test_not_configured: "Test emails aren't set up yet.", newsletter_test_cooldown: "A test went out a moment ago. Wait five minutes before the next one.",
  newsletter_test_unknown: "We couldn't confirm the last test went out. Send another test.", newsletter_test_preview_only: "That test was a preview. A release needs a test sent the release way.",
  newsletter_test_refused: "The test email was refused. Nothing was sent.",
  hub_preview_invalid: "That preview link isn't valid. Open the draft again.",
  newsletter_unsubscribe_invalid: "This newsletter's unsubscribe link isn't in the right form. Prepare it again.",
  newsletter_image_changed: "An image in this newsletter changed on the website since it was prepared. Prepare it again, then send a new test.",
  newsletter_test_recipient_skipped: "One of the extra test addresses isn't an active admin, so it was skipped.",
  newsletter_sender_invalid: "The newsletter's test sender isn't on the same domain as its From address.",
  newsletter_link_hosts_invalid: "The newsletter's list of extra link websites isn't valid.", newsletter_attestation_required: "Confirm you received and checked the latest test.",
  newsletter_sender_not_configured: "The newsletter's sender isn't set up yet.", newsletter_draft_unavailable: "Preview the draft first, then prepare the release.",
  newsletter_manifest_unwritable: "The send record couldn't be written. Nothing was sent.", newsletter_draft_mismatch: "The draft at the provider didn't match. Nothing was sent.",
  newsletter_provider_refused: "The email provider refused. Nothing was sent.", newsletter_provider_uncertain: "We couldn't confirm what the provider did. An admin will check.",
  newsletter_count_unknown: "The recipient count couldn't be confirmed. An admin will check.", newsletter_restore_reconcile: "Sending is paused until an admin checks the send record.",
  newsletter_create_ambiguous: "More than one matching draft exists. An admin will check.", newsletter_create_absent: "The draft was never created. Approve the release again.",
  newsletter_draft_held: "The draft is waiting for a person to check it.", newsletter_history_unavailable: "The send history couldn't be read completely. Sending is held.",
  newsletter_history_import_invalid: "That history file isn't valid.", chat_title_invalid: "Write a title of 1 to 120 characters." });
Object.assign(words, { chat_not_configured: "Chat isn't set up for this org yet.", chat_turn_busy: "Another run is in progress (a chat answer or a team task). Try again in a moment.",
  chat_daily_allowance: "You've used today's chat turns. Try again tomorrow.", chat_text_invalid: "Write a message of up to 8,000 characters.", chat_conversation_unknown: "That chat can't be found. Reload.",
  chat_turn_unknown: "That reply can't be found. Reload.", chat_client_request_reused: "Reload and try again.", chat_client_request_invalid: "Reload and try again.",
  chat_scope_not_permitted: "Only reviewers can start a reviewer chat.", chat_stopped_by_member: "Stopped.", chat_turn_interrupted: "The service restarted during this reply. Ask again.",
  chat_member_inactive: "Your membership changed. Sign in again.", chat_cap_requests: "That needed more steps than one reply allows. Ask a narrower question.",
  chat_cap_tools: "That needed more file reads than one reply allows. Ask a narrower question.", chat_tool_calls_too_many: "That needed more file reads at once than one reply allows. Ask a narrower question.", chat_cap_wall: "That took too long. Ask a narrower question.",
  chat_cap_usd: "That reply hit its cost limit.", chat_org_cap: "This organization's monthly model budget is used up.", chat_cap_context: "That read too much text for one reply.",
  chat_tool_refused: "The agent kept asking for something it can't do. Try rephrasing.", chat_profile_not_qualified: "Chat isn't available yet (the model profile isn't qualified).",
  chat_output_truncated: "The answer was too long. Ask for less.", chat_draft_card_stale: "The files changed since this plan was made. Make a new plan.",
  chat_draft_card_expired: "That plan expired. Make a new plan.", chat_draft_digest_mismatch: "The plan changed. Make a new plan.", chat_draft_capability_invalid: "That kind of draft isn't available.",
  chat_upload_type_not_admitted: "Only .md, .txt, .csv, Word (.docx) and web page (.html) files can be added.",
  chat_upload_unreadable: "That file couldn't be read. Save it again as .docx, or paste the text.", chat_upload_too_large: "That file is over 48 KB.", chat_upload_empty: "That file is empty.",
  chat_upload_exists: "A different file with that name is already in this chat.", chat_upload_limit: "You've reached the upload limit.", chat_upload_unknown: "That upload can't be found.",
  chat_artifact_unknown: "That draft version has no preview yet.", chat_turn_failed: "That reply didn't finish.", files_unknown: "That file can't be found.", files_too_large: "That file is too large to show here.",
  website_not_configured: "The website pack isn't set up for this org.", website_text_invalid: "Write the change in up to 2,000 characters.",
  website_daily_request_cap: "Today's limit of website requests is reached. Try again tomorrow.", website_daily_apply_cap: "Today's limit of website changes is reached. Try again tomorrow.",
  website_pr_closed: "That draft pull request was closed or merged on GitHub, so nothing was added. Ask again to open a new one.",
  website_branch_moved: "The draft pull request changed or was removed on GitHub after this was shown. Reload and approve again, or ask again.",
  website_request_not_ready: "That change isn't ready to approve.", website_request_discarded: "That proposal was discarded.", website_already_applied: "That change was already approved.", website_apply_digest_mismatch: "The change was updated. Reload and approve again.",
  website_request_unknown: "That request can't be found. Reload.", website_pr_unknown: "There's no pull request for that change yet.", website_pr_not_resumable: "Nothing to resume.",
  website_ops_not_json: "The agent's answer wasn't a change it could make. Try rephrasing.", website_ops_invalid: "The agent proposed something outside events and meeting notes. Try rephrasing.",
  website_content_unsafe: "The proposed text contained something the website can't safely show (HTML or a non-https link).", website_image_missing: "That image isn't on the website yet.",
  website_op_incomplete: "A new event or meeting needs every field (title, date, time, place, description).", website_op_target_unknown: "That event or meeting isn't on the website.",
  website_base_shape_changed: "Website changes are paused for now: the website's data changed and the setup needs an update. Admins see this on the Manage page.", website_base_missing: "The website's data files couldn't be read.",
  website_request_not_applicable: "That doesn't look like a change to events or meeting notes.", website_no_change: "That's already what the website says.",
  website_request_interrupted: "The service restarted while preparing this. Ask again.", image_proposal_not_checked: "Save the checked flyer details first; only your own checked flyer can go to the website.",
  teamtask_plan_changed: "The task or its plan changed since you looked. Reload, then plan or approve again.", teamtask_plan_expired: "That plan expired. Plan the work again.",
  teamtask_scope_not_permitted: "That isn't something you can do for this task.", teamtask_tool_not_admitted: "Running tasks isn't switched on for this organization yet.",
  teamtask_queue_full: "Too many approved tasks are waiting. Try again when some have run.", teamtask_budget_exhausted: "The run hit its limit before finishing.",
  teamtask_claim_consumed: "That plan was already approved.", teamtask_result_unverified: "There's no checked result to mark done yet.",
  teamtask_outcome_uncertain: "A run's outcome is unconfirmed. An admin checks it before new work can start.", teamtask_audience_not_permitted: "That task can't be found.",
  teamtask_adoption_refused: "Only what you typed and your own text files from that chat can go into a task.", teamtask_attempt_active: "This task already has a plan approved or running.",
  teamtask_closed: "This task is already done or cancelled.", teamtask_input_invalid: "Check the task: a title (one line, up to 200 characters), notes up to 4,000 characters, and a revision note short enough to fit the plan.",
  teamtask_cancelled: "Cancelled.", teamtask_paused: "Team tasks are paused by an admin.",
  teamtask_reconcile_refused: "An admin's check of this run didn't settle it yet. Nothing is retried.",
  // SCHEDULED-TASKS-V1 (S2): the fixed schedule labels in plain words (history, notices and refusals).
  teamtask_schedule_expired: "This schedule reached its end date. A reviewer can approve a new one.", teamtask_schedule_pin_changed: "Paused: the agent's setup changed since the schedule was approved. A reviewer reviews it again.",
  teamtask_schedule_source_refused: "The schedule's files couldn't be used (missing, too many, or not visible to its audience). Nothing ran.",
  teamtask_schedule_budget_exhausted: "This schedule's monthly budget is used up. It resumes next month or when a reviewer resumes it.",
  teamtask_schedule_missed: "Missed: the run couldn't start within a day.", teamtask_schedule_no_new_sources: "Skipped: no new notes since the last draft.",
  teamtask_schedule_paused: "Paused.",
  website_image_changed: "The flyer image changed after it was prepared. Ask again.", website_image_target_ambiguous: "The flyer image needs exactly one event to go with. Ask for one event.",
  website_image_conflict: "The website already has a different image under that name. Ask an admin.", website_image_too_large: "That image is too large for the website.",
  website_image_readback_failed: "GitHub didn't show the image in the change yet. An admin will check it.", website_base_moved: "The website changed on GitHub since this was prepared. Ask again for a fresh change.",
  website_branch_conflict: "A different change already uses this branch. Ask an admin.", website_outcome_unknown_after_restart: "The service restarted while opening the PR. An admin will check it.",
  website_file_too_large: "The change makes a data file too large.", website_base_too_large: "A website data file is too large to edit here.",
  intake_not_configured: "Email submission isn't set up for this org. Add meeting notes on the Review page.",
  intake_text_required: "Paste the notes or choose a .md or .txt file first.", intake_text_too_large: "That's more than 48 KB of text. Split it into two submissions.",
  intake_file_type_not_admitted: "Only .md, .txt, Word (.docx) and web page (.html) files can be added.", intake_client_request_invalid: "Reload the page and try again.",
  intake_payload_conflict: "That submission was already sent with different text. Reload and try again.", intake_file_changed: "That submission was already stored. Reload.",
  adopt_intake_unknown: "That submission is no longer available.", intake_installation_unknown: "Email submission isn't set up for this org.",
  notes_file_invalid: "Those notes can't be found.", notes_report_unknown: "That draft can't be found. Reload and try again.", notes_invalid: "The notes are empty or too long.",
  notes_version_exists: "Someone approved these notes at the same moment. Reload to see the latest version.", plan_agent_unavailable: "The notes preparer isn't available right now.",
  reply_policy_approval_mismatch: "The reply policy changed after you approved. Try again.", reply_policy_invalid: "That reply policy isn't valid.",
  reply_policy_member_not_active: "The policy names someone who isn't an active member.",
  access_action_unknown: "This action isn't available.", access_action_not_installed: "This action isn't available.", access_not_consequential: "This action isn't available.",
  access_artifact_digest: "What you approved doesn't match what was sent. Try again.", access_body_hash: "What you approved doesn't match what was sent. Try again.",
  access_challenge_binding: "What you approved doesn't match what was sent. Try again.", access_authorization_mismatch: "What you approved doesn't match what was sent. Try again.",
  access_authorization_unknown: "That approval wasn't recognised. Try again.", access_challenge_unknown: "That approval wasn't recognised. Try again.",
  access_challenge_expired: "That approval took too long. Try again.", access_assertion_malformed: "Your passkey response couldn't be read. Try again.",
  access_credential_unknown: "This passkey isn't registered for your account.", access_credential_malformed: "Your passkey response couldn't be read. Try again.",
  access_credential_duplicate: "This passkey is already registered.", access_no_passkey: "Your account has no passkey yet.", access_identity_mismatch: "That passkey belongs to someone else.",
  access_cannot_remove_self: "You can't remove yourself.", access_member_exists: "That person is already a member.", access_member_inactive: "Your membership isn't active.",
  access_invite_consumed: "That invite was already used.", access_invite_expired: "That invite has expired. Ask for a new one.", access_invite_invalid: "That invite link isn't valid.",
  access_invite_replayed: "That invite was already used.", access_invite_unknown: "That invite link isn't valid.",
  access_operation_conflict: "That was already done with different details. Reload and try again.", access_operation_id: "Something went wrong. Reload and try again.",
  access_wrong_audience: "Something went wrong. Reload and try again.", access_wrong_installation: "Something went wrong. Reload and try again.", access_wrong_org: "Something went wrong. Reload and try again.",
  access_body_malformed: "Something went wrong. Reload and try again.", access_body_too_large: "That is too large to send.", access_internal_error: "Something went wrong on our side. Try again.",
  hub_body_malformed: "Something went wrong. Reload and try again.", hub_body_too_large: "That is too large to send.", hub_content_type_refused: "Something went wrong. Reload and try again.",
  hub_cross_site_refused: "Blocked: that request didn't come from this page.", hub_error: "Something went wrong on our side. Try again.", hub_link_invalid: "That sign-in link has expired or was already used.",
  hub_not_found: "Not found.", plan_material_archived: "That submission was archived. Ask an admin to restore it.", adopt_intake_archived: "That submission was archived. Ask an admin to restore it.", hub_rate_limited: "Too many attempts. Wait a few minutes and try again.", plan_task_not_adopted: "Adopt the submission before preparing a plan.", plan_material_too_large: "That submission is too large to prepare in one plan.",
  plan_intake_folder_full: "Too many submissions are stored. Ask an admin to archive older ones.", plan_material_unavailable: "The submission could not be read for a plan.", approve_plan_digest_mismatch: "The plan changed after you approved. Reload and try again.", setup_changed: "Paused: the setup changed since the org started. Ask an admin to restart it.", unreadable_response: "The service sent an unreadable answer. Try again." });
// IMAGES-V1 I1: flyer/image attachments.
Object.assign(words, { image_too_large: "That image is over 4 MB. Save a smaller copy and try again.",
  image_type_not_admitted: "Only JPEG, PNG or WebP images can be attached.", image_type_mismatch: "That file isn't the kind of image its name says. Save it as JPEG or PNG and try again.",
  image_unreadable: "That image couldn't be read. Save it again as JPEG or PNG and retry.", image_too_many_pixels: "That image is too large (over 20 megapixels). Save a smaller copy.",
  image_dimensions: "That image is too wide or tall (over 10,000 pixels on a side).", image_animated: "Animated images can't be attached. Use a still image.",
  image_output_too_large: "That image is too detailed to shrink enough. Crop it and try again.", image_upload_rate_limited: "Too many images this hour. Try again later.",
  image_limit: "You've reached the limit of stored images. Delete an old chat first.", image_org_storage_full: "The organization's image storage is full. Ask an admin.",
  image_upload_unknown: "Start the upload again from this chat.", image_upload_consumed: "Start the upload again from this chat.", image_upload_expired: "The upload took too long to start. Try again.",
  image_upload_session_mismatch: "Start the upload again from this chat.", image_size_mismatch: "The upload was incomplete. Try again.", image_upload_aborted: "The upload stopped. Try again.",
  image_decoder_unavailable: "Image attachments aren't available right now. Try again later.", image_decoder_timeout: "That image took too long to process. Try a smaller copy.",
  image_unknown: "That image can't be found.", image_not_configured: "Image attachments aren't set up for this organization.",
  image_decoder_usage: "That image couldn't be processed. Try again.", image_output_unwritable: "That image couldn't be saved. Try again.",
  image_upload_busy: "Several images are uploading right now. Try again in a moment.",
  image_extract_unreadable: "The flyer couldn't be read clearly. Check the details yourself or try a sharper photo.", image_extract_cap: "You've read as many flyers as allowed today. Try again tomorrow.",
  image_extract_org_cap: "The organization's flyer reading limit is reached for now.", image_extract_busy: "A flyer is already being read. Wait for it to finish.",
  image_extract_not_configured: "Reading flyers isn't set up for this organization.", image_profile_not_qualified: "Reading flyers isn't available yet (the model profile isn't qualified).",
  image_proposal_unknown: "Those details can't be found. Reload.", image_proposal_invalid: "Check the details: a date is YYYY-MM-DD; fields have length limits.",
  image_request_invalid: "That image couldn't be sent. Try attaching it again.", image_request_too_large: "That image is too large to send for reading.",
  image_tool_calls_refused: "The model answered in a way that isn't allowed. Nothing was done; try again.", image_extract_interrupted: "The service restarted while reading this flyer. An admin will check it.",
  // J2 (Add photos).
  website_photos_invalid: "Choose up to 6 different photos, at most one as the event's picture (and none with a flyer).", website_gallery_missing: "The website's events file has no photo gallery list to add to.",
  image_attached: "Image attached. Its location and camera details were removed; only you can see it here.", image_attached_again: "That image is already in this chat.",
  // PACKAGE P (Fable PP-6): the draft-edit refusals (shown wherever a tool call's label is shown).
  draft_edit_stale: "The draft changed in the meantime; the agent edits the latest version.", draft_edit_not_found: "That text isn't in the draft any more.",
  draft_edit_ambiguous: "That text appears more than once in the draft; the agent has to be more exact.", draft_edit_field_unknown: "That part of the draft doesn't exist.",
  draft_edit_conflict: "Two changes named the same part of the draft at once.", draft_member_link_missing: "A link you gave isn't in the draft yet.",
  // LIBRARY L1: the shared drive.
  drive_name_invalid: "Give the image a plain name: letters, numbers, spaces, dots, dashes (up to 80).", drive_limit: "You've added as many files to the shared drive as allowed. A reviewer can remove old ones.",
  drive_image_unknown: "That image isn't in the shared drive any more. Reload.", drive_image_unreadable: "That image couldn't be read. An admin will check it.",
  drive_image_published: "This image is in a newsletter, so it is public. An admin has to unpublish it first.", drive_not_available: "Images in the shared drive aren't set up for this organization.",
  drive_store_failed: "The image couldn't be saved. Try again.", drive_saved: "Saved to the shared drive. Everyone in the organization can see it; it is not public.",
  drive_saved_again: "That image is already in the shared drive.",
  // LIBRARY L2: publishing drive images with a release.
  newsletter_release_needs_publish: "This draft uses photos from the shared drive. Reload the page and prepare it again to put them online.",
  newsletter_publish_list_changed: "The draft's images changed. Reload and check the list again.", newsletter_release_no_drive_images: "This draft has no shared-drive images to publish.",
  files_public_route_off: "Shared-drive images can't be used in a newsletter yet (the public files address isn't set up).",
  files_used_in_sent_newsletter: "A sent newsletter uses this image. Unpublishing breaks it in those emails; confirm the override to go ahead.",
  files_not_public: "That image isn't public." });
// Why a question got no answer (the turn is recorded either way).
const askReasons = { kit_scope_scope_has_no_admissible_files: "There are no approved notes to answer from yet. See “How notes get here” on this page.", kit_scope_scope_directory_missing: "There are no approved notes to answer from yet. See “How notes get here” on this page.",
  hosted_monthly_cap_exceeded: "This org's question budget for the month is used up.", hosted_run_cap_exceeded: "That question needed more than one answer's budget." };
// Families of service-to-service faults: the reader gets one honest sentence, not the code.
const families = [["access_envelope_", "The service had a problem. Try again in a moment."], ["hub_runtime_", "The service had a problem. Try again in a moment."],
  // Fable T2b N-1: any other model-service label in plain words, never the raw code.
  ["hosted_", "The model service couldn't complete the request."]];
const say = (code) => words[code] || (families.find(([f]) => String(code).startsWith(f)) || [])[1] || "That didn't work (" + code + ").";
const reasons = { trigger_no_policy: "No reply policy approved yet", trigger_member_not_permitted: "Member not covered by the reply policy", trigger_org_killed: "Replies paused for this org",
  member_stopped: "Member asked to stop", trigger_auto_submitted: "Automatic email (ignored)", trigger_bulk_precedence: "Bulk or list email (ignored)", trigger_follow_up_cap: "Follow-up limit reached",
  trigger_member_rate_cap: "Daily limit reached for this member", trigger_org_rate_cap: "Daily limit reached for the org", policy_pin_mismatch: "Paused: setup changed since the policy was approved",
  reply_not_answered: "No answer could be prepared", reply_secret_content: "Blocked: looked like a secret", reply_link_or_markup: "Blocked: contained a link", reply_contains_address: "Blocked: contained an email address",
  reply_too_long: "Blocked: too long", reply_citation_invalid: "Blocked: a source didn't check out", recheck_failed: "Blocked at the last check", reply_interrupted_not_regenerated: "Interrupted; not retried",
  trigger_not_verified_intake: "Not a verified submission", generation_in_progress: "Preparing…" };
const reasonText = (r) => r ? (reasons[r] || r) : null;
Object.assign(words, { notes_unedited_private_draft: "That is the private draft unchanged. Edit it into notes for members first.",
  notes_private_terms_unconfirmed: "The notes still contain private-looking items. Remove them, or tick the confirmation." });
// Mirrors the runtime's PRIVATE_MARKERS (the runtime is the one that enforces them).
const PRIVATE = [/reviewers-private/i, /REVIEWERS-ONLY/i, /^\s*[-*]?\s*QUESTION:/im, /\(not approved\)/i, /\(tentative/i, /^\s*[-*]?\s*(Idea|Offer|Proposed follow-up)\b/im, /\$\s?\d/];
const hasPrivate = (t) => PRIVATE.some((r) => r.test(t));

/** Consequential action: a runtime challenge bound to this sign-in and the exact body/digest, then the action itself. */
async function approve(action, body, artifactDigest) {
  const operationId = crypto.randomUUID();
  const ch = await post("challenge", { action, body, artifactDigest: artifactDigest || null, operationId });
  if (!ch.ok) return ch;
  return post("act", { challengeId: ch.challengeId, action, body, artifactDigest: artifactDigest || null, operationId });
}
/** A refusal as a notice; a stale sign-in also offers a fresh link to the member's own address. */
function refusal(r) {
  if (r.error !== "access_session_not_fresh") return notice(say(r.error), true);
  const out = el("div", { "aria-live": "polite" }), b = el("button", { type: "button", class: "btn secondary" }, "Email me a fresh sign-in link");
  b.addEventListener("click", busy(b, async () => { await post("login", { email: me.email }); out.replaceChildren(notice("Sent to " + me.email + ". Open the link, then approve again.")); }));
  return el("div", {}, notice(say(r.error), true), el("div", { class: "row" }, b), out);
}
const how = (authn) => ({ "email-session": "email sign-in link", "ops-socket": "an admin, on the server", passkey: "passkey", totp: "authenticator app" })[authn] || "sign-in";
function markdown(md) {
  const box = el("div", { class: "doc" }); let ul = null;
  for (const line of String(md || "").split("\n")) {
    if (/^- /.test(line)) { if (!ul) { ul = el("ul"); box.append(ul); } ul.append(el("li", {}, line.slice(2))); continue; }
    ul = null;
    if (/^## /.test(line)) box.append(el("h2", {}, line.slice(3)));
    else if (/^# /.test(line)) box.append(el("h1", {}, line.slice(2)));
    else if (line.trim()) box.append(el("p", {}, line));
  }
  return box;
}
const busy = (btn, fn) => async () => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };
const notice = (text, error) => el("div", { class: "notice" + (error ? " error" : ""), role: error ? "alert" : "status" }, text);

// ---- views ----
function loginView() {
  const email = el("input", { type: "email", id: "email", autocomplete: "email", required: true });
  const out = el("div");
  const btn = el("button", { class: "btn", type: "submit" }, "Email me a sign-in link");
  const form = el("form", { class: "card", on: { submit: async (e) => { e.preventDefault(); btn.disabled = true;
    await post("login", { email: email.value }); out.replaceChildren(notice("If that address belongs to a member, a sign-in link is on its way.")); btn.disabled = false; } } },
    el("label", { for: "email" }, "Your email"), email, el("div", { class: "row" }, btn), out);
  return [el("h1", {}, "Sign in"), el("p", { class: "lede" }, "Members only. We'll email you a link."), form];
}
/** Invite acceptance (option A): the one-time link is the proof of the invited mailbox, as a sign-in link is. Joining admits
 *  the member and signs them in; the page never stores the token. */
async function inviteView() {
  // Who invited whom to what: server-held facts only (nothing is consumed until they choose to join).
  const info = await post("invite/info", { token: inviteToken });
  if (!info.ok) return [el("h1", {}, "This invitation can't be used"), notice(say(info.error), true),
    el("p", { class: "note" }, "Ask the person who invited you for a new link.")];
  document.getElementById("org-label").textContent = info.orgLabel;
  const role = { admin: "an administrator", reviewer: "a reviewer", contributor: "a contributor" }[info.role] || "a member";
  const title = info.firstAdmin ? "Set up " + info.orgLabel : (info.invitedBy || "An administrator") + " invited you to " + info.orgLabel;
  const who = info.firstAdmin ? "You are the first administrator of " + info.orgLabel + " (" + info.email + ")." : "You'll join as " + role + " (" + info.email + ").";
  const out = el("div", { "aria-live": "polite" });
  const btn = el("button", { class: "btn", type: "button" }, "Join " + info.orgLabel);
  btn.addEventListener("click", busy(btn, async () => {
    const r = await post("invite/accept", { token: inviteToken });
    if (!r.ok) return out.replaceChildren(notice(say(r.error), true));
    inviteToken = null; me = null;
    await render();
  }));
  return [el("h1", {}, title), el("p", { class: "lede" }, who),
    el("div", { class: "card" },
      el("p", {}, "Joining signs you in on this device. Next time, sign in with a link we email to " + info.email + ". There is no password."),
      el("div", { class: "row" }, btn), out),
    el("p", { class: "note" }, "Didn't expect this? Close this page. Nothing happens unless you join.")];
}
/** Admins: member changes are done by Ops until an authenticator-app check exists (option A). */
function membersView() {
  if (me.role !== "admin") return [el("h1", {}, "Members"), notice(say("access_role_not_permitted"), true)];
  return [el("h1", {}, "Members"), el("p", { class: "lede" }, "Inviting and removing members, and changing roles, is done on the server for now."),
    el("div", { class: "card" }, el("p", {}, "Share the person's email and role with whoever runs your server; they send the invitation link."),
      el("p", { class: "note" }, "An authenticator-app check for these changes is planned; then they move here."))];
}
async function notesView() {
  const files = (await api("notes.read")).result?.files || [];
  const byDate = [...new Set(files.map((f) => f.slice(0, 10)))].sort().reverse();
  // Owner feedback (CP prod): with no approved notes, explain the path instead of a bare "no notes" answer.
  const reviewerRole = ["admin", "reviewer"].includes(me.role);
  const empty = el("div", { class: "card", id: "notes-empty" }, el("h3", {}, "No meeting notes have been approved yet"),
    el("p", {}, "Questions are answered only from approved notes, so there is nothing to answer from yet. How notes get here:"),
    el("ol", { class: "steps" }, el("li", {}, "A reviewer adds the meeting notes on the Review page (paste them or choose a file)."),
      el("li", {}, "They adopt the submission and prepare a plan; the agent drafts private notes from it."),
      el("li", {}, "A reviewer approves the plan."),
      el("li", {}, "A reviewer edits the draft and approves what members should see. It appears here, and questions work.")),
    reviewerRole ? el("div", { class: "row" }, el("a", { class: "btn", href: "#review" }, "Go to Review"))
      : el("p", { class: "note" }, "Ask a reviewer or admin to add the latest meeting notes."));
  const reader = files.length ? el("div", { class: "card" }, el("p", { class: "note" }, "Choose a meeting.")) : empty;
  const open = async (date) => {
    const latest = files.filter((f) => f.startsWith(date)).sort((a, b) => Number(b.match(/\.v(\d+)\./)[1]) - Number(a.match(/\.v(\d+)\./)[1]))[0];
    const r = await api("notes.get", { file: latest });
    const version = Number(latest.match(/\.v(\d+)\./)[1]);
    reader.replaceChildren(el("div", { class: "row" }, el("span", { class: "tag ok" }, "Approved"), el("span", { class: "note" }, meetingDate(date) + (version > 1 ? " · version " + version : ""))), markdown(r.result?.markdown));
  };
  const list = el("ul", { class: "list" }, byDate.map((d) => { const b = el("button", { class: "secondary", type: "button" }, "Read");
    b.addEventListener("click", () => open(d)); const n = files.filter((f) => f.startsWith(d)).length;
    return el("li", { class: "item" }, el("div", {}, el("h3", {}, "Meeting · " + meetingDate(d)), el("div", { class: "meta" }, n > 1 ? n + " approved versions" : "Approved")), b); }));
  const q = el("input", { type: "text", id: "q", placeholder: "When is the cleanup?" }), out = el("div", { class: "answer", "aria-live": "polite" });
  const ask = el("button", { class: "btn", type: "submit" }, "Ask");
  const form = el("form", { class: "card", on: { submit: async (e) => { e.preventDefault(); ask.disabled = true; out.replaceChildren(el("p", { class: "note" }, "Reading the approved notes…"));
    const r = await api("agent.ask", { question: q.value }); ask.disabled = false;
    if (!r.ok) return out.replaceChildren(notice(say(r.error), true));
    const t = r.result; out.replaceChildren(el("p", {}, t.answer ? plainAnswer(t.answer) : askReasons[t.reason] || "No answer."), ...(t.citations || []).filter((c) => c.valid).map((c) => el("div", { class: "cite" }, "Source: " + noteTitle(c.path) + ", line " + c.startLine))); } } },
    el("label", { for: "q" }, "Ask about the approved notes"), q, el("div", { class: "row" }, ask), out);
  if (byDate.length) open(byDate[0]);
  return [el("h1", {}, "Approved meeting notes"), el("p", { class: "lede" }, "Notes your reviewers approved in this app for all members. The website's own meeting notes are on the Website page."),
    el("div", { class: "notes-grid" }, el("div", { class: "area-list" }, list), el("div", { class: "area-reader" }, reader), el("div", { class: "area-ask" }, el("h2", {}, "Ask a question"), form))];
}
/** Prepare the exact plan for an adopted Task and offer its approval (shared by submissions and transcript parts). */
async function showPlan(taskId, title, status, readsNote) {
  const p = await api("plan.prepare", { taskId });
  if (!p.ok) return status.replaceChildren(notice(say(p.error), true));
  const plan = p.result, ok = el("button", { type: "button", class: "btn" }, "Approve plan");
  ok.addEventListener("click", busy(ok, async () => { const r = await approve("proposal.approve", { proposalId: plan.proposalId, expectedRevision: plan.expectedRevision, version: plan.version, planHash: plan.planHash }, plan.planHash);
    status.replaceChildren(r.ok ? notice("Plan approved. The draft appears under Review when it's ready. A receipt is on its way to " + me.email + ".") : refusal(r)); }));
  status.replaceChildren(el("div", { class: "card" }, el("h3", {}, "Plan for “" + title + "”"), el("p", {}, plan.plan.instructions),
    el("p", { class: "note" }, readsNote + " Nothing is sent or published."), el("div", { class: "row" }, ok)));
}
async function reviewView() {
  if (!["admin", "reviewer"].includes(me.role)) return [el("h1", {}, "Review"), notice("Only reviewers can see submissions and drafts.", true)];
  const status = el("div");
  const [intakes, drafts] = await Promise.all([api("intake.list"), api("draft.list")]);
  const subs = el("ul", { class: "list" }, (intakes.result?.intakes || []).map((i) => {
    const actions = el("div", { class: "row" });
    if (!i.adoptedTaskId) { const b = el("button", { type: "button" }, "Adopt as Task"); b.addEventListener("click", busy(b, async () => {
      const r = await approve("task.adopt", { intakeId: i.intakeId, title: i.subject || "Meeting notes" });
      status.replaceChildren(r.ok ? notice("Adopted. Prepare its plan next.") : refusal(r)); if (r.ok) route(); })); actions.append(b); }
    else { const b = el("button", { type: "button", class: "secondary" }, "Prepare plan");
      b.addEventListener("click", busy(b, () => showPlan(i.adoptedTaskId, i.subject, status, "Reads the submitted material only."))); actions.append(b); }
    return el("li", { class: "item" }, el("div", {}, el("h3", {}, i.subject || "(no subject)"), i.snippet ? el("div", {}, "“" + i.snippet + "”") : null,
      el("div", { class: "meta" }, "From " + (i.from || "a member") + " · " + shortTime(i.receivedAt))),
      el("div", { class: "row" }, i.adoptedTaskId ? el("span", { class: "tag ok" }, "Adopted") : el("span", { class: "tag warn" }, "New"), actions));
  }));
  const editor = el("div");
  // P-2(a): reviewers add meeting notes as text (pasted, or a .md/.txt/.docx/.html file read here); stored as a submission, never emailed back.
  const addNotes = (() => {
    let clientRequestId = crypto.randomUUID(); const msg = el("div");
    const title = el("input", { type: "text", id: "add-title", maxlength: "200", placeholder: "e.g. Board meeting, Oct 24" });
    const text = el("textarea", { id: "add-text", placeholder: "Paste the meeting notes, agenda or minutes here." });
    const file = el("input", { type: "file", id: "add-file", accept: ".md,.txt,.docx,.html,.htm,text/plain,text/markdown,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    let fileName;
    file.addEventListener("change", async () => { const f = file.files?.[0]; if (!f) return; file.value = "";
      if (!/\.(md|txt|docx|html?)$/i.test(f.name)) return msg.replaceChildren(notice(say("intake_file_type_not_admitted"), true));
      if (/\.(md|txt)$/i.test(f.name) && f.size > 48 * 1024) return msg.replaceChildren(notice(say("intake_text_too_large"), true));
      let r; try { r = await readTextFile(f); } catch { return msg.replaceChildren(notice(say("chat_upload_unreadable"), true)); }
      if (new TextEncoder().encode(r.text).length > 48 * 1024) return msg.replaceChildren(notice(say("intake_text_too_large"), true));
      text.value = r.text; fileName = r.name; if (!title.value) title.value = f.name.replace(/\.(md|txt|docx|html?)$/i, ""); msg.replaceChildren(); });
    text.addEventListener("input", () => { clientRequestId = crypto.randomUUID(); });
    const send = el("button", { type: "button", class: "btn" }, "Add meeting notes");
    send.addEventListener("click", busy(send, async () => {
      if (new TextEncoder().encode(text.value).length > 48 * 1024) return msg.replaceChildren(notice(say("intake_text_too_large"), true));
      const r = await api("intake.upload", { clientRequestId, title: title.value, text: text.value, ...(fileName ? { fileName } : {}) });
      if (!r.ok) return msg.replaceChildren(refusal(r));
      status.replaceChildren(notice("Added. It's under Submissions: adopt it as a Task to prepare a plan.")); route(); }));
    return el("div", { class: "card" }, el("h3", {}, "Add meeting notes"),
      el("p", { class: "note" }, "Paste text or choose a .md, .txt, Word (.docx) or web page (.html) file (up to 48 KB of text). Only reviewers see it. Nothing is emailed or published."),
      el("label", { for: "add-title" }, "Title"), title, el("label", { for: "add-file" }, "File (optional)"), file, el("label", { for: "add-text" }, "Notes"), text, msg,
      el("div", { class: "row" }, send));
  })();
  const draftList = el("ul", { class: "list" }, (drafts.result?.drafts || []).map((d) => {
    const b = el("button", { type: "button", class: "secondary" }, "Open draft");
    b.addEventListener("click", busy(b, async () => {
      const r = await api("draft.read", { documentId: d.documentId }), md = r.result?.document?.markdown || "";
      const date = el("input", { type: "date", id: "meeting-date", value: new Date().toISOString().slice(0, 10) });
      // Safety: the member notes start EMPTY. Copying the private draft is an explicit step with a warning, and private-
      // looking items need a ticked confirmation (the runtime refuses both cases otherwise).
      const text = el("textarea", { id: "member-notes", "aria-describedby": "notes-help", placeholder: "Write what members should see. Confirmed facts only." });
      const warn = el("div"), ack = el("input", { type: "checkbox", id: "ack" });
      const ackRow = el("div", { class: "row check", hidden: true }, ack, el("label", { for: "ack" }, "I checked every line: anything private, tentative, unapproved or about money is meant for members."));
      const refresh = () => { ackRow.hidden = !hasPrivate(text.value); if (ackRow.hidden) ack.checked = false; };
      text.addEventListener("input", refresh);
      const copy = el("button", { type: "button", class: "btn secondary" }, "Start from the private draft");
      copy.addEventListener("click", () => { text.value = md; refresh(); warn.replaceChildren(notice("This is the PRIVATE draft. Remove questions, ideas, offers, amounts and anything not confirmed before approving.", true)); text.focus(); });
      const ok = el("button", { type: "button", class: "btn" }, "Approve for members");
      ok.addEventListener("click", busy(ok, async () => { const body = { meeting: date.value, reportId: d.documentId, markdown: text.value, ...(ack.checked ? { acknowledgedPrivateTerms: true } : {}) };
        const res = await approve("notes.approve", body, await sha256(text.value));
        // A refused approval keeps the editor (the text is not lost); the refusal shows above the button.
        if (res.ok) editor.replaceChildren(notice("Approved. Members can read version " + res.result.version + "."));
        else warn.replaceChildren(refusal(res)); }));
      editor.replaceChildren(el("div", { class: "card" }, el("h3", {}, "Private draft"), markdown(md), el("h2", {}, "Member-facing notes"),
        el("p", { class: "note", id: "notes-help" }, "Edit before approving. Only what you approve here becomes visible to members; the private draft never does."),
        el("label", { for: "meeting-date" }, "Meeting date"), date, el("label", { for: "member-notes" }, "Notes for members"), el("div", { class: "row" }, copy), warn, text, ackRow, el("div", { class: "row" }, ok)));
    }));
    return el("li", { class: "item" }, el("div", {}, el("h3", {}, d.title || "Meeting draft"), el("div", { class: "meta" }, "Draft ready " + shortTime(d.publishedAt)),
      d.approvedBy ? el("div", { class: "meta" }, "Plan approved by " + (d.approvedBy.email || "a former member") + " · " + shortTime(d.approvedBy.approvedAt)) : null), b);
  }));
  return [el("h1", {}, "Review"), el("p", { class: "lede" }, "Adopt submissions, approve the agent's plan, and decide what members see."), status,
    me.website ? await websiteSection() : null,
    el("div", { class: "grid two" }, el("div", {}, addNotes, el("h2", {}, "Submissions"), subs.children.length ? subs : el("p", { class: "note" }, "No submissions yet."),
      el("h2", {}, "Drafts"), draftList.children.length ? draftList : el("p", { class: "note" }, "No drafts yet.")), editor)];
}
// Website pack v0: a reviewer's request -> the agent's proposed change (diff) -> approve -> a DRAFT pull request on GitHub with
// a preview link. Publishing is a maintainer merging on GitHub. Cards render from runtime rows; every text is a text node.
// v0.1 polish: dates in words ("Thursday, Dec 31, 2026"; card titles "Thu, Dec 31"); the raw YYYY-MM-DD stays in the data.
const dayLong = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric", year: "numeric" }) : d;
const dayShort = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) : d;
const websiteNotes = { address_not_provided: "Address not provided: the agent didn't know it. Add it on GitHub before merging, or ask again with the address.",
  address_from_known_place: "Address filled in from the website's existing entry for this place." };
/** "New event: Test Event · Thu, Dec 31" from the runtime's change rows (older proposals: the summary title). */
function websiteTitle(r) {
  const c = r.summary?.changes;
  if (!Array.isArray(c) || !c.length) return r.summary ? r.summary.title.replace(/^Website: /, "") : r.text.slice(0, 80);
  const first = c[0], verb = first.action === "added" ? "New" : first.action === "removed" ? "Removed" : "Changed";
  return verb + " " + (first.kind === "event" ? "event" : "meeting notes") + ": " + first.title + (first.date ? " · " + dayShort(first.date) : "") + (c.length > 1 ? " (+" + (c.length - 1) + " more)" : "");
}
// v0.1: the change in plain words (runtime-computed before -> after per field); the raw diff only under "Technical details".
function websiteChanges(r) {
  const changes = r.summary?.changes;
  if (!Array.isArray(changes) || !changes.length) return el("ul", {}, (r.summary?.lines || []).map((l) => el("li", {}, l.replace(/^- /, ""))));
  return el("div", { class: "changes" }, changes.map((c) => el("div", { class: "change" },
    el("div", { class: "row" }, el("strong", {}, (c.kind === "event" ? "Event: " : "Meeting notes: ") + c.title),
      el("span", { class: "tag " + (c.action === "removed" ? "bad" : c.action === "added" ? "ok" : "warn") }, c.action === "added" ? "New" : c.action === "removed" ? "Removed" : "Changed")),
    c.action === "removed" ? el("p", { class: "note" }, "This entry will be taken off the website.") :
      el("ul", { class: "fields" }, c.fields.map((f) => { const v = (x) => f.field === "Date" ? dayLong(x) : x;
        return el("li", {}, el("span", { class: "field" }, f.field + ": "), c.action === "added" ? v(f.after) : [el("span", { class: "before" }, v(f.before)), " → ", el("span", { class: "after" }, v(f.after))]); })),
    (c.notes || []).map((n) => el("p", { class: "note warn-note" }, websiteNotes[n] || n)))));
}
// Director (Oct 19): when the website's data no longer matches the pack, reviewers and admins see why changes are paused
// (the member-facing refusal says so in plain words; there is no email alert for this).
const PAUSED_BANNER = "Website changes are paused: the website's data files changed and the website setup needs an update before new changes can be prepared.";
const websitePaused = (list) => list.some((r) => r.state === "failed" && r.label === "website_base_shape_changed")
  && list.find((r) => r.state !== "failed" || r.label === "website_base_shape_changed")?.label === "website_base_shape_changed";
// IMAGES-V1 I3: the reviewer sees the image, where it will be public, and that it becomes public.
const PUBLIC_IMAGE = "This image will become public on the website when a maintainer publishes (merges) the change.";
const flyerThumb = (imageId) => el("img", { src: `/o/${org}/image/${imageId}`, alt: "The flyer image", class: "flyer-thumb", width: "120", loading: "lazy" });
// J2: a shared-drive photo's thumbnail (the logged-in drive route; never a public URL).
const driveThumb = (hex, alt) => el("img", { src: `/o/${org}/drive/image/${hex}`, alt: alt || "Photo", class: "flyer-thumb", width: "120", loading: "lazy" });
function websiteImage(r) {
  const out = [];
  if (r.image?.path) { const drive = /^drive:([a-f0-9]{64})$/.exec(r.image.attachmentId || "");
    out.push(el("div", { class: "flyer-attach" }, drive ? driveThumb(drive[1], "The event's picture") : flyerThumb(r.image.attachmentId), el("div", {}, el("strong", {}, drive ? "The event's picture" : "Image for this event"),
      el("p", { class: "meta" }, "Public address: " + r.image.path.replace(/^public/, "") + " · " + Math.round(r.image.bytes / 1024) + " KB"), el("p", { class: "note warn-note" }, PUBLIC_IMAGE)))); }
  // J2: photos added to the website's photo gallery (by code; the same draft pull request).
  if (r.photos?.length) out.push(el("div", { class: "gallery-attach" }, el("strong", {}, "Added to the photo gallery"),
    el("div", { class: "drive-images" }, r.photos.map((g) => el("figure", { class: "chat-image" }, driveThumb(g.sha256.slice(7), "Gallery photo"),
      el("figcaption", { class: "meta" }, g.path.replace(/^public/, "") + " · " + Math.round(g.bytes / 1024) + " KB")))), el("p", { class: "note warn-note" }, "These photos will become public on the website when a maintainer publishes (merges) the change.")));
  return out.length ? el("div", {}, ...out) : "";
}
/** J2 (owner: photos are "super important"): pick up to 6 shared-drive photos for a website request; each is the event's picture
 *  (at most one, and not with a flyer) or goes to the photo gallery. New photos go to the shared drive first (Files). */
function photoPicker(state, hasFlyer, redraw) {
  const wrap = el("div", { class: "photo-picker" }), chosen = state.photos;
  const row = (p) => {
    const ev = el("input", { type: "radio", name: "use-" + p.sha256, value: "event", id: "ev-" + p.sha256.slice(0, 12) }), ga = el("input", { type: "radio", name: "use-" + p.sha256, value: "gallery", id: "ga-" + p.sha256.slice(0, 12) });
    ev.checked = p.use === "event"; ga.checked = p.use === "gallery";
    ev.disabled = hasFlyer || chosen.some((x) => x !== p && x.use === "event");
    ev.addEventListener("change", () => { p.use = "event"; redraw(); }); ga.addEventListener("change", () => { p.use = "gallery"; redraw(); });
    const drop = el("button", { type: "button", class: "link-btn" }, "Remove");
    drop.addEventListener("click", () => { state.photos = chosen.filter((x) => x !== p); redraw(); });
    return el("div", { class: "flyer-attach photo-row" }, driveThumb(p.sha256, p.name), el("div", {}, el("strong", {}, p.name),
      el("div", { class: "row" }, ev, el("label", { for: ev.id }, "The event's picture"), ga, el("label", { for: ga.id }, "Add to the photo gallery")), drop));
  };
  const add = el("button", { type: "button", class: "btn secondary" }, chosen.length ? "Add more photos" : "Add photos"), shelf = el("div");
  add.disabled = chosen.length >= 6;
  add.addEventListener("click", busy(add, async () => {
    const images = (await api("files.list")).result?.images || [];
    const pick = images.filter((im) => !chosen.some((x) => x.sha256 === im.sha256));
    shelf.replaceChildren(el("div", { class: "card shelf" }, el("p", { class: "note" }, pick.length ? "Choose from the shared drive (up to 6 per change)." : "No photos in the shared drive yet.", " ", el("a", { href: "#files" }, "Add photos to the shared drive")),
      el("div", { class: "drive-images" }, pick.map((im) => { const b = el("button", { type: "button", class: "pick", title: im.name }, driveThumb(im.sha256, im.name), el("span", { class: "meta" }, im.name));
        b.addEventListener("click", () => { if (state.photos.length >= 6) return; state.photos = [...state.photos, { sha256: im.sha256, name: im.name, use: "gallery" }]; redraw(); }); return b; }))));
  }));
  wrap.append(...chosen.map(row), chosen.length ? el("p", { class: "note warn-note" }, "Photos become public on the website only when a maintainer publishes (merges) the change.") : "", el("div", { class: "row" }, add), shelf);
  return wrap;
}
async function websiteSection() {
  const box = el("section", { class: "card", id: "website" });
  // USABILITY v1: a starter or "Propose a change" can hand words to this box.
  let clientText = websiteState.text; websiteState.text = "";
  // IMAGES-V1 I3: a checked flyer handed over by "Add to the website" (its image goes with the request until removed).
  let flyer = websiteState.flyer; websiteState.flyer = null;
  // TEAM-TASKS T3: a checked team-task result handed over by "Use for a website request" (the request keeps that reference).
  let fromTask = websiteState.fromTask; websiteState.fromTask = null;
  const picked = { photos: [] }; // J2: the photos chosen for the next request (kept across the 3 s refresh)
  const draw = async () => {
    const list = (await api("website.list")).result?.requests || [];
    const text = el("textarea", { id: "website-text", placeholder: "e.g. Add the tree planting on Saturday Nov 8, 9 am at Riverside Park to events" });
    text.value = clientText; text.addEventListener("input", () => { clientText = text.value; });
    // Owner (Oct 23): the button says what happens; only ONE solid button at a time (Approve wins while a proposal waits).
    const waiting = list[0]?.state === "ready" && !list[0]?.pr;
    const msg = el("div"), send = el("button", { type: "button", class: waiting ? "btn secondary" : "btn" }, "Ask the agent to draft this change");
    send.addEventListener("click", busy(send, async () => { const r = await api("website.request", { text: text.value, ...(flyer ? { flyerProposalId: flyer.proposalId } : {}),
      ...(fromTask ? { fromTask: { taskId: fromTask.taskId, resultId: fromTask.resultId } } : {}),
      ...(picked.photos.length ? { photos: picked.photos.map((p) => ({ sha256: p.sha256, use: p.use })) } : {}) });
      if (!r.ok) return msg.replaceChildren(refusal(r)); clientText = ""; flyer = null; fromTask = null; picked.photos = []; await draw(); }));
    const photos = me.website ? photoPicker(picked, !!flyer, () => draw()) : "";
    let attached = "";
    if (flyer) {
      const drop = el("button", { type: "button", class: "btn secondary" }, "Don't use the image");
      drop.addEventListener("click", () => { flyer = null; draw(); });
      attached = el("div", { class: "flyer-attach" }, flyerThumb(flyer.imageId), el("div", {}, el("strong", {}, "The flyer image goes with this request"),
        el("p", { class: "note warn-note" }, PUBLIC_IMAGE), drop));
    }
    // Owner (Oct 23): only the newest proposal is prominent, with ONE primary action; older ones sit under "Previous updates",
    // with small links and Discard for a proposal that was never approved.
    const discard = (r) => {
      const d = el("button", { type: "button", class: "link-btn" }, "Discard"), box = el("span", {}, d);
      d.addEventListener("click", () => { const yes = el("button", { type: "button", class: "link-btn" }, "Yes, discard it"), no = el("button", { type: "button", class: "link-btn" }, "Keep");
        yes.addEventListener("click", busy(yes, async () => { const res = await api("website.discard", { requestId: r.requestId }); if (!res.ok) return box.replaceChildren(refusal(res)); await draw(); }));
        no.addEventListener("click", () => box.replaceChildren(d)); box.replaceChildren(el("span", { class: "note" }, "Discard this proposal? "), yes, no); });
      return box;
    };
    const card = (r, current) => {
      const head = el("div", {}, el("h3", {}, websiteTitle(r)), el("div", { class: "meta" }, "Requested " + shortTime(r.createdAt)));
      const body = el("div", { class: "website-body" });
      if (r.state === "queued" || r.state === "running") body.append(el("span", { class: "tag" }, "Preparing the change…"));
      else if (r.state === "failed") body.append(el("div", { class: "row" }, el("span", { class: "tag bad" }, "Not prepared"), discard(r)), el("p", { class: "note" }, say(r.label)));
      else if (!r.pr) {
        // Update the open draft (Fable ACCEPT e483c8dd): when the runtime offers it, approving adds this version to THAT pull request.
        const ok = el("button", { type: "button", class: current ? "btn" : "btn secondary" }, r.update ? "Update draft PR #" + r.update.pr : "Approve and open a draft PR"), out = el("div");
        ok.addEventListener("click", busy(ok, async () => { const res = await approve("website.apply", { requestId: r.requestId }, r.card.digest);
          if (!res.ok) return out.replaceChildren(refusal(res)); await draw(); }));
        // Owner (Oct 23): an earlier proposal's draft PR already changes this page. Eligible: this approval UPDATES that PR. Otherwise
        // approving opens a SECOND pull request, and the card says why (Fable Q2: the website changed since; or it was closed; or several).
        const why = { base_moved: "The website changed since #N was prepared, so this can't be added to it. ", pr_closed: "#N was closed or merged on GitHub. ",
          several: "More than one draft pull request changes this page. ", busy: "#N is being updated right now. " }[r.updateBlocked] || "";
        const links = (r.overlaps || []).map((o) => el("a", { href: o.url, target: "_blank", rel: "noopener noreferrer", class: "small-link" }, "Open #" + o.number));
        const overlap = r.update ? el("div", { class: "notice", role: "status" }, "Approving adds this version to draft pull request #" + r.update.pr +
            " (the same pull request; nothing is published until a maintainer merges it). ", ...links)
          : (r.overlaps || []).length ? el("div", { class: "notice overlap", role: "status" }, why.replace(/#N/g, "#" + r.overlaps[0].number) + "Draft pull request " + r.overlaps.map((o) => "#" + o.number).join(", ") +
            " from an earlier proposal already changes this page. Approving opens a second pull request with this version; ask the website maintainer to publish only one of them (the newer one, if this one is right). ", ...links) : "";
        const change = [websiteChanges(r), websiteImage(r), el("details", { class: "tech" }, el("summary", {}, "Technical details"), el("pre", { class: "diff" }, r.diff || "")), overlap,
          r.update ? "" : el("p", { class: "note" }, "Approving opens a draft pull request on GitHub with this exact change. Nothing is published until a maintainer merges it."), el("div", { class: "row" }, ok, discard(r)), out];
        if (current) body.append(...change);
        else body.append(el("div", { class: "row" }, el("span", { class: "tag warn" }, "Not approved"), discard(r)), el("details", { class: "tech" }, el("summary", {}, "Show the change"), ...change));
      } else {
        const p = r.pr, tags = el("div", { class: "row" });
        if (r.updatedBy) tags.append(el("span", { class: "tag" }, "Updated by a later proposal · " + shortTime(r.updatedBy.at)));
        tags.append(p.state === "done" ? el("span", { class: "tag ok" }, p.prState?.merged ? "Merged (published)" : p.prState?.state === "closed" ? "Closed" : "Draft PR open")
          : p.state === "unsettled" ? el("span", { class: "tag warn" }, "Waiting for an admin") : p.state === "failed" ? el("span", { class: "tag bad" }, "Not opened") : el("span", { class: "tag" }, "Opening the PR…"));
        // v0.1: the preview link exists only once Vercel reports it ready; it opens the changed page. While building: progress, no link.
        // Owner (Oct 23): the preview is the one button, and only on the newest proposal; the pull request is a small link.
        if (p.previewPageUrl) tags.append(el("a", { href: p.previewPageUrl, target: "_blank", rel: "noopener noreferrer", class: current ? "btn secondary" : "small-link" }, "Open the preview"));
        else if (p.previewBuilding) tags.append(el("span", { class: "building", role: "status" }, el("progress", { "aria-label": "Building preview" }), " Building preview… usually about a minute"));
        else if (p.state === "done") { const c = el("button", { type: "button", class: "link-btn" }, "Check the preview again");
          c.addEventListener("click", busy(c, async () => { await api("website.preview.check", { requestId: r.requestId }); await draw(); }));
          tags.append(el("span", { class: "note" }, "The preview isn't ready yet."), c); }
        if (p.url) tags.append(el("a", { href: p.url, target: "_blank", rel: "noopener noreferrer", class: "small-link" }, "Open the pull request"));
        body.append(tags); // native append would print a null as the text "null" (seen in v0)
        if (p.label && p.label !== "website_preview_pending") body.append(el("p", { class: "note" }, say(p.label)));
      }
      return el("li", { class: "item" + (current ? "" : " previous-item") }, head, body);
    };
    const [newest, ...older] = list;
    const items = newest ? el("ul", { class: "list" }, card(newest, true)) : null;
    const previous = older.length ? el("details", { class: "previous" }, el("summary", {}, "Previous updates (" + older.length + ")"), el("ul", { class: "list" }, older.map((r) => card(r, false)))) : "";
    if (previous) { previous.open = !!websiteState.previousOpen; previous.addEventListener("toggle", () => { websiteState.previousOpen = previous.open; }); } // survives the 3 s refresh
    box.replaceChildren(websitePaused(list) ? notice(PAUSED_BANNER, true) : "", el("h2", {}, "Propose a change"), el("p", { class: "note" }, "Describe a change to the website's events or meeting notes. You'll see the exact change before anything goes to GitHub; the website changes only when its maintainer publishes it."),
      el("label", { for: "website-text" }, "What should change?"), text, attached, photos,
      fromTask ? el("p", { class: "note", id: "from-task" }, "From the team task “" + fromTask.title + "”. You still see the exact change before anything goes to GitHub.") : "",
      msg, el("div", { class: "row" }, send),
      ...(items ? [el("h3", { class: "sub" }, "Latest proposal"), items, previous] : []));
    if (clientText) requestAnimationFrame(() => { text.focus(); text.setSelectionRange(text.value.length, text.value.length); });
    // Keep the cards current while something is in progress (only while this page is open).
    if (list.some((r) => ["queued", "running"].includes(r.state) || (r.pr && (r.pr.state === "intent" || r.pr.state === "sent" || r.pr.previewBuilding))))
      setTimeout(() => { if (["#review", "#website"].includes(location.hash || "") && document.body.contains(box)) draw(); }, 3000);
  };
  await draw();
  return box;
}
async function activityView() {
  const rows = (await api("audit.read")).result || [];
  const decision = (r) => el("span", { class: "tag " + (r.decision === "shadowed" ? "ok" : r.decision === "paused" ? "warn" : "bad") }, r.decision === "shadowed" ? "Prepared (not sent)" : r.decision === "paused" ? "Paused" : "Not replied");
  const detail = (r) => !r.bytes ? el("span", { class: "note" }, "No reply prepared") : el("details", {}, el("summary", {}, "Exact reply and sources"), el("pre", {}, r.bytes),
    el("div", { class: "cite" }, "Citations: " + ((JSON.parse(r.citations || "[]") || []).map((c) => c.path + "#L" + c.startLine).join(", ") || "none")),
    el("div", { class: "cite" }, "Policy v" + (r.policy_version ?? "–") + " · model " + (r.model || "–") + " · cost $" + (r.cost_usd ?? 0)));
  const head = el("tr", {}, ["When", "Member", "Decision", "Reason", "Recipient", ""].map((h) => el("th", { scope: "col" }, h)));
  const table = el("table", { class: "desktop-table" }, el("thead", {}, head), el("tbody", {}, rows.slice().reverse().map((r) =>
    el("tr", {}, el("td", {}, shortTime(r.at)), el("td", {}, r.member_email || "—"), el("td", {}, decision(r)), el("td", {}, reasonText(r.reason) || "—"), el("td", {}, r.recipient || "—"), el("td", {}, detail(r))))));
  const cards = el("div", { class: "mobile-table" }, rows.slice().reverse().map((r) => el("div", { class: "card" },
    el("div", { class: "row" }, decision(r), el("span", { class: "note" }, shortTime(r.at))), el("p", { class: "note" }, (reasonText(r.reason) || "Prepared for " + (r.recipient || "the member")) + (r.member_email && r.reason ? " · " + r.member_email : "")), detail(r))));
  // Reviewers: who approved each plan (the recorded Authorization, checked against the recorded plan) and how they signed in.
  let approvals = [];
  if (["admin", "reviewer"].includes(me.role)) approvals = (await api("approval.list")).result?.approvals || [];
  // Volunteers see who approved what, by Task title; the plan hash and membership version stay behind Details (audit).
  const approvalList = el("ul", { class: "list" }, approvals.map((a) => el("li", { class: "item" },
    el("div", {}, el("h3", {}, (a.approvedBy.email || "A former member") + (a.matched ? " approved the plan for " + (a.title || "a meeting draft") : " started an approval that was not recorded")),
      el("div", { class: "meta" }, shortTime(a.approvedAt) + " · via " + how(a.authn)),
      el("details", {}, el("summary", {}, "Details"),
        el("div", { class: "cite" }, "Plan " + (a.planHash || a.artifactDigest || "none")), el("div", { class: "cite" }, "Membership version " + a.approvedBy.membershipVersion))),
    el("span", { class: "tag " + (a.matched ? "ok" : "warn") }, a.matched ? "Matches the approved plan" : "Not recorded"))));
  // USABILITY v1: without email intake there are no member emails; say what the page holds instead.
  const lede = me.emailIntake ? (["admin", "reviewer"].includes(me.role) ? "Every member email the agent handled." : "Your emails the agent handled.") + " Shadow mode: replies are prepared and recorded, never sent."
    : "Who approved which plan, and how they signed in.";
  return [el("h1", {}, "Activity"), el("p", { class: "lede" }, lede),
    me.emailIntake || rows.length ? (rows.length ? [table, cards] : el("p", { class: "note" }, "Nothing yet.")) : approvals.length ? [] : el("p", { class: "note" }, "Nothing yet."),
    approvals.length ? [el("h2", {}, "Plan approvals"), approvalList] : []];
}

// ---- Recordings (transcription T-6): reviewers only; members never see recordings or transcripts ----
const hms = (sec) => { const s = Math.max(0, Math.round(sec || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(r).padStart(2, "0"); };
const AUDIO_TYPES = { m4a: "audio/mp4", mp4: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", webm: "audio/webm", flac: "audio/flac" };
const jobState = (j) => ({ uploaded: ["Ready to transcribe", "warn"], queued: ["Waiting to transcribe", "warn"], sending: ["Transcribing…", "warn"],
  done: ["Transcript ready" + (j.parts ? " · " + j.parts + (j.parts === 1 ? " part" : " parts") : ""), "ok"], failed: ["Failed: " + say(j.label), "bad"],
  unsettled: ["Outcome unknown: ask an admin", "bad"], discarded: ["Discarded", ""] })[j.state] || [j.state, ""];
/** Upload: mint an id (bound to this sign-in), then stream the file once with progress. */
function uploadRecording(file, out, onDone) {
  return (async () => {
    const type = file.type || AUDIO_TYPES[(file.name.split(".").pop() || "").toLowerCase()] || "";
    const m = await api("media.upload", { fileName: file.name.replace(/[\u0000-\u001f\u007f/\\<>]/g, "_").slice(0, 255) || "recording", size: file.size, contentType: type });
    if (!m.ok) return out.replaceChildren(notice(say(m.error), true));
    const bar = el("progress", { max: String(file.size), value: "0" });
    out.replaceChildren(el("p", { class: "note" }, "Uploading " + file.name + "…"), bar);
    const r = await new Promise((resolve) => { const x = new XMLHttpRequest(); x.open("PUT", `/o/${org}/upload/${m.result.uploadId}`); x.setRequestHeader("content-type", type);
      x.upload.onprogress = (e) => { bar.value = e.loaded; }; x.onload = () => { try { resolve(JSON.parse(x.responseText)); } catch { resolve({ ok: false, error: "unreadable_response" }); } };
      x.onerror = () => resolve({ ok: false, error: "media_upload_aborted" }); x.send(file); });
    out.replaceChildren(r.ok ? notice(r.deduplicated ? "That recording was already uploaded." : "Uploaded (" + hms(r.durationSec) + "). Next: Transcribe.") : notice(say(r.error), true));
    if (r.ok) onDone();
  })();
}
/** One part of a transcript, line by line: time, an "unverified" speaker chip, the text. Header lines stay as notes. */
function transcriptPart(md) {
  const box = el("div", { class: "transcript" });
  for (const line of String(md).split("\n")) {
    const m = /^\[(\d{2}:\d{2}:\d{2})\] (Speaker \d+)( \(uncertain\))?: (.*)$/.exec(line);
    if (m) box.append(el("div", { class: "tline" }, el("span", { class: "ttime" }, m[1]), el("span", { class: "tag" }, m[2] + " · unverified"),
      m[3] ? el("span", { class: "tag warn" }, "uncertain") : null, el("span", {}, m[4])));
    else if (line.startsWith("# ")) box.append(el("h3", {}, line.slice(2)));
    else if (line.trim()) box.append(el("p", { class: "note" }, line));
  }
  return box;
}
async function recordingsView() {
  if (!["admin", "reviewer"].includes(me.role)) return [el("h1", {}, "Recordings"), notice("Only reviewers can see recordings.", true)];
  const r = await api("transcript.list");
  const head = [el("h1", {}, "Recordings"), el("p", { class: "lede" }, "Meeting recordings become transcripts for reviewers. Members never see recordings or transcripts.")];
  if (!r.ok) return [...head, notice(say(r.error), true)];
  const { jobs, policy, profileHash } = r.result, status = el("div", { "aria-live": "polite" });
  const upOut = el("div", { "aria-live": "polite" }), file = el("input", { type: "file", id: "recording", accept: "audio/*,.m4a,.mp3,.wav,.ogg,.opus,.webm,.flac" });
  const up = el("button", { type: "button", class: "btn" }, "Upload recording");
  up.addEventListener("click", busy(up, async () => { if (file.files && file.files[0]) await uploadRecording(file.files[0], upOut, () => setTimeout(route, 600)); }));
  const upload = el("div", { class: "card" }, el("h3", {}, "Add a recording"),
    policy ? el("p", {}, policy.noticeText) : notice(say("transcription_no_policy"), true),
    el("label", { for: "recording" }, "Recording (up to " + Math.round(r.result.limits.maxUploadBytes / 1048576) + " MB, " + r.result.limits.maxAudioMinutes + " minutes)"), file,
    el("div", { class: "row" }, up), upOut,
    el("p", { class: "note" }, policy ? "Audio is deleted " + policy.retention.acceptPlusDays + " days after you accept the transcript, and never kept beyond " + policy.retention.hardCapDays + " days." : ""));
  const list = el("ul", { class: "list" }, jobs.map((j) => {
    const [label, tone] = jobState(j), actions = el("div", { class: "row" }), panel = el("div");
    const act = (text, cls, fn) => { const b = el("button", { type: "button", class: cls }, text); b.addEventListener("click", busy(b, fn)); actions.append(b); };
    if (["uploaded", "failed"].includes(j.state) && !j.audioDeleted && policy) act("Transcribe…", "", async () => {
      const f = (id, text, max) => { const i = el("input", { type: "text", id: id + j.jobId, maxlength: String(max) }); return [el("label", { for: id + j.jobId }, text), i]; };
      const [la, authority] = f("auth", "Who authorised the recording", 200), [lb, audience] = f("aud", "Who was present (audience)", 200),
        [lc, declined] = f("dec", "What people who declined could do instead", 300);
      const ann = el("input", { type: "checkbox", id: "ann" + j.jobId }), go = el("button", { type: "button", class: "btn", disabled: true }, "Transcribe");
      const ready = () => { go.disabled = !(ann.checked && authority.value.trim() && audience.value.trim() && declined.value.trim()); };
      for (const x of [authority, audience, declined, ann]) x.addEventListener("input", ready);
      go.addEventListener("click", busy(go, async () => {
        const res = await approve("transcript.start", { jobId: j.jobId, profileHash, attestation: { authority: authority.value.trim(), announced: true, audience: audience.value.trim(), declinedAlternative: declined.value.trim() } }, j.audioSha256);
        if (res.ok) { status.replaceChildren(notice("Transcribing. This page updates when it's ready. A receipt is on its way to " + me.email + ".")); setTimeout(route, 600); } else panel.replaceChildren(refusal(res)); }));
      panel.replaceChildren(el("div", { class: "card" }, el("h3", {}, "Recording notice"), el("p", {}, policy.noticeText), la, authority, lb, audience, lc, declined,
        el("div", { class: "row check" }, ann, el("label", { for: "ann" + j.jobId }, "The notice above was given before recording started.")),
        el("p", { class: "note" }, "This is your attestation under the org's policy, not a legal finding. The audio goes to the transcription service named in the policy."),
        el("div", { class: "row" }, go)));
    });
    if (j.state === "done") {
      act("Open transcript", "secondary", async () => {
        const parts = el("div", { class: "row" }), view = el("div");
        const show = async (n) => { const t = await api("transcript.read", { jobId: j.jobId, part: n }); view.replaceChildren(t.ok ? transcriptPart(t.result.markdown) : notice(say(t.error), true)); };
        for (let n = 1; n <= j.parts; n++) { const b = el("button", { type: "button", class: "secondary" }, "Part " + n); b.addEventListener("click", () => show(n)); parts.append(b); }
        panel.replaceChildren(el("div", { class: "card" }, el("p", { class: "note" }, "Speaker labels are automatic estimates, not identities."), parts, view)); await show(1);
      });
      if (!j.acceptedAt) act("Accept transcript", "secondary", async () => { const res = await approve("transcript.accept", { jobId: j.jobId });
        status.replaceChildren(res.ok ? notice("Accepted. The audio will be deleted after " + (policy ? policy.retention.acceptPlusDays : 7) + " days.") : refusal(res)); if (res.ok) setTimeout(route, 600); });
      act("Adopt parts…", "secondary", async () => {
        const first = el("input", { type: "number", id: "pf" + j.jobId, min: "1", max: String(j.parts), value: "1" }), last = el("input", { type: "number", id: "pl" + j.jobId, min: "1", max: String(j.parts), value: String(Math.min(j.parts, 3)) });
        const title = el("input", { type: "text", id: "pt" + j.jobId, value: j.fileName.replace(/\.[a-z0-9]{2,5}$/i, ""), maxlength: "200" }), go = el("button", { type: "button", class: "btn" }, "Adopt as Task");
        go.addEventListener("click", busy(go, async () => { const res = await approve("task.adopt", { transcriptJobId: j.jobId, parts: [Number(first.value), Number(last.value)], title: title.value.trim() || "Meeting transcript" });
          status.replaceChildren(res.ok ? notice("Adopted. Prepare its plan next.") : refusal(res)); if (res.ok) setTimeout(route, 600); }));
        panel.replaceChildren(el("div", { class: "card" }, el("p", { class: "note" }, "A plan reads at most 7 parts (about 110 KB). Long meetings take two adoptions."),
          el("label", { for: "pf" + j.jobId }, "From part"), first, el("label", { for: "pl" + j.jobId }, "To part"), last, el("label", { for: "pt" + j.jobId }, "Task title"), title, el("div", { class: "row" }, go)));
      });
    }
    if (!j.audioDeleted && ["uploaded", "failed", "queued", "done"].includes(j.state)) act("Discard audio", "secondary", async () => {
      const res = await approve("transcript.discard", { jobId: j.jobId }); status.replaceChildren(res.ok ? notice("Audio deleted.") : refusal(res)); if (res.ok) setTimeout(route, 600); });
    const adopted = (j.adoptions || []).map((a) => { const b = el("button", { type: "button", class: "secondary" }, "Prepare plan (parts " + a.parts[0] + "–" + a.parts[1] + ")");
      b.addEventListener("click", busy(b, () => showPlan(a.taskId, j.fileName + " (parts " + a.parts[0] + "–" + a.parts[1] + ")", status, "Reads the adopted transcript parts only."))); return b; });
    return el("li", { class: "item" }, el("div", {}, el("h3", {}, j.fileName), el("div", { class: "meta" }, hms(j.durationSec) + " · uploaded " + shortTime(j.uploadedAt)),
      el("div", { class: "row" }, el("span", { class: "tag " + tone }, label), j.audioDeleted ? el("span", { class: "tag" }, "Audio deleted") : null, j.acceptedAt ? el("span", { class: "tag ok" }, "Accepted") : null)),
      actions, adopted.length ? el("div", { class: "row" }, adopted) : null, panel);
  }));
  // While a job is waiting or running, refresh this page every few seconds.
  if (jobs.some((j) => ["queued", "sending"].includes(j.state))) setTimeout(() => { if ((location.hash || "") === "#recordings") route(); }, 3000);
  return [...head, status, upload, el("h2", {}, "Recordings"), jobs.length ? list : el("p", { class: "note" }, "No recordings yet.")];
}

// ---- Chat agent (slice 1, C-6b): conversations, async turns polled every 1 s (2 s after 30 s), draft plan cards, versioned
// drafts with a sandboxed preview, text uploads, and the agent panel. Every card renders from runtime rows; model text and
// file text are text nodes; the preview HTML only ever goes into an <iframe sandbox> with no allow-* tokens.
// notice: a turn's failure, kept across the redraw that follows the turn and shown once (WC-3).
// drafts: what the member has typed per conversation, kept across redraws (a reply finishing while they type redraws the pane).
const chatState = { conversationId: null, notice: null, pending: null, drafts: {}, landing: false, keep: false };
// USABILITY v1 (owner, Oct 19): starter tasks on an empty chat. "prefill" puts real words in the box (the member presses Send),
// "plan" opens the draft plan card, "go" opens another page. The website one is for reviewers (chat cannot change the
// website; the Website page's request box can).
const reviewerRole = () => ["admin", "reviewer"].includes(me.role);
// Package E (Director, 24 Oct): Word (.docx) and web (.html) files are read HERE, in the browser, into plain text; the server keeps
// receiving only text (the same capped, sanitized upload). No dependency: a .docx is a zip, inflated with the built-in
// DecompressionStream; its word/document.xml and an .html file go through DOMParser (never into the page). A bad or oversized
// file only ever costs this tab: inflated text is capped at 2 MB and anything unexpected is refused, never guessed.
const EXTRACT_MAX = 2 * 1024 * 1024, W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
class UnreadableFile extends Error {}
async function inflateRaw(bytes, max) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(), parts = []; let n = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; if (n > max) { await reader.cancel(); throw new UnreadableFile(); } parts.push(value); }
  return new TextDecoder("utf-8", { fatal: true }).decode(await new Blob(parts).arrayBuffer());
}
/** The one zip entry we need, found through the central directory (no zip64, no encryption: refused). */
async function zipEntry(buf, wanted) {
  const v = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1; for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 22 - 65535); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new UnreadableFile();
  let p = v.getUint32(eocd + 16, true); const count = v.getUint16(eocd + 10, true), dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (p + 46 > buf.byteLength || v.getUint32(p, true) !== 0x02014b50) throw new UnreadableFile();
    const flags = v.getUint16(p + 8, true), method = v.getUint16(p + 10, true), size = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true);
    const el_ = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true), name = dec.decode(u8.subarray(p + 46, p + 46 + nl));
    if (name === wanted) {
      if (flags & 1 || local + 30 > buf.byteLength || v.getUint32(local, true) !== 0x04034b50) throw new UnreadableFile();
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true), data = u8.subarray(start, start + size);
      if (method === 0) { if (size > EXTRACT_MAX) throw new UnreadableFile(); return new TextDecoder("utf-8", { fatal: true }).decode(data); }
      if (method === 8) return inflateRaw(data, EXTRACT_MAX);
      throw new UnreadableFile();
    }
    p += 46 + nl + el_ + cl;
  }
  throw new UnreadableFile();
}
/** word/document.xml -> text: headings "#", list paragraphs "- ", tables one row per line with tabs between cells. */
function docxXmlText(xml) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new UnreadableFile();
  const body = doc.getElementsByTagNameNS(W_NS, "body")[0]; if (!body) throw new UnreadableFile();
  const runs = (n) => { let t = ""; for (const x of n.getElementsByTagNameNS(W_NS, "*")) { if (x.localName === "t") t += x.textContent; else if (x.localName === "tab") t += "\t"; else if (x.localName === "br") t += "\n"; } return t; };
  const para = (pEl) => {
    const style = pEl.getElementsByTagNameNS(W_NS, "pStyle")[0]?.getAttributeNS(W_NS, "val") ?? "", h = /^heading\s?([1-6])$/i.exec(style.replace(/[^A-Za-z0-9 ]/g, ""));
    const t = runs(pEl).trim(); if (!t) return "";
    return h ? "#".repeat(Number(h[1])) + " " + t : pEl.getElementsByTagNameNS(W_NS, "numPr").length ? "- " + t : t;
  };
  const out = [];
  for (const n of body.children) {
    if (n.localName === "p") out.push(para(n));
    else if (n.localName === "tbl") for (const tr of n.getElementsByTagNameNS(W_NS, "tr")) out.push([...tr.getElementsByTagNameNS(W_NS, "tc")].map((tc) => runs(tc).trim().replace(/\s+/g, " ")).join("\t"));
  }
  return out.join("\n\n");
}
/** An .html file -> text: scripts and styles dropped, block elements on their own lines, headings "#", list items "- ". */
function htmlText(html) {
  // Style blocks and attributes are cut BEFORE parsing: the page's CSP (style-src 'self') would refuse them and log an error.
  const clean = html.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "").replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  const doc = new DOMParser().parseFromString(clean, "text/html"), out = [];
  for (const x of doc.querySelectorAll("script,style,noscript,template,head")) x.remove();
  const walk = (n) => {
    if (n.nodeType === 3) { out.push(n.nodeValue.replace(/\s+/g, " ")); return; }
    if (n.nodeType !== 1) return;
    const tag = n.localName, block = /^(p|div|section|article|header|footer|li|tr|h[1-6]|blockquote|table|ul|ol|br|hr)$/.test(tag);
    if (block) out.push("\n");
    if (/^h[1-6]$/.test(tag)) out.push("#".repeat(Number(tag[1])) + " "); else if (tag === "li") out.push("- ");
    for (const c of n.childNodes) walk(c);
    if (block) out.push("\n");
  };
  walk(doc.body ?? doc.documentElement);
  return out.join("").split("\n").map((l) => l.trim()).join("\n");
}
/** A picked file as {name, text} for the text uploads: .md/.txt/.csv as they are; .docx/.html converted here and named <base>.md. */
async function readTextFile(f) {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(f.name)?.[1] ?? "").toLowerCase(), base = f.name.replace(/\.[A-Za-z0-9]+$/, "");
  const md = () => (base.replace(/[^A-Za-z0-9 ._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 76) || "document") + ".md";
  if (["md", "txt", "csv"].includes(ext)) return { name: f.name, text: await f.text(), converted: false };
  let text;
  try {
    if (ext === "docx") { if (f.size > 20 * 1024 * 1024) throw new UnreadableFile(); text = docxXmlText(await zipEntry(await f.arrayBuffer(), "word/document.xml")); }
    else if (ext === "html" || ext === "htm") { if (f.size > EXTRACT_MAX) throw new UnreadableFile(); text = htmlText(await f.text()); }
    else return null;
  } catch { throw new UnreadableFile(); }
  text = text.replace(/ /g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) throw new UnreadableFile();
  return { name: md(), text, converted: true };
}
const TEXT_ACCEPT = ".md,.txt,.csv,.docx,.html,.htm,text/plain,text/markdown,text/csv,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const websiteState = { text: "", flyer: null, fromTask: null, previousOpen: false };
// TEAM-TASKS-V1 T2b: what "Make this a task" carried over from a chat (typed text + that chat's text files to choose from).
const taskState = { adopt: null, notice: null };
const STARTERS = () => [
  { label: "Draft the next newsletter", hint: "Approve a short plan; the agent writes a draft you can preview.", plan: "newsletter" },
  { label: "Prepare a meeting agenda", hint: "A draft agenda for the next meeting, from the notes.", plan: "agenda" },
  ...(me.website && reviewerRole() ? [{ label: "Add or change an event on the website", hint: "Describe it; you see the exact change before anything goes to GitHub.",
    go: "#website", website: "Add an event: " }] : []),
  { label: "What happened at the last meeting?", hint: "A short summary with sources.", prefill: "What happened at the last meeting? Give me the main points, with sources." },
  { label: "Summarize the public safety report", hint: "From the latest meeting notes.", prefill: "Summarize the public safety report from the latest meeting notes." },
  { label: "Help: what can you do?", hint: "How-to for every task, and who approves what.", go: "#help" }];
function starterGrid(onPick) {
  // Owner (Oct 23): only on an empty chat, as small one-line suggestions (the longer hint is the tooltip).
  return el("div", { class: "starters-box" }, el("h3", {}, "What would you like to do?"), el("div", { class: "starter-grid" }, STARTERS().map((t) => {
    const b = el("button", { type: "button", class: "starter", title: t.hint }, el("strong", {}, t.label));
    b.addEventListener("click", busy(b, () => onPick(t))); return b; })));
}
// Fable QUICK-START (a): a draft request typed with no approved plan would get plain Q&A and save nothing. Such a message
// opens the plan card instead ("Approve plan to start drafting"); the member can still send it as a plain question.
// P2 (owner, Oct 26: "can you get the newsletter started and i will approve it?" matched nothing, so the agent invented "approve it
// in Tasks"): the verb's common forms and phrasings too. The question-word guard is unchanged.
const DRAFT_VERB = /\b(draft(?:s|ed|ing)?|write|writing|prepar(?:e|ed|ing)|creat(?:e|ed|ing)|make|making|start(?:s|ed|ing)?|compose|put together|get (?:\w+ ){0,3}(?:started|going)|work on|approve)\b/i;
const QUESTION = /^\s*(when|what|who|whom|why|how|where|which|did|does|do|is|was|were|has|have|had)\b/i; // Fable N-1
const draftIntent = (t) => DRAFT_VERB.test(t) && !QUESTION.test(t) ? (/\bnewsletter\b/i.test(t) ? "newsletter" : /\bagenda\b/i.test(t) ? "agenda" : null) : null;
/** A starter picked with no empty chat open: open a new chat first, then apply it there. */
async function startTask(t) {
  if (t.go) { if (t.website !== undefined) websiteState.text = t.website; location.hash = t.go; return; }
  const r = await api("chat.conversation.create", {}); if (!r.ok) return;
  chatState.conversationId = r.result.conversationId; chatState.pending = t; location.hash === "#chat" ? route() : (location.hash = "#chat");
}
// WC-5 (Fable R-11): a tiny allowlisted markdown subset in agent replies, built as DOM nodes (createElement + text nodes,
// never innerHTML): paragraphs (blank line), line breaks, "- "/"* " and "1. " lists, **bold**, *italic* (at word edges, not on
// a list line: the list wins), `code`. No _italic_ (identifiers like search_org_history), no links (URLs stay text),
// no headings. One left-to-right scan per line; a marker without a closer stays literal, and once a search for a closer
// fails no later marker of that kind searches again, so the work is linear in the text.
// Pattern reference (no code lifted): snarkdown (MIT, github.com/developit/snarkdown) inline order: code, then bold, then italic.
function mdInline(s) {
  const nodes = []; let buf = "", i = 0, noTick = false, noBold = false;
  const flush = () => { if (buf) { nodes.push(document.createTextNode(buf)); buf = ""; } };
  const edge = (c) => c === undefined || /[\s.,;:!?)]/.test(c);
  while (i < s.length) {
    const c = s[i];
    if (c === "`" && !noTick) { const e = s.indexOf("`", i + 1); if (e < 0) noTick = true; else if (e > i + 1) { flush(); nodes.push(el("code", {}, s.slice(i + 1, e))); i = e + 1; continue; } }
    else if (c === "*" && s[i + 1] === "*" && !noBold) { const e = s.indexOf("**", i + 2); if (e < 0) noBold = true; else if (e > i + 2) { flush(); nodes.push(el("strong", {}, s.slice(i + 2, e))); i = e + 2; continue; } }
    else if (c === "*" && s[i + 1] !== "*" && (i === 0 || /[\s(]/.test(s[i - 1])) && s[i + 1] && !/\s/.test(s[i + 1])) {
      const e = s.indexOf("*", i + 1);
      if (e > i + 1 && !/\s/.test(s[e - 1]) && s[e + 1] !== "*" && edge(s[e + 1])) { flush(); nodes.push(el("em", {}, s.slice(i + 1, e))); i = e + 1; continue; }
    }
    buf += c; i++;
  }
  flush();
  return nodes;
}
// Polish P-1 (Fable R-1..R-3): citation markers become source chips. One regex per line finds "[path#Lx(-Ly)]" and bare
// "path#Lx(-Ly)" (bare: no whitespace; a following "." "," ")" stays text). A chip is made only when the path passes the
// fixed pattern (members/ or reviewers-private/, safe characters, .md/.txt/.csv, no ".." segment) and the lines are
// 1-6 digits; otherwise the marker stays literal text. The href is OURS ("#files?" + URLSearchParams), the label is text
// from a fixed mapping, the raw path is the title. Within one reply an identical path + range adds no second chip.
// USABILITY v1 (owner, Oct 19): replies also cite a file WITHOUT a line ("(`members/…/x.md`)", a bare path) and then bare
// "#L9–L17" markers (en dash). A path alone becomes a chip without a line; a bare "#L…" becomes a chip for the LAST path
// cited in the same reply (none yet: it stays text). Ranges accept "-" or "–". The path rules (CITE_PATH, no "..") are unchanged.
const CP = "(?:members|reviewers-private)\\/[A-Za-z0-9._\\/-]{1,300}?\\.(?:md|txt|csv)(?![A-Za-z0-9_\\/-])";
const CITE = new RegExp("\\[((?:members|reviewers-private)\\/[^\\]\\s#]{1,300})#L(\\d{1,6})(?:[-–]L?(\\d{1,6}))?\\]"
  + "|((?:members|reviewers-private)\\/[^\\s#[\\]]{1,300})#L(\\d{1,6})(?:[-–]L?(\\d{1,6}))?"
  + "|\\(\\s*`?(" + CP + ")`?\\s*\\)|`(" + CP + ")`|(^|[^\\w/])(" + CP + ")(?!#L\\d)"
  + "|(^|[^\\w/])#L(\\d{1,6})(?:[-–]L?(\\d{1,6}))?(?![\\w#])", "g");
// Fable F-2: NO lookbehind in this file (Safari/iOS before 16.4 would fail to parse it and the whole app would render
// nothing): the character before a bare path or a bare "#L" is captured (groups 9 and 11) and put back as text.
const CITE_PATH = /^(members|reviewers-private)\/[A-Za-z0-9._\/-]{1,300}\.(md|txt|csv)$/;
// P-1 N-1: pinned like dayLong/dayShort (en-US, UTC), so a chip reads "Oct 8" in every browser locale and time zone.
const shortDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) : d;
function citeLabel(path) {
  let m;
  if ((m = /^members\/website\/meeting-notes\/(\d{4}-\d{2}-\d{2})-/.exec(path))) return shortDay(m[1]) + " meeting notes";
  if ((m = /^members\/website\/newsletters\/(\d{4}-\d{2}-\d{2})-/.exec(path))) return shortDay(m[1]) + " newsletter";
  if (path === "members/website/events.md") return "Website events";
  if ((m = /^members\/notes\/(\d{4}-\d{2}-\d{2})\.v(\d+)\.md$/.exec(path))) return shortDay(m[1]) + " meeting notes" + (m[2] !== "1" ? " (version " + m[2] + ")" : "");
  return path.split("/").pop().replace(/\s+/g, " ").slice(0, 80);
}
// AGENT-HANDBOOK-V1 H2: handbook:vN#Lx and system-map:<run>#Lx markers become chips too. A handbook chip opens that version at the
// line (members-readable); a map chip opens the run's FROZEN map through the turn's / task's own audience-checked read (o.mapHref),
// and is plain (no link) where the page cannot name that run.
// Owner (live, Oct 26): the model wrote "handbook:v3#7" (no brackets, no L) and it stayed raw text. The marker is now matched with or
// without its brackets and with or without the "L" (a bare one needs a non-word character, or the line start, before it).
// No lookbehind (ui-labels: older Safari): the character before a bare marker is captured (group 1) and put back as text.
const CTX_CITE = /(\[|^|[^\w/:])(?:handbook:v(\d{1,4})|system-map:([A-Za-z0-9_]{1,80}))#L?(\d{1,4})(?:[-\u2013]L?(\d{1,4}))?(\])?/g;
function citeNodes(line, seen, o = {}) {
  const out = []; let at = 0;
  CTX_CITE.lastIndex = 0;
  for (let m; (m = CTX_CITE.exec(line)); ) {
    // The same small rule as file chips (af493adf N-2): a mark right after the marker goes before the chip when the text has none.
    const lead = m[1], g = [m[0], m[2], m[3], m[4], m[5]]; // g: the marker's groups as before (handbook version, map id, line, end line)
    if (lead === "[" && !m[6]) { CTX_CITE.lastIndex = m.index + 1; continue; } // "[" without its "]": not a marker
    let before = line.slice(at, m.index) + (lead === "[" ? "" : lead), end = m.index + m[0].length - (lead !== "[" && m[6] ? 1 : 0); // a bare marker's "]" stays text
    if (before.endsWith("`") && line[end] === "`") { before = before.slice(0, -1); end += 1; } // as file chips: no stray backticks
    const trimmed = before.replace(/\s+$/, ""), mark = /[.,;:!?]$/.test(trimmed) ? "" : /^[.,;:!?]/.exec(line.slice(end))?.[0] ?? "";
    out.push(...fileCiteNodes(trimmed + mark + (mark || trimmed !== before ? " " : ""), seen));
    const a = g[3], b = g[4] && g[4] !== a ? g[4] : null, where = b ? " · lines " + a + "\u2013" + b : " · line " + a;
    if (g[1]) out.push(el("a", { class: "cite-chip", href: "#handbook?" + new URLSearchParams({ version: g[1], line: a }), title: "handbook:v" + g[1] }, "Handbook v" + g[1] + where));
    else { const href = o.mapHref ? o.mapHref(g[2], a) : null;
      out.push(href ? el("a", { class: "cite-chip", href, title: "system map of this run" }, "System map" + where) : el("span", { class: "cite-chip", title: "system map of this run" }, "System map" + where)); }
    at = end + mark.length;
  }
  out.push(...fileCiteNodes(line.slice(at), seen));
  return out;
}
function fileCiteNodes(line, seen) {
  const nodes = []; let at = 0;
  CITE.lastIndex = 0;
  for (let m; (m = CITE.exec(line)); ) {
    const only = m[7] ?? m[8] ?? m[10], orphan = m[12] !== undefined, lead = m[9] ?? m[11] ?? "";
    const path = orphan ? seen.lastPath : m[1] ?? m[4] ?? only, a = orphan ? m[12] : m[2] ?? m[5] ?? null, b = orphan ? m[13] : m[3] ?? m[6];
    const ok = !!path && CITE_PATH.test(path) && !path.split("/").includes("..") && (a === null || (Number(a) >= 1 && (!b || Number(b) >= Number(a))));
    if (!ok) continue; // left as literal text
    // Director/Fable (af493adf N-2): a sentence mark right after the marker goes BEFORE the chip ("...5 PM. [chip]"), so no stray
    // "." sits after the chip's margin. The marker's own position is unchanged otherwise.
    // Owner (24 Oct): a marker the model wrapped in backticks (`[path#L2]`) shows as a chip, never with a stray ` on each side.
    let pre = line.slice(at, m.index) + lead, end = m.index + m[0].length;
    if (pre.endsWith("`") && line[end] === "`") { pre = pre.slice(0, -1); end += 1; }
    const trimmed = pre.replace(/\s+$/, ""), gap = trimmed !== pre ? " " : ""; // as before: one space only where the text had one
    // Only when the text before has no mark of its own ("PM [chip]." -> "PM. [chip]"); "offenses. [chip]." stays as it was.
    const punct = /[.,;:!?]$/.test(trimmed) ? "" : /^[.,;:!?]/.exec(line.slice(end))?.[0] ?? "";
    nodes.push(...mdInline(trimmed + punct + (punct ? " " : gap)));
    seen.lastPath = path;
    const key = path + "#" + (a ?? 0) + "-" + (b || a || 0);
    if (!seen.has(key)) {
      seen.add(key);
      nodes.push(el("a", { class: "cite-chip", href: "#files?" + new URLSearchParams(a ? { path, line: a } : { path }), title: path },
        citeLabel(path) + (a === null ? "" : b && b !== a ? " · lines " + a + "–" + b : " · line " + a)));
    }
    at = end + punct.length;
  }
  nodes.push(...mdInline(line.slice(at)));
  return nodes;
}
function mdNodes(text, o = {}) {
  const blocks = [], seen = new Set(); let para = null, list = null, table = null;
  for (const raw of String(text || "").split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    // Pipe tables (o.tables): task results and, since Package A2 (the owner's first live edit), chat answers. Cells are mdInline/citations.
    if (o.tables && /^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (table && table.rows.length === 1 && cells.every((c) => /^:?-{3,}:?$/.test(c))) { // the separator: row 1 is the header
        const r = table.rows[0]; for (const td of [...r.cells]) r.replaceChild(el("th", {}, ...td.childNodes), td); continue; }
      if (!table) { table = el("table", { class: "md-table" }); blocks.push(table); }
      table.append(el("tr", {}, ...cells.map((c) => el("td", {}, ...citeNodes(c, seen, o))))); para = null; list = null; continue;
    }
    table = null;
    // P-2 (Fable R-5): blocks before inline. A divider line (---, ***, ___) is checked before the list regex, so "***"
    // alone is a divider and "* item" a list item; "#".."######" + text is a bold heading line (no h1-h6 elements).
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { blocks.push(el("hr", {})); para = null; list = null; continue; }
    const hd = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (hd) { blocks.push(el("p", { class: "md-h" }, el("strong", {}, ...citeNodes(hd[1], seen, o)))); para = null; list = null; continue; }
    const ul = /^[ \t]*[-*] (.*)$/.exec(line), ol = ul ? null : /^[ \t]*\d{1,3}[.)] (.*)$/.exec(line);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      // A numbered list that starts after other text keeps the model's number ("3." shows 3, not 1).
      const n = ol ? Number(/^[ \t]*(\d+)/.exec(line)[1]) : 1;
      if (!list || list.tagName.toLowerCase() !== tag) { list = el(tag, n > 1 ? { start: String(n) } : {}); blocks.push(list); }
      para = null; list.append(el("li", {}, ...citeNodes((ul || ol)[1], seen, o))); continue;
    }
    // Owner (24 Oct): a blank line inside a list, or an indented line under an item, does not end it (no new list restarting at
    // "1."); the indented text continues the last item. Any other line ends the list as before.
    if (!line.trim()) { para = null; continue; }
    if (list && /^[ \t]{2,}\S/.test(raw)) { const li = list.lastElementChild; li.append(el("br", {}), ...citeNodes(line.trim(), seen, o)); continue; }
    list = null;
    if (!para) { para = el("p", {}); blocks.push(para); } else para.append(el("br", {}));
    para.append(...citeNodes(line, seen, o));
  }
  return blocks;
}
/** Owner (24 Oct): a task result is markdown; it renders as formatted text with chat's own renderer (DOM nodes only, never HTML;
 *  citations become the same file chips), on the task page and in Files -> Task results. */
const resultView = (text, taskId) => el("div", { class: "result-text md" }, ...mdNodes(text, { tables: true,
  mapHref: taskId ? (id, line) => "#map?" + new URLSearchParams({ task: taskId, id, line }) : null }));
async function chatView() {
  if (!me.chat) return [el("h1", {}, "Chat"), notice("Chat isn't set up for this org yet.", true)];
  let listed = (await api("chat.conversation.list")).result || { conversations: [], allowance: null };
  // Owner (Oct 23): every visit to Chat lands on a FRESH empty chat (the newest empty one is reused, else one is made); the
  // recent chats stay in the sidebar. Inside Chat (a sidebar click, a starter) the chosen chat stays.
  const freshChat = async () => { listed = (await api("chat.conversation.list")).result || listed; // read now: a chat may have been used since
    const e = listed.conversations.find((c) => c.empty); if (e) return e.conversationId;
    const r = await api("chat.conversation.create", {}); if (!r.ok) return null;
    listed = (await api("chat.conversation.list")).result || listed; return r.result.conversationId; };
  if (chatState.landing) { chatState.landing = false; if (!chatState.pending && !chatState.keep) chatState.conversationId = await freshChat() ?? chatState.conversationId; } // a starter (or Home's Recent) already chose its chat
  chatState.keep = false;
  const convs = listed.conversations;
  if (!chatState.conversationId || !convs.some((c) => c.conversationId === chatState.conversationId)) chatState.conversationId = convs[0]?.conversationId || null;
  const pane = el("section", { class: "chat-pane", "aria-live": "polite" }), side = el("aside", { class: "chat-list" });
  const newChat = el("button", { type: "button", class: "new-chat" }, "New chat");
  // Already on the empty chat: nothing to do (no redraw under the member's hands); else open the empty one.
  newChat.addEventListener("click", busy(newChat, async () => { const id = await freshChat(); if (id && id !== chatState.conversationId) { chatState.conversationId = id; route(); } }));
  // Owner (Oct 23): the list stays but is quiet: one line per chat, small and light; the conversation is the main thing.
  // Empty chats other than the open one are not listed (no pile of "New chat" lines).
  side.append(newChat, el("h3", { class: "recent" }, "Recent"), el("div", { class: "convs" }, ...convs.filter((c) => !c.empty || c.conversationId === chatState.conversationId).map((c) => { const a = el("a", { href: "#chat", class: "conv" + (c.conversationId === chatState.conversationId ? " on" : ""),
    title: (c.title || "New chat") + " · " + shortTime(c.lastAt) }, el("strong", {}, c.title || "New chat"), el("small", {}, shortTime(c.lastAt)));
    a.addEventListener("click", (e) => { e.preventDefault(); chatState.conversationId = c.conversationId; route(); }); return a; })));
  if (chatState.conversationId) await drawConversation(pane, chatState.conversationId, listed.allowance);
  else pane.append(el("p", { class: "note" }, "Ask about meeting notes, events and past newsletters, or draft a newsletter."), starterGrid(startTask));
  // CP cleanup (Oct 18): no capability/status panel; the page is the conversation. The heading stays for screen readers.
  return [el("h1", { class: "sr-only" }, "Chat"), el("div", { class: "chat-grid" }, side, pane)];
}
async function drawConversation(pane, conversationId, allowance) {
  const r = await api("chat.conversation.read", { conversationId });
  if (!r.ok) return pane.replaceChildren(refusal(r));
  const v = r.result, msgs = el("div", { class: "msgs" }), status = el("div");
  // WC-4: the title (from the first message, or the starter's own); the starter can rename it.
  const head = el("div", { class: "row conv-head" }, el("h2", {}, v.conversation.title || "New chat"));
  const listed = document.querySelector("a.conv.on strong"); if (listed) listed.textContent = v.conversation.title || "New chat"; // the list follows the title
  if (!v.adminRead) {
    const rename = el("button", { type: "button", class: "link-btn" }, "Rename");
    rename.addEventListener("click", () => {
      const input = el("input", { type: "text", maxlength: "120", "aria-label": "Chat title" }), save = el("button", { type: "button", class: "btn" }, "Save");
      input.value = v.conversation.title || "";
      save.addEventListener("click", busy(save, async () => { const x = await api("chat.conversation.rename", { conversationId, title: input.value });
        if (!x.ok) return head.append(refusal(x)); route(); }));
      head.replaceChildren(input, save); input.focus();
    });
    head.append(rename);
  }
  // Owner (Oct 23): an empty chat is a bare page: no heading or Rename, only the small privacy line, the starters and the box.
  const bare = !v.messages.length && !(v.uploads || []).length && !(v.images || []).length;
  pane.replaceChildren(bare ? "" : head, el("p", { class: "disclosure" }, v.conversation.disclosure + (allowance ? " · " + allowance.remaining + " of " + allowance.limit + " turns left today" : "")));
  // USABILITY v1: a draft version sits right under the reply that made it (same turn); others follow the conversation.
  const byTurn = new Map(); for (const a of v.artifacts) byTurn.set(a.turn_id, [...(byTurn.get(a.turn_id) || []), a]);
  const lastVersion = new Map(); for (const a of v.artifacts) lastVersion.set(a.artifact_id, Math.max(lastVersion.get(a.artifact_id) || 0, a.version));
  for (const m of v.messages) {
    msgs.append(el("div", { class: "msg " + m.role }, el("div", { class: "who" }, m.role === "user" ? "You" : "Agent"),
      m.role === "assistant" ? el("div", { class: "md" }, ...mdNodes(m.text, { tables: true, mapHref: (id, line) => "#map?" + new URLSearchParams({ turn: id, line }) })) : el("p", {}, m.text)));
    if (m.role === "assistant") { for (const a of byTurn.get(m.turnId) || []) msgs.append(artifactCard(a, conversationId, a.version === lastVersion.get(a.artifact_id))); byTurn.delete(m.turnId); }
  }
  pane.append(msgs);
  if (v.envelope) pane.append(el("div", { class: "card plan on" }, el("strong", {}, "Draft plan approved"), el("span", { class: "note" },
    " · " + v.envelope.capability + " · " + v.envelope.turnsLeft + " turns and $" + v.envelope.usdLeft.toFixed(2) + " left")));
  for (const rest of byTurn.values()) for (const a of rest) pane.append(artifactCard(a, conversationId, a.version === lastVersion.get(a.artifact_id)));
  // PACKAGE P (never silent): a link the member asked for that the latest draft turn left out, in plain words (the runtime's check).
  for (const u of v.linkGaps?.missing || []) pane.append(el("div", { class: "notice link-gap", role: "status" }, "Your link ", el("span", { class: "mono" }, u), " isn't in this draft."));
  // P2 (the same owner turn): whatever the wording, a reply to a message naming a newsletter or agenda, with no plan open and no
  // draft yet, offers the plan card (the ONLY way to let the agent save a draft; nothing happens until it is approved).
  const lastUser = [...v.messages].reverse().find((m) => m.role === "user"), cap = lastUser && /\bnewsletter\b/i.test(lastUser.text) ? "newsletter" : lastUser && /\bagenda\b/i.test(lastUser.text) ? "agenda" : null;
  if (cap && !v.envelope && !v.adminRead && v.messages.at(-1)?.role === "assistant" && !v.artifacts.some((a) => a.kind === cap)) {
    const show = el("button", { type: "button", class: "btn secondary" }, "Show the plan");
    show.addEventListener("click", busy(show, () => planCard(pane, conversationId, cap, status)));
    pane.append(el("div", { class: "notice plan-offer", role: "status" }, "To let the agent save a " + cap + " draft, approve a draft plan here in this chat. ", show));
  }
  // IMAGES-V1 I1: the chat's images (sanitized copies; the bytes come through the authenticated image route, never a URL).
  if (v.images?.length) pane.append(el("div", { class: "chat-images" }, v.images.map((im) => el("figure", { class: "chat-image" },
    el("img", { src: `/o/${org}/image/${im.imageId}`, alt: "Attached image", width: String(Math.min(im.width, 240)), loading: "lazy" }),
    el("figcaption", { class: "note" }, "Only you can see this image · " + im.width + "×" + im.height),
    driveSave(im, status),
    me.imageExtract && !(v.flyers || []).some((p) => p.imageId === im.imageId && p.state === "proposed") ? readFlyer(im, pane, conversationId, allowance) : null))));
  // IMAGES-V1 I2: each proposal read from a flyer, for the member to check.
  for (const p of v.flyers || []) pane.append(flyerCard(p, pane, conversationId, allowance));
  for (const u of v.uploads) {
    const share = el("button", { type: "button", class: "secondary" }, "Share with everyone");
    share.addEventListener("click", busy(share, async () => { const x = await api("chat.upload.share", { uploadId: u.uploadId }); status.replaceChildren(x.ok ? notice("Shared with the whole organization.") : refusal(x)); if (x.ok) route(); }));
    pane.append(el("div", { class: "item upload" }, el("span", {}, "📎 " + u.name), el("span", { class: "note" }, u.sharedPath ? "Shared" : "Only this chat"), u.sharedPath ? null : share));
  }
  const text = el("textarea", { id: "chat-text", class: "composer-text", placeholder: "Ask a question, or ask for a draft…" });
  text.value = chatState.drafts[conversationId] || "";
  text.addEventListener("input", () => { chatState.drafts[conversationId] = text.value; });
  // USABILITY v1: the starters on an empty chat; a prefill puts the words in the box and focuses it (nothing is sent).
  const pick = async (t) => { if (t.plan) return planCard(pane, conversationId, t.plan, status, t.typed, undefined, t.heading); if (t.prefill) { text.value = chatState.drafts[conversationId] = t.prefill; text.focus(); return; }
    // THREE-JOBS J1: Home's "Ask anything" sends exactly what was typed, as the Send button would (a draft request opens its plan card).
    if (t.ask) { text.value = chatState.drafts[conversationId] = t.ask; send.click(); return; }
    await startTask(t); };
  // A chat opened from a task result goes straight to its plan card (no starter suggestions in between).
  if (!v.messages.length && !(chatState.pending?.fromTask && conversationId === chatState.conversationId)) pane.append(starterGrid(pick));
  const send = el("button", { type: "button", class: "btn" }, "Send"), stop = el("button", { type: "button", class: "secondary", hidden: true }, "Stop");
  const file = el("input", { type: "file", id: "chat-file", class: "sr-only", accept: TEXT_ACCEPT });
  file.addEventListener("change", async () => { const f = file.files?.[0]; if (!f) return; file.value = "";
    if (/\.(md|txt|csv)$/i.test(f.name) && f.size > 48 * 1024) return status.replaceChildren(notice(say("chat_upload_too_large"), true));
    let r; try { r = await readTextFile(f); } catch { return status.replaceChildren(notice(say("chat_upload_unreadable"), true)); }
    if (!r) return status.replaceChildren(notice(say("chat_upload_type_not_admitted"), true));
    if (new TextEncoder().encode(r.text).length > 48 * 1024) return status.replaceChildren(notice(say("chat_upload_too_large"), true));
    const x = await api("chat.upload", { conversationId, fileName: r.name, text: r.text });
    status.replaceChildren(x.ok ? notice(r.converted ? `Added to this chat as ${r.name} (the text of ${f.name}).` : "Added to this chat.") : refusal(x)); if (x.ok) drawConversation(pane, conversationId, allowance); });
  // IMAGES-V1 I1: attach ONE flyer/image: mint a single-use upload for this chat, then stream the file (the hub buffers nothing).
  const img = me.images ? el("input", { type: "file", id: "chat-image", class: "sr-only", accept: "image/jpeg,image/png,image/webp" }) : null;
  if (img) img.addEventListener("change", async () => { const f = img.files?.[0]; img.value = ""; if (!f) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(f.type)) return status.replaceChildren(notice(say("image_type_not_admitted"), true));
    if (f.size > 4 * 1024 * 1024) return status.replaceChildren(notice(say("image_too_large"), true));
    status.replaceChildren(el("p", { class: "note" }, "Uploading and cleaning the image…"));
    const t = await api("image.upload", { conversationId, size: f.size, contentType: f.type });
    if (!t.ok) return status.replaceChildren(refusal(t));
    const r = await fetch(`/o/${org}/upload/${t.result.uploadId}`, { method: "PUT", headers: { "content-type": f.type }, credentials: "same-origin", body: f })
      .then((x) => x.json()).catch(() => ({ ok: false, error: "image_upload_aborted" }));
    if (!r.ok) return status.replaceChildren(notice(say(r.error), true));
    chatState.notice = { conversationId, label: r.deduplicated ? "image_attached_again" : "image_attached", error: false };
    drawConversation(pane, conversationId, allowance); });
  send.addEventListener("click", busy(send, async () => { if (!text.value.trim()) return;
    const intent = v.envelope || v.adminRead ? null : draftIntent(text.value);
    const typed = text.value, sent = async () => { chatState.drafts[conversationId] = ""; text.value = ""; await runTurn(pane, conversationId, typed, { send, stop, status, msgs }); };
    if (intent) return planCard(pane, conversationId, intent, status, typed, sent);
    await sent(); }));
  // USABILITY v1 (c): reviewers carry what they typed to the Website page's request form (chat can't change the website).
  const toWebsite = me.website && reviewerRole() ? el("a", { href: "#website", class: "attach" }, "Propose a website change") : null;
  // TEAM-TASKS-V1 T2b: "Make this a task" carries ONLY what the member typed (and lets them pick this chat's text files on the
  // Tasks page, where the exact copy and its audience are shown before anything is created). Chat history never goes.
  const toTask = me.teamTasks ? el("a", { href: "#tasks", class: "attach" }, "Make this a task") : null;
  if (toTask) toTask.addEventListener("click", () => { taskState.adopt = { text: text.value.trim(), uploads: (v.uploads || []).map((u) => ({ uploadId: u.uploadId, name: u.name, bytes: u.bytes })) }; });
  if (toWebsite) toWebsite.addEventListener("click", () => { websiteState.text = text.value.trim(); });
  const n = chatState.notice;
  if (n && n.conversationId === conversationId) {
    chatState.notice = null;
    // WC-3: nothing to read yet: say so plainly and point to Files.
    status.replaceChildren(n.label === "chat_no_files" ? el("div", { class: "notice", role: "status" }, say("chat_no_files") + " ", el("a", { href: "#files" }, "Open Files"))
      : notice(say(n.label), n.error));
  }
  // Owner (Oct 23): like a chat app: the box is the main thing; the four actions live in one "+" menu (a native <details>).
  const actions = el("details", { class: "actions" }, el("summary", { "aria-label": "More actions", title: "Attach or more" }, "+"),
    el("div", { class: "menu" }, el("label", { for: "chat-file" }, "Attach a text file"), img ? el("label", { for: "chat-image" }, "Attach a flyer/image") : null, toWebsite, toTask));
  actions.querySelector(".menu").addEventListener("click", () => { actions.open = false; }); // a choice closes the menu
  pane.append(status, el("div", { class: "composer" }, text, el("div", { class: "composer-bar" }, actions, file, img, el("span", { class: "spacer" }), stop, send)));
  const p = chatState.pending;
  if (p && conversationId === chatState.conversationId && !v.messages.length) { chatState.pending = null; await pick(p); }
}
// IMAGES-V1 I2 (design §2): reading a flyer sends it to the hosted model, so the member is told BEFORE anything is sent.
// Owner (Oct 23): one step: the notice is a small line next to the button, always shown before the click; the click reads.
const FLYER_NOTICE = "Reading sends this flyer to the configured hosted model (Claude, through OpenRouter, with no data retention). Nothing is published.";
function readFlyer(im, pane, conversationId, allowance) {
  const go = el("button", { type: "button", class: "btn secondary" }, "Read this flyer"), out = el("div");
  go.addEventListener("click", busy(go, async () => { out.replaceChildren(el("p", { class: "note" }, "Reading the flyer…"));
    const r = await api("image.extract", { imageId: im.imageId }); if (!r.ok) return out.replaceChildren(refusal(r)); drawConversation(pane, conversationId, allowance); }));
  return el("div", { class: "read-flyer" }, go, el("p", { class: "note flyer-notice" }, FLYER_NOTICE), out);
}
// Fable I2b note: the same per-field bounds as the runtime (flyer.ts / extract.ts).
const FLYER_MAX = { title: 200, date: 120, time: 80, location: 200, address: 300, description: 1000 };
const FLYER_LABELS = { title: "Title", date: "Date (YYYY-MM-DD)", time: "Time", location: "Place", address: "Address", description: "Description" };
/** "From the flyer — check this": each field editable, with the wording printed on the flyer beside it; nothing is trusted. */
function flyerCard(p, pane, conversationId, allowance) {
  if (p.state === "failed") return el("div", { class: "card flyer" }, el("strong", {}, "Flyer not read"), notice(say(p.label), true));
  if (p.state === "unsettled" || p.state === "running") return el("div", { class: "card flyer" }, el("strong", {}, "Flyer reading"), notice(p.state === "running" ? "Reading the flyer…" : "We couldn't confirm the result of reading this flyer. An admin will check it.", p.state !== "running"));
  const f = p.proposed.fields, inputs = {}, status = el("div");
  const rows = Object.keys(FLYER_LABELS).map((k) => {
    const id = "fl-" + p.proposalId + "-" + k, value = (p.checked ? p.checked[k] : f[k].value) ?? "";
    const input = k === "description" ? el("textarea", { id, class: "flyer-text", maxlength: "1000" }) : el("input", { type: "text", id, maxlength: String(FLYER_MAX[k]) });
    input.value = value; inputs[k] = input;
    const hint = k === "date" && f.date.raw && !f.date.value && !p.checked ? "The year isn't printed: enter the full date yourself." : k === "description" ? "A draft based on the flyer, not a quotation." : null;
    return el("div", { class: "flyer-field" }, el("label", { for: id }, FLYER_LABELS[k]), input,
      el("p", { class: "note" }, f[k].raw ? "Printed: “" + f[k].raw + "”" : "Not printed on the flyer"), hint ? el("p", { class: "note warn-note" }, hint) : null);
  });
  const tag = p.checked ? el("span", { class: "tag ok" }, "Checked by you · " + shortTime(p.checkedAt)) : el("span", { class: "tag warn" }, "Not checked yet");
  // Owner (Oct 23): no separate Save. Each field saves when you leave it; "Add to the website" saves and carries the details over.
  const fields = () => Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value]));
  let saved = JSON.stringify(p.checked ? Object.fromEntries(Object.keys(FLYER_LABELS).map((k) => [k, p.checked[k] ?? ""])) : null);
  const save = async () => {
    const now = fields(); if (JSON.stringify(now) === saved) return { ok: true, result: null };
    const r = await api("image.proposal.save", { proposalId: p.proposalId, fields: now });
    if (r.ok) { saved = JSON.stringify(now); p.checked = r.result.checked; p.checkedAt = r.result.checkedAt; status.replaceChildren(el("p", { class: "note", role: "status" }, "Saved."));
      tag.className = "tag ok"; tag.textContent = "Checked by you · " + shortTime(p.checkedAt); }
    else status.replaceChildren(refusal(r));
    return r;
  };
  for (const i of Object.values(inputs)) i.addEventListener("change", () => { void save(); });
  return el("div", { class: "card flyer" }, el("div", { class: "row" }, el("strong", {}, "From the flyer — check this"), tag),
    el("p", { class: "note" }, "The model read these from the flyer. Check every field before using them; it can be wrong. Your edits are saved as you go."),
    p.proposed.notes ? el("p", { class: "note" }, "Note: " + p.proposed.notes) : null, ...rows, status, el("div", { class: "row" }, useOnWebsite(p, save)));
}
/** IMAGES-V1 I3: a reviewer's CHECKED flyer opens the Website form with its details and image (nothing is sent from here). */
function useOnWebsite(p, save) {
  if (!(me.website && reviewerRole())) return null;
  const go = el("button", { type: "button", class: "btn" }, "Add to the website");
  go.addEventListener("click", busy(go, async () => {
    const r = await save(); if (!r.ok) return; // the checked details are what the request carries (runtime: image_proposal_not_checked otherwise)
    const c = p.checked, parts = [c.title, c.date && "on " + c.date, c.time && "at " + c.time, c.location && "at " + c.location, c.address && "(" + c.address + ")"].filter(Boolean);
    websiteState.text = "Add this event to the website: " + parts.join(" ") + "." + (c.description ? " Description: " + c.description : "");
    websiteState.flyer = { proposalId: p.proposalId, imageId: p.imageId };
    location.hash = "#website";
  }));
  // Fable N-1 (516491d0): an untouched card promotes the model's values on this click; say so.
  return el("div", { class: "add-website" }, go, el("p", { class: "note" }, "This also saves the details above as checked by you."));
}
// ---- TEAM-TASKS-V1 T2b: Tasks (design §1-§4; Fable T1 N-1, N-3, N-5). Every model-written or member-written string is a text
// node (el() children), never HTML. Members see profile/executor ids, never hashes. The scheduler fact is the runtime's.
const TASK_STATES = { proposed: ["Proposed", "warn"], superseded: ["Replaced by a newer plan", ""], approved: ["Approved (queued)", ""], running: ["Running", ""],
  result_ready: ["Result ready", "ok"], failed: ["Failed", "bad"], cancelled: ["Cancelled", ""], needs_reconciliation: ["Needs reconciliation", "bad"] };
const taskTag = (state) => { const [label, cls] = TASK_STATES[state] || [state, ""]; return el("span", { class: "tag " + cls }, label); };
const kb = (n) => n < 1024 ? n + " bytes" : Math.round(n / 1024) + " KB";
function schedulerNote(f) {
  if (!f) return null;
  if (f.paused) return notice("Team tasks are paused by an admin. Approved tasks wait until they are resumed.", true);
  if (f.anotherRunInProgress) return notice("Another run is in progress (a chat answer or a team task). Approved tasks start when it ends; a long task can take several minutes." + (f.queued ? " Waiting: " + f.queued + "." : ""));
  return f.queued ? notice(f.queued + " approved " + (f.queued === 1 ? "task is" : "tasks are") + " waiting to start.") : null;
}
async function tasksView() {
  // Owner (Oct 23): the Tasks tab is the team's list; the main way in is a chat's "+" → "Make this a task".
  // Owner brief ("It looks a little complicated"): one line; the "+ Make this a task" way in stays on the chat's "+" menu.
  const out = [el("h1", {}, "Tasks"), el("p", { class: "lede" }, "Work the agent does for the team. A reviewer approves each run; nothing is sent.")];
  if (!me.teamTasks) return [...out, notice("Tasks aren't set up for this organization.")];
  const q = new URLSearchParams((location.hash.split("?")[1] || "")), open = q.get("id");
  if (open) return [...out, await taskDetail(open)];
  if (q.get("schedule")) return [...out, await scheduleReview(q.get("schedule"))];
  const l = await api("teamtask.list", {});
  if (!l.ok) return [...out, refusal(l)];
  const form = newTaskForm();
  out.push(schedulerNote(l.result.scheduler) || "");
  const tasks = l.result.tasks || [];
  // Owner (Oct 23): finished work stays findable: open tasks first; done ones (with their results) under "Completed".
  const row = (t) => { const last = t.attempts.at(-1);
    return el("li", { class: "item" }, el("div", {}, el("a", { href: "#tasks?id=" + t.taskId }, t.title),
      el("div", { class: "meta" }, (t.creatorId === me.memberId ? "Yours" : "Team") + " · " + (t.audience === "members" ? "all members" : "reviewers and admins") + " · " +
        (t.state === "done" && t.done ? "done " + shortTime(t.done.at) : shortTime(t.createdAt)))),
      t.state === "done" ? el("span", { class: "tag ok" }, "Done") : t.state === "cancelled" ? el("span", { class: "tag" }, "Cancelled") : last ? taskTag(last.state) : el("span", { class: "tag" }, "No plan yet")); };
  // Owner (24 Oct): the top is work in progress (no plan yet / Proposed / Approved / Running / Result ready / a failed run to redo);
  // below, two quiet collapsed groups: "Completed (n)" (done), then "Didn't finish (n)" (failed or cancelled runs, cancelled tasks).
  // Owner brief + Director/Fable (af493adf N-1): an OPEN task whose last run failed or was stopped can be run again, so it stays on
  // top with its tag; "Didn't finish" holds what leaves the member nothing to do: cancelled tasks and runs an admin must check.
  const stopped = (t) => t.state === "cancelled" || (t.state === "open" && t.attempts.at(-1)?.state === "needs_reconciliation");
  const active = tasks.filter((t) => t.state === "open" && !stopped(t)), done = tasks.filter((t) => t.state === "done"), unfinished = tasks.filter(stopped);
  const group = (id, label, list) => list.length ? el("details", { class: "completed", id }, el("summary", {}, label + " (" + list.length + ")"), el("ul", { class: "list" }, list.map(row))) : "";
  const completed = group("completed", "Completed", done), didnt = group("unfinished", "Didn't finish", unfinished);
  if (completed && (location.hash.split("?")[1] || "").includes("completed")) completed.open = true;
  const teamCard = el("div", { class: "card team-tasks" }, el("h2", {}, "Team tasks"), active.length ? el("ul", { class: "list" }, active.map(row)) : el("p", { class: "note" }, tasks.length ? "Nothing in progress." : "No tasks yet."), completed, didnt);
  out.push(teamCard);
  // SCHEDULED-TASKS-V1 S2: schedules (status, history, pause) and their in-app notices, when Ops has set schedules up.
  const sl = await api("teamtask.schedule.list", {});
  if (sl.ok) { out.push(schedulesCard(sl.result)); const n = scheduleNotices(sl.result.notifications || []); if (n) teamCard.insertBefore(n, teamCard.children[1] ?? null); } // owner brief: notices in the list, not a box
  out.splice(2, 0, form); // Owner (Oct 23): "New task" is a prominent button at the TOP; it opens the form in place
  return out;
}
/** SCHEDULED-TASKS-V1 S2: in-app notices: a fixed sentence with the schedule's own name and the run's date, and a link. Never
 *  text from the result. The runtime only sends notices (and names) the member's current role may see. */
const day = (localDate) => { try { return new Date(localDate + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return localDate; } };
const SCHEDULE_NOTICES = { result_ready: (n, d) => n + " for " + d + " is ready", failure: (n, d) => n + " for " + d + " didn't finish",
  incident: (n) => n + " was paused", missed_warning: (n) => n + " missed three runs in a row" };
function scheduleNotices(list) {
  if (!list.length) return null;
  return el("div", { class: "schedule-notices", role: "region", "aria-label": "Schedule notices" }, el("ul", { class: "list" }, list.slice(0, 5).map((x) => {
    const text = (SCHEDULE_NOTICES[x.kind] || (() => "Schedule notice"))(x.title || "A schedule", day(x.localDate));
    return el("li", { class: "item" }, el("div", {}, x.taskId ? el("a", { href: "#tasks?id=" + x.taskId }, text) : el("strong", {}, text),
      x.label && x.kind !== "result_ready" && x.label !== "teamtask_schedule_paused" ? el("div", { class: "meta" }, say(x.label)) : "")); })));
}
const WEEKDAYS = ["", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];
const clock = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return (h % 12 || 12) + ":" + String(m).padStart(2, "0") + (h < 12 ? " AM" : " PM"); };
const SCHEDULE_STATES = { proposed: ["Waiting for approval", "warn"], active: ["Active", "ok"], paused: ["Paused", "warn"], expired: ["Ended", ""], superseded: ["Replaced", ""] };
const OCCURRENCE_WORDS = { due: "Waiting to start", admitted: "Running or queued", result_ready: "Draft ready", partial: "Cut off (not a finished draft)", failed: "Failed",
  cancelled: "Stopped", uncertain: "Needs an admin check", skipped: "Skipped" };
/** Owner (render review): one line per schedule plus its button; the rest behind "Recent runs". */
function schedulesCard(l) {
  const status = el("div", { "aria-live": "polite" }), body = el("ul", { class: "list" });
  const act = (label, cls, fn) => { const b = el("button", { type: "button", class: cls }, label);
    b.addEventListener("click", busy(b, async () => { const x = await fn(); if (x && !x.ok) return status.replaceChildren(refusal(x)); route(); })); return b; };
  const r = l.runner || {};
  const head = el("div", { class: "row" }, el("h2", {}, "Schedules"),
    reviewerRole() ? (l.pausedAll ? act("Resume all schedules", "btn secondary", () => approve("teamtask.schedule.resume", { all: true })) : act("Pause all schedules", "btn secondary", () => api("teamtask.schedule.pause.all", {}))) : "");
  const facts = [!r.run ? "Scheduled runs are switched off by an admin; nothing starts on its own." : l.pausedAll ? "All schedules are paused. Nothing starts on its own until a reviewer resumes them." : null,
    r.run && r.busy ? "Another run is in progress. A scheduled run waits for it, up to a day." : null].filter(Boolean);
  if (!l.schedules.length) body.append(el("li", { class: "note" }, "No schedules yet."));
  for (const s of l.schedules) {
    const d = s.definition, [label, cls] = SCHEDULE_STATES[s.state] || [s.state, ""], mine = d.proposedBy === me.memberId;
    const reason = s.label && s.state !== "active" && s.label !== "teamtask_schedule_paused" ? say(s.label) : null;
    const line = WEEKDAYS[d.recurrence.weekday] + " at " + clock(d.recurrence.time) + (s.state === "active" && s.next?.length ? " · next " + day(s.next[0].localDate) : "");
    const history = (s.occurrences || []).slice(0, 5).map((o) => el("li", {}, (o.localDate ? day(o.localDate) : "Run now") + " · " + (OCCURRENCE_WORDS[o.state] || o.state) +
      (o.label && o.state !== "result_ready" && o.label !== "teamtask_schedule_paused" ? " · " + say(o.label) : ""), o.taskId ? [" · ", el("a", { href: "#tasks?id=" + o.taskId }, "Open")] : ""));
    // H2 (D-3): a schedule paused because the agent's setup changed (incl. a new handbook) is never re-pinned silently: "Review again"
    // proposes a copy under its existing caps and END DATE with the current setup, then the usual review card and approval.
    const reviewAgain = () => act("Review again", "btn secondary", async () => {
      const r = await api("teamtask.schedule.propose", { scheduleId: s.scheduleId, title: d.title, audience: d.audience, template: d.template, sources: d.sources, recurrence: d.recurrence,
        mode: d.mode, limits: d.limits, budget: d.budget, endDate: d.endDate });
      if (r.ok) { location.hash = "#tasks?schedule=" + s.scheduleId; return null; } return r; });
    const button = s.state === "active" && (mine || reviewerRole()) ? act("Pause", "btn secondary", () => api("teamtask.schedule.pause", { scheduleId: s.scheduleId }))
      : s.state === "paused" && reviewerRole() && s.label === "teamtask_schedule_pin_changed" ? reviewAgain()
      // Package F (Fable delta A Addendum 2, Ops' finding): ANY other paused schedule offers Resume AND Review again, so one paused by
      // hand before a pin-moving deploy (Resume then refuses) is never stuck.
      : s.state === "paused" && reviewerRole() ? el("span", { class: "row" }, act("Resume", "btn secondary", () => approve("teamtask.schedule.resume", { scheduleId: s.scheduleId }, s.digest)), reviewAgain())
      : s.state === "proposed" ? el("a", { href: "#tasks?schedule=" + s.scheduleId, class: "btn secondary" }, reviewerRole() ? "Review and approve" : "Review") : "";
    const runNow = s.state === "active" && reviewerRole() ? el("div", { class: "row" }, act("Run now", "btn secondary", () => approve("teamtask.schedule.run_now", { scheduleId: s.scheduleId })),
      el("span", { class: "note" }, "One extra run now, inside this schedule's monthly budget.")) : "";
    body.append(el("li", { class: "item schedule", "data-schedule": s.scheduleId },
      el("div", { class: "schedule-main" }, el("div", { class: "row" }, el("strong", {}, d.title), el("span", { class: "tag " + cls }, label)),
        el("div", { class: "meta" }, line), reason ? el("div", { class: "meta" }, reason) : "",
        el("details", { class: "schedule-history" }, el("summary", {}, "Recent runs"),
          el("p", { class: "note" }, "Visible to " + (d.audience === "members" ? "all members" : "reviewers and admins") + " · until " + day(d.endDate) +
            " · this month $" + s.budget.usedUsd.toFixed(2) + " of $" + s.budget.monthlyUsd.toFixed(2) + " (resets monthly)"),
          s.chatWaitNote ? el("p", { class: "note" }, s.chatWaitNote) : "",
          el("p", { class: "note" }, "Each run is a draft for the team; nothing is sent or published."),
          history.length ? el("ul", {}, history) : el("p", { class: "note" }, "No runs yet."), runNow)), button));
  }
  return el("div", { class: "card schedules", id: "schedules" }, head, ...facts.map((f) => notice(f)), newScheduleForm(l), body, status);
}
/** SCHEDULED-TASKS-V1 S3: the weekly editor. Start from one of the three named templates or write your own; nothing runs until a
 *  reviewer approves the exact schedule on its review card. The runtime validates everything (sources per audience, limits). */
const SCHEDULE_INPUT_WORDS = "Check the schedule: a name, a one-line draft title, instructions up to 3,000 characters using only {{date}}, {{since}} and {{until}}, and an end date within 90 days.";
const PLACEHOLDER_NOTE = "You can use {{date}} (the run's date), {{since}} (the date of the last finished draft) and {{until}} (13 days after the run's date).";
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
function newScheduleForm(l) {
  const templates = l.templates || [], collections = l.collections || [];
  const pick = el("select", { id: "sch-template" }, ...templates.map((t) => el("option", { value: t.id }, t.title)), el("option", { value: "" }, "Your own"));
  const name = el("input", { type: "text", id: "sch-title", maxlength: "150" }), draft = el("input", { type: "text", id: "sch-draft-title", maxlength: "150" });
  const notes = el("textarea", { id: "sch-notes", maxlength: "3000" });
  const boxes = collections.map((c, i) => ({ c, box: el("input", { type: "checkbox", id: "sch-src-" + i, value: c.root }) }));
  const onlyNew = el("input", { type: "checkbox", id: "sch-new" });
  const dayPick = el("select", { id: "sch-day" }, ...WEEKDAYS.slice(1).map((d, i) => el("option", { value: String(i + 1) }, d.slice(0, -1))));
  const time = el("input", { type: "time", id: "sch-time", value: "06:00", step: "300" });
  const peak = el("p", { class: "note", "aria-live": "polite" });
  const showPeak = () => { const h = Number((time.value || "06:00").slice(0, 2)); peak.textContent = h >= 8 && h < 20 ? "A run at this time can make a live chat answer wait up to 8 minutes. 6:00 AM is the default." : ""; };
  time.addEventListener("input", showPeak);
  const end = el("input", { type: "date", id: "sch-end", value: plusDays(89), min: plusDays(1), max: plusDays(89) /* the runtime caps 90 days in the schedule's zone */ });
  const audience = reviewerRole() ? el("select", { id: "sch-audience" }, el("option", { value: "members" }, "All members"), el("option", { value: "reviewers-private" }, "Reviewers and admins only")) : null;
  const mode = reviewerRole() ? el("select", { id: "sch-mode" }, el("option", { value: "recurring_drafts" }, "Run automatically each week (drafts only)"), el("option", { value: "propose_each" }, "Plan each week; a reviewer approves each run")) : null;
  const fill = () => { const t = templates.find((x) => x.id === pick.value);
    name.value = t ? t.title : ""; draft.value = t ? t.template.title : ""; notes.value = t ? t.template.notes : "";
    for (const b of boxes) b.box.checked = !!t && t.roots.includes(b.c.root);
    onlyNew.checked = t ? t.rule === "new" : true; dayPick.value = String(t ? t.weekday : 1); };
  pick.addEventListener("change", fill); fill(); showPeak();
  const out = el("div", { "aria-live": "polite" }), go = el("button", { type: "button", class: "btn" }, "Review schedule");
  go.addEventListener("click", busy(go, async () => {
    if (!boxes.some((b) => b.box.checked)) return out.replaceChildren(notice("Choose at least one set of files it can use.", true));
    const r = await api("teamtask.schedule.propose", { title: name.value, template: { title: draft.value, notes: notes.value },
      sources: { roots: boxes.filter((b) => b.box.checked).map((b) => b.c.root), rule: onlyNew.checked ? "new" : "current" },
      recurrence: { weekday: Number(dayPick.value), time: time.value || "06:00" }, endDate: end.value, ...(audience ? { audience: audience.value } : {}), ...(mode ? { mode: mode.value } : {}) });
    if (!r.ok) return out.replaceChildren(r.error === "teamtask_input_invalid" ? notice(SCHEDULE_INPUT_WORDS, true) : refusal(r));
    location.hash = "#tasks?schedule=" + r.result.scheduleId;
  }));
  // Owner (render review): the default view is Start from, Name, Every [day] at [time], Files it can use and Review schedule; the
  // draft title, the instructions (templates fill them in) and the less common options are collapsed. The limits are on the review card.
  const instructions = el("details", { class: "sch-more", id: "sch-instructions" }, el("summary", {}, "Edit instructions"),
    el("label", { for: "sch-draft-title" }, "Title of each draft"), draft, el("label", { for: "sch-notes" }, "Instructions for each run"), notes, el("p", { class: "note" }, PLACEHOLDER_NOTE));
  const more = el("details", { class: "sch-more", id: "sch-options" }, el("summary", {}, "More options"),
    audience ? el("div", { class: "row" }, el("label", { for: "sch-audience" }, "Who can see the drafts"), audience) : el("p", { class: "note" }, "All members can see the drafts."),
    mode ? el("div", { class: "row" }, el("label", { for: "sch-mode" }, "Each week"), mode) : "",
    el("div", { class: "row" }, el("label", { for: "sch-end" }, "Ends on"), end), el("p", { class: "note" }, "Up to 90 days; continuing after that needs a new approval."));
  const box = el("details", { class: "new-schedule", id: "new-schedule" }, el("summary", {}, "New schedule"),
    el("label", { for: "sch-template" }, "Start from"), pick, el("label", { for: "sch-title" }, "Name"), name,
    el("div", { class: "row sch-when" }, el("label", { for: "sch-day" }, "Every"), dayPick, el("label", { for: "sch-time" }, "at"), time), peak,
    el("fieldset", { class: "picks" }, el("legend", {}, "Files it can use"), ...boxes.map((b) => el("label", { for: b.box.id, class: "pick" }, b.box, " " + b.c.label)),
      el("label", { for: "sch-new", class: "pick" }, onlyNew, " Only files that are new or changed since the last finished draft")),
    instructions, more,
    el("div", { class: "row" }, go), reviewerRole() ? "" : el("p", { class: "note" }, "Nothing runs until a reviewer approves it."), out);
  return box;
}
/** S3: the review card. Everything the approval covers, in plain words, then "Approve schedule" for exactly this version. */
async function scheduleReview(scheduleId) {
  const back = el("a", { href: "#tasks" }, "← All tasks");
  const [r, l] = await Promise.all([api("teamtask.schedule.read", { scheduleId }), api("teamtask.schedule.list", {})]);
  if (!r.ok) return el("div", {}, back, refusal(r));
  const s = r.result, d = s.definition, labels = Object.fromEntries(((l.ok && l.result.collections) || []).map((c) => [c.root, c.label]));
  const [label, cls] = SCHEDULE_STATES[s.state] || [s.state, ""], status = el("div", { "aria-live": "polite" });
  const row = (k, ...v) => [el("dt", {}, k), el("dd", {}, ...v)];
  const next = (s.next || []).map((x) => el("li", {}, shortTime(x.dueAt) + (x.adjust === "gap" ? " (clock change: the first valid time after)" : x.adjust === "fold" ? " (clock change: the first of the two)" : "")));
  const limits = "Each run: up to " + Math.round(d.limits.wallMs / 6000) / 10 + " minutes and $" + d.budget.perRunUsd.toFixed(2) + ". This schedule: up to $" + d.budget.monthlyUsd.toFixed(2) + " a month (resets monthly), inside the organization's monthly AI budget.";
  const approveBox = s.state !== "proposed" ? "" : reviewerRole() ? (() => { const b = el("button", { type: "button", class: "btn" }, "Approve schedule");
    b.addEventListener("click", busy(b, async () => { const x = await approve("teamtask.schedule.approve", { scheduleId: s.scheduleId, version: s.version }, s.digest);
      if (!x.ok) return status.replaceChildren(refusal(x)); location.hash = "#tasks"; }));
    return el("div", {}, el("p", { class: "note" }, "You approve this exact schedule. Any change later needs a new approval; the agent never changes it."), el("div", { class: "row" }, b)); })()
    : el("p", { class: "note" }, "A reviewer approves the schedule before anything runs.");
  return el("div", { class: "card schedule-review", id: "schedule-review" }, back, el("div", { class: "row" }, el("h2", {}, d.title), el("span", { class: "tag " + cls }, label)),
    el("dl", { class: "review" },
      ...row("When", WEEKDAYS[d.recurrence.weekday] + " at " + clock(d.recurrence.time)),
      ...row("Next runs", el("ul", {}, next)),
      ...row("Who sees the drafts", d.audience === "members" ? "All members" : "Reviewers and admins only"),
      ...row("Files it can use", d.sources.roots.map((x) => labels[x] || x).join(", ") + (d.sources.rule === "new" ? " · only files new or changed since the last finished draft" : " · the current files, every week")),
      ...row("Exact instructions", el("pre", { class: "plan" }, "Title: " + d.template.title + (d.template.notes ? "\n\n" + d.template.notes : "")),
        /\{\{/.test(d.template.title + d.template.notes) ? el("p", { class: "note" }, "Filled in for each run: {{date}} is the run's date, {{since}} the date of the last finished draft, {{until}} 13 days after the run's date.") : ""),
      ...row("What it makes", "One draft task each week for the team to check. Nothing is sent or published, and the agent never marks it done."),
      ...row("Each week", d.mode === "propose_each" ? "A plan is made; a reviewer approves each run." : "The draft runs on its own; each run is approved by this schedule."),
      ...row("Limits", limits),
      ...row("Ends", day(d.endDate) + ". Continuing needs a new approval."),
      ...row("Missed runs", "If a run can't start within a day, it is skipped. Missed weeks are not caught up."),
      // Fable S3 N-1: say in words that the agent setup is pinned (the four pins are in the definition and enforced).
      ...row("Agent setup", "The agent setup is pinned; if it changes, the schedule pauses."),
      ...row("Notices", "People who can see the drafts get \u201cdraft is ready\u201d in Tasks. Admins are told if it pauses.")),
    s.chatWaitNote ? notice(s.chatWaitNote) : "", approveBox, status);
}
/** New task: typed title + notes, the audience (reviewers may keep it to reviewers), and, from a chat, that chat's text files
 *  to choose. Owner (Oct 23): fewer steps. Text only: what is shared is on the form itself (title, notes, who sees it), so
 *  one click creates the task (the runtime's disclosure digest is still fetched and bound) and plans it; a reviewer's
 *  "Create and run" also approves that exact plan (session-fresh, plan digest). With files: "Review what will be shared"
 *  first (files are copied into the task). A member's task waits for a reviewer's approval. */
const TASK_LIMITS_LINE = "One run of up to 8 minutes and $1.00, using the organization's files. The result is a draft for the team to check; nothing is sent or published.";
function newTaskForm() {
  const a = taskState.adopt; taskState.adopt = null;
  const firstLine = a?.text ? a.text.split("\n")[0].slice(0, 200) : "", rest = a?.text ? a.text.split("\n").slice(1).join("\n").trim() : "";
  const title = el("input", { type: "text", id: "task-title", maxlength: "200" }); title.value = firstLine;
  const notes = el("textarea", { id: "task-notes", maxlength: "4000" }); notes.value = rest;
  const audience = reviewerRole() ? el("select", { id: "task-audience" }, el("option", { value: "members" }, "All members"), el("option", { value: "reviewers-private" }, "Reviewers and admins only")) : null;
  const picks = (a?.uploads || []).map((u) => ({ u, box: el("input", { type: "checkbox", id: "task-up-" + u.uploadId }) }));
  const out = el("div"), runs = reviewerRole();
  const crid = "req-" + crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  const body = () => ({ clientRequestId: crid, title: title.value, notes: notes.value, ...(audience ? { audience: audience.value } : {}),
    ...(picks.some((p) => p.box.checked) ? { uploads: picks.filter((p) => p.box.checked).map((p) => p.u.uploadId) } : {}) });
  // create (bound to the disclosure) -> plan -> (reviewer) approve that exact plan; any refusal lands on the task's page.
  const createAndPlan = async (disclosureDigest) => {
    const r = await api("teamtask.create", { ...body(), disclosureDigest });
    if (!r.ok) return out.replaceChildren(refusal(r));
    const taskId = r.result.taskId, open = () => { location.hash = "#tasks?id=" + taskId; };
    const t = await api("teamtask.read", { taskId }); if (!t.ok) return open();
    const p = await api("teamtask.propose", { taskId, expectedRevision: t.result.revision });
    if (!p.ok) { taskState.notice = { taskId, error: p.error }; return open(); } // Fable N-1: a refused plan is said on the task page
    if (!runs) return open();
    const x = await approve("teamtask.approve", { attemptId: p.result.attemptId }, p.result.planDigest);
    if (!x.ok) taskState.notice = { taskId, error: x.error };
    open();
  };
  const go = el("button", { type: "button", class: "btn" }, runs ? "Create and run" : "Create task");
  go.addEventListener("click", busy(go, async () => {
    const d = await api("teamtask.disclose", body());
    if (!d.ok) return out.replaceChildren(refusal(d));
    if (!d.result.disclosure.uploads.length) return createAndPlan(d.result.disclosureDigest); // text only: the form showed it all
    const x = d.result.disclosure, create = el("button", { type: "button", class: "btn" }, runs ? "Create and run" : "Create task"), back = el("button", { type: "button", class: "btn secondary" }, "Change");
    create.addEventListener("click", busy(create, () => createAndPlan(d.result.disclosureDigest)));
    back.addEventListener("click", () => out.replaceChildren());
    out.replaceChildren(el("div", { class: "task-disclosure", role: "region", "aria-label": "What will be shared" },
      el("strong", {}, "This will be copied into the task and visible to " + x.visibleTo + ":"),
      el("ul", { class: "fields" }, el("li", {}, el("span", { class: "field" }, "Title: "), x.title.text), x.notes.bytes ? el("li", {}, el("span", { class: "field" }, "Notes: "), kb(x.notes.bytes)) : null,
        ...x.uploads.map((u) => el("li", {}, el("span", { class: "field" }, "File: "), u.name + " · " + kb(u.bytes)))),
      el("p", { class: "note" }, "Nothing else from your chat is shared. The task keeps its own copy; changing the original later does not change the task."),
      el("div", { class: "row" }, create, back)));
  }));
  const who = audience ? el("div", { class: "row task-who" }, el("label", { for: "task-audience" }, "Who can see it"), audience) : el("p", { class: "note" }, "All members can see this task.");
  const box = el("details", { class: "card new-task", id: "new-task" }, el("summary", {}, el("h2", {}, "New task")),
    a ? el("p", { class: "note" }, "From your chat: only what you typed is filled in below." + (picks.length ? " Choose any text files from that chat to include." : "")) : "",
    el("label", { for: "task-title" }, "What should be done?"), title, el("label", { for: "task-notes" }, "Notes (optional)"), notes, who,
    picks.length ? el("fieldset", { class: "picks" }, el("legend", {}, "Text files from that chat"), ...picks.map((p) => el("label", { for: p.box.id, class: "pick" }, p.box, " " + p.u.name + " · " + kb(p.u.bytes)))) : "",
    el("p", { class: "note" }, TASK_LIMITS_LINE + (runs ? "" : " A reviewer approves the run.")), el("div", { class: "row" }, go), out);
  box.open = !!a;
  return box;
}
async function taskDetail(taskId) {
  const box = el("div", { id: "task-detail" });
  const draw = async () => {
    const r = await api("teamtask.read", { taskId });
    if (!r.ok) return box.replaceChildren(el("a", { href: "#tasks" }, "← All tasks"), refusal(r));
    const t = r.result, l = await api("teamtask.list", {}), fact = l.ok ? l.result.scheduler : null;
    const status = el("div"), mine = t.creatorId === me.memberId, openTask = t.state === "open", last = t.attempts.at(-1);
    const act = (label, cls, fn) => { const b = el("button", { type: "button", class: cls }, label); b.addEventListener("click", busy(b, async () => { const x = await fn(); if (x && !x.ok) return status.replaceChildren(refusal(x)); await draw(); })); return b; };
    const head = el("div", { class: "card" }, el("a", { href: "#tasks" }, "← All tasks"), el("h2", {}, t.title),
      el("div", { class: "row" }, t.state === "done" ? el("span", { class: "tag ok" }, "Done") : t.state === "cancelled" ? el("span", { class: "tag" }, "Cancelled") : last ? taskTag(last.state) : el("span", { class: "tag" }, "No plan yet"),
        el("span", { class: "note" }, "Visible to " + (t.audience === "members" ? "all members" : "reviewers and admins"))),
      t.notes ? el("p", { class: "task-notes" }, t.notes) : null,
      t.inputs?.length ? el("p", { class: "note" }, "Files copied into this task: " + t.inputs.map((f) => f.name + " (" + kb(f.bytes) + ")").join(", ")) : null);
    const blocked = t.attempts.some((x) => ["approved", "running", "needs_reconciliation"].includes(x.state));
    const actions = el("div", { class: "row" });
    if (openTask && !blocked && !last) actions.append(act("Plan the work", "btn", () => api("teamtask.propose", { taskId, expectedRevision: t.revision })));
    // T3 "Revise or run again": a NEW plan (new approval); optionally the team's note and the last checked result as context.
    const lastReport = t.attempts.slice().reverse().find((x) => x.report)?.report || null;
    const revise = openTask && !blocked && last && last.state !== "proposed" ? reviseForm(t, lastReport, act) : "";
    if (openTask && (reviewerRole() || (mine && !t.attempts.some((x) => x.state === "running")))) actions.append(act("Cancel task", "link-btn", () => approve("teamtask.cancel", { taskId, expectedRevision: t.revision })));
    // Director (Oct 23): the newest checked result is shown inline (older ones stay behind "Open the result").
    const newest = t.attempts.slice().reverse().find((x) => x.report);
    const inline = newest ? await api("teamtask.read", { taskId, resultId: newest.report.resultId }) : null;
    const attempts = t.attempts.slice().reverse().filter((x) => x.state !== "superseded").map((a) => attemptCard(t, a, act, a === newest ? inline : null));
    const outcomes = (t.outcomes || []).length ? el("div", { class: "card" }, el("h3", {}, "Website changes from this task"), el("ul", { class: "list" }, t.outcomes.map((o) =>
      el("li", { class: "item" }, el("div", {}, o.title || "Website request", el("div", { class: "meta" },
        o.pr?.verified ? "Draft pull request #" + o.pr.number + " opened and checked" : o.pr ? "Opening the pull request…" : o.state === "ready" ? "Ready to approve on the Website page" : o.state === "failed" ? "Not prepared: " + say(o.label) : "Preparing the change…")),
        o.pr?.url ? el("a", { href: o.pr.url, target: "_blank", rel: "noopener noreferrer" }, "Open the pull request") : el("a", { href: "#website" }, "Website page"))))) : "";
    const n = taskState.notice; if (n && n.taskId === taskId) { taskState.notice = null; status.replaceChildren(refusal({ ok: false, error: n.error })); }
    box.replaceChildren(head, schedulerNote(fact) || "", ...attempts, revise, outcomes, actions, status);
    if (t.attempts.some((x) => ["approved", "running"].includes(x.state))) setTimeout(() => { if ((location.hash || "").startsWith("#tasks?id=" + taskId) && document.body.contains(box)) draw(); }, 3000);
  };
  await draw();
  return box;
}
/** Fable T2a N-1: a task run's stop reasons in plain words (the shared loop's chat_* labels are worded for chat replies). */
// Owner live run (Oct 23): reading limits in plain words, with what to do next; a task page never shows a raw label.
const TASK_MORE_READING = "This task needed more reading than its limit allows. Try a narrower task, or ask for a revision.";
const TASK_STOPS = { chat_cap_requests: TASK_MORE_READING, chat_cap_tools: TASK_MORE_READING, chat_tool_calls_too_many: TASK_MORE_READING,
  chat_cap_wall: "The run took longer than its plan allows.", chat_cap_usd: "The run reached its cost limit.", chat_cap_context: TASK_MORE_READING,
  chat_org_cap: "This organization's monthly model budget is used up.", chat_tool_refused: "The run kept asking for something it can't do.",
  chat_profile_not_qualified: "Running tasks isn't switched on for this organization yet.", chat_output_truncated: "The result was cut off before it finished.",
  hosted_transport_failed: "The model service couldn't be reached.", hosted_key_missing: "The model service isn't set up for this organization.",
  teamtask_scope_not_permitted: "The run stopped: the approver is no longer a reviewer.", teamtask_closed: "The run stopped: the task was closed.",
  teamtask_plan_changed: "The run stopped: the task changed after the plan was approved.", teamtask_plan_expired: "The run stopped: the plan expired.",
  teamtask_paused: "The run stopped: team tasks were paused by an admin.", teamtask_cancelled: "The run was stopped.",
  teamtask_schedule_paused: "The run stopped: its schedule was paused.", teamtask_schedule_pin_changed: "The run stopped: the agent's setup changed since the schedule was approved.",
  teamtask_schedule_expired: "The run stopped: its schedule ended.",
  // Fable F-1 on 0091459e: the inline path's tools-off refusals, in plain words (never a raw label on a task card).
  chat_finish_inconsistent: "The agent tried to read files it already had and was stopped. Run it again.",
  teamtask_source_inline: "The agent tried to read files it already had; nothing was read.",
  teamtask_result_preamble: "The agent only said what it was going to do and wrote no result. Run it again.",
  teamtask_result_uncited: "The run's answer didn't cite any of the task's files, so it wasn't kept as a result. Run it again.",
  // AGENT-HANDBOOK-V1 H1 (Fable B-4).
  teamtask_handbook_missing: "The agent's handbook isn't approved yet, so tasks can't be planned. Ask a reviewer.",
  teamtask_handbook_changed: "The agent's handbook changed after this plan was made. Plan the work again.",
  teamtask_system_map_unavailable: "The agent couldn't describe this app's setup for this task. Ask an admin." };
const taskSay = (label) => TASK_STOPS[label] || (/^hosted_http_/.test(label || "") ? "The model service refused the request."
  : words[label] || "The run stopped before it finished. Try again, try a narrower task, or ask for a revision.");
function reviseForm(t, lastReport, act) {
  const note = el("textarea", { id: "revise-note", maxlength: "1000", placeholder: "What should change? e.g. shorter, add the volunteer contact, fix the date" });
  const use = lastReport ? el("input", { type: "checkbox", id: "revise-prior", checked: true }) : null;
  const go = act("Plan the revision", "btn", () => api("teamtask.propose", { taskId: t.taskId, expectedRevision: t.revision,
    revision: { note: note.value, ...(use && use.checked ? { priorResultId: lastReport.resultId } : {}) } }));
  // Owner (Oct 23): fewer things to press: revising is one collapsed line until needed.
  return el("details", { class: "card revise" }, el("summary", {}, "Revise or run again"), el("p", { class: "note" }, "This makes a new plan; a reviewer approves the new run. Earlier plans and results are kept."),
    el("label", { for: "revise-note" }, "Revision request (optional)"), note,
    use ? el("label", { for: "revise-prior", class: "pick" }, use, " Give the agent the last checked result to improve on (up to 1,500 characters)") : "", el("div", { class: "row" }, go));
}
/** Fable A-2: the fixed request a task result is drafted with (the member edits later turns as usual). */
const NEWSLETTER_FROM_TASK = "Turn the attached team-task result into this month's newsletter draft. Keep its facts and citations.";
const TASK_RESULT_TOO_LONG = "This result is too long to carry into a chat (over 48 KB). Open a new chat and attach the parts you need instead.";
function attemptCard(t, a, act, inline) {
  const p = a.plan, card = el("div", { class: "card attempt" });
  // Long output (Fable ab150875 Q2): a result kept after the length limit or another limit is marked next to "Result ready".
  card.append(el("div", { class: "row" }, el("strong", {}, "Plan " + a.version), taskTag(a.state),
      a.partial ? el("span", { class: "tag warn", title: taskSay(a.partial) }, "Cut off at the length limit") : ""),
    el("p", {}, p.summary), el("details", {}, el("summary", {}, "Exact instructions"), el("pre", { class: "plan" }, p.instructions)),
    // Owner (Oct 23): no engine internals for members; the limits in one plain line (the exact plan stays under "Exact instructions").
    // Owner brief ("a little complicated"): once a run has a checked result, the limits and the check are ONE quiet line (below).
    a.report ? "" : el("p", { class: "note plan-limits" }, "Uses " + p.sources.files + " file" + (p.sources.files === 1 ? "" : "s") + " (" + kb(p.sources.bytes) + ") · up to " + Math.round(p.budget.wallMs / 60000 * 10) / 10 + " min and $" + p.budget.usd.toFixed(2) + " · a draft for the team; nothing is sent or published"),
    p.revision ? el("p", { class: "note" }, "Revision" + (p.revision.note ? ": " + p.revision.note : " (run again)") + (p.revision.prior ? " · uses the earlier result as context" + (p.revision.prior.truncated ? " (first 1,500 characters)" : "") : "")) : "",
    a.state === "proposed" ? el("p", { class: "note" }, "Approve before " + shortTime(p.expiresAt) + ". A changed task or a newer plan needs a new approval.") : "", // native append prints null
    // S2 (design §1): a run approved by a standing schedule says so, with the exact plan it approved.
    a.approval?.kind === "schedule" ? el("p", { class: "note schedule-approved" }, "Approved by schedule · this exact plan (" + String(a.planDigest || "").replace(/^sha256:/, "").slice(0, 8) + ")") : "");
  if (a.state === "proposed" && t.state === "open") card.append(reviewerRole() ? act("Approve and run", "btn", () => approve("teamtask.approve", { attemptId: a.attemptId }, a.planDigest))
    : el("p", { class: "note" }, "A reviewer approves the run."));
  if (a.state === "running") card.append(el("span", { class: "building", role: "status" }, el("progress", { "aria-label": "Running" }), " Running… a long result can take several minutes"));
  if (a.state === "needs_reconciliation") card.append(notice(a.label === "teamtask_result_unverified" ? "The saved result didn't check out" + (a.unverified?.mismatched?.length ? " (" + a.unverified.mismatched.join(", ") + ")" : "") + ". An admin will check it; nothing is retried." : "We couldn't confirm how this run ended. An admin will check it; nothing is retried.", true));
  if (a.state === "failed" || a.state === "cancelled") card.append(el("p", { class: "note" }, taskSay(a.label)));
  if (a.report) {
    const res = el("div", { class: "result" }), show = el("button", { type: "button", class: "btn secondary" }, "Open the result");
    show.addEventListener("click", busy(show, async () => { const r = await api("teamtask.read", { taskId: t.taskId, resultId: a.report.resultId });
      res.replaceChildren(r.ok ? resultView(r.result.text, t.taskId) : refusal(r)); }));
    if (inline) res.append(inline.ok ? resultView(inline.result.text, t.taskId) : refusal(inline));
    card.append(el("p", { class: "note plan-limits result-line" }, "Used " + p.sources.files + " file" + (p.sources.files === 1 ? "" : "s") + " · a draft: check the facts before using it"),
      inline ? "" : el("div", { class: "row" }, show), res);
    if (t.state === "done" && t.done?.resultDigest === a.report.resultDigest) card.append(el("p", { class: "note" }, "Done " + shortTime(t.done.at) + ". This result is kept in ", el("a", { href: "#files?task=" + t.taskId }, "Files → Task results"), "."));
    if (t.state === "open" && a.state === "result_ready" && (t.creatorId === me.memberId || reviewerRole()))
      card.append(act("Mark done", "btn", () => approve("teamtask.complete", { taskId: t.taskId, expectedRevision: t.revision }, a.report.resultDigest)));
    // Director (25 Oct, the owner's first scheduled run): a task result is text; the newsletter preview, "Send me a test" and edits
    // live in chat. One click carries the result into a NEW chat as an attached text file (visible only in that chat) and opens the
    // newsletter draft plan there, which the member approves as usual; the agent then drafts from the attachment. Existing routes only.
    if (me.chat && reviewerRole()) { const nl = el("button", { type: "button", class: "btn secondary" }, "Turn into a newsletter draft");
      nl.addEventListener("click", busy(nl, async () => { const r = await api("teamtask.read", { taskId: t.taskId, resultId: a.report.resultId });
        if (!r.ok) return res.replaceChildren(refusal(r));
        const text = "From the team task “" + t.title + "”:\n\n" + r.result.text;
        // Fable A-3: the 48 KB upload cap stops here in plain words, before any chat is created.
        if (new TextEncoder().encode(text).length > 48 * 1024) return res.replaceChildren(notice(TASK_RESULT_TOO_LONG, true));
        const c = await api("chat.conversation.create", {}); if (!c.ok) return res.replaceChildren(refusal(c));
        const fileName = "task-result-" + new Date().toISOString().slice(0, 10) + ".md";
        const u = await api("chat.upload", { conversationId: c.result.conversationId, fileName, text }); if (!u.ok) return res.replaceChildren(refusal(u));
        chatState.conversationId = c.result.conversationId;
        chatState.pending = { plan: "newsletter", fromTask: true, heading: "Turn the task result into a newsletter draft",
          typed: NEWSLETTER_FROM_TASK }; // Fable A-1: only the plan card shows; the turn starts after the member's approval
        location.hash = "#chat"; }));
      card.append(el("div", { class: "row" }, nl)); }
    // T3: hand a checked result to the Website page's request form (that request has its own exact approval card).
    if (me.website && reviewerRole()) { const w = el("button", { type: "button", class: "btn secondary" }, "Use for a website request");
      w.addEventListener("click", busy(w, async () => { const r = await api("teamtask.read", { taskId: t.taskId, resultId: a.report.resultId });
        if (!r.ok) return res.replaceChildren(refusal(r));
        // Fable T3 N-2: cut by UTF-8 bytes (the request's cap is 2,048 bytes), never mid-character.
        let w8 = "From the team task “" + t.title + "”:\n" + r.result.text; const enc = new TextEncoder();
        while (enc.encode(w8).length > 2000) w8 = Array.from(w8).slice(0, -Math.max(1, Math.ceil((enc.encode(w8).length - 2000) / 4))).join("");
        websiteState.text = w8;
        websiteState.fromTask = { taskId: t.taskId, resultId: a.report.resultId, title: t.title }; location.hash = "#website"; }));
      card.append(w); }
  }
  return card;
}
/** USABILITY v1: one draft version: "Open preview" (the sandboxed frame), and for reviewers "Send me a test" once test emails
 *  are set up (prepares the release and sends the test in one step; the release card follows), else "Prepare release". */
function artifactCard(a, conversationId, latest) {
  const prev = el("div"), release = el("div"), isNl = a.kind === "newsletter" && a.html_sha256;
  const open = el("button", { type: "button", class: latest ? "btn" : "secondary" }, "Open preview");
  open.addEventListener("click", busy(open, async () => {
    if (prev.firstChild) { prev.replaceChildren(); open.textContent = "Open preview"; return; }
    const h = await api("chat.artifact.preview", { conversationId, artifactId: a.artifact_id, version: a.version });
    if (!h.ok) return prev.replaceChildren(refusal(h));
    // R-4 + Package E (Fable E-11): the stored HTML is loaded from its own URL, whose response carries its own CSP (inline styles,
    // CP's image hosts, sandbox). The frame stays fully sandboxed (no scripts, no forms, no navigation).
    const q = new URLSearchParams({ conversationId, artifactId: a.artifact_id, version: String(a.version) });
    prev.replaceChildren(el("iframe", { sandbox: "", referrerpolicy: "no-referrer", title: "Draft preview", src: `/o/${org}/preview?${q}`, class: "preview" }),
      // P2 K1: an older draft is shown with today's template; to send it, the agent renders it again.
      h.result?.rerendered ? el("p", { class: "note preview-rerendered" }, "Shown with today's newsletter design. This version was made with an older one; to send it, ask the agent to render it again.") : "",
      el("p", { class: "note" }, "Links work in the test email, not in this preview."));
    open.textContent = "Close preview"; }));
  // Newsletter slice 2 (S2-c): reviewers and admins turn a previewed version into a release and test it from here.
  const canRelease = me.newsletter && isNl && reviewerRole();
  // LIBRARY L2 (Fable Addendum 3, P-1): a version that uses shared-drive images is prepared through the publish approval. The
  // card lists each image and the exact public URL it gets; preparing publishes them (a fresh sign-in is asked for).
  const drv = a.publish || null;
  const prepare = async () => {
    if (drv) return publishCard(release, { conversationId, artifactId: a.artifact_id, version: a.version }, drv);
    const r = await api("newsletter.release.prepare", { conversationId, artifactId: a.artifact_id, version: a.version });
    if (!r.ok) { release.replaceChildren(refusal(r)); return null; } return r.result.releaseId; };
  let act = null;
  if (canRelease && me.newsletterTest) {
    act = el("button", { type: "button", class: "secondary" }, "Send me a test");
    act.addEventListener("click", busy(act, async () => { const id = await prepare(); if (!id) return;
      const t = await api("newsletter.test", { releaseId: id }); await releaseCard(release, id);
      release.prepend(t.ok ? notice("Test sent to " + me.email + ". Check your inbox.") : refusal(t)); }));
  } else if (canRelease) {
    act = el("button", { type: "button", class: "secondary" }, "Prepare release");
    act.addEventListener("click", busy(act, async () => { const id = await prepare(); if (id) await releaseCard(release, id); }));
  }
  // PACKAGE P (Fable PP-3/PP-4): what an edit touched, and any link the agent left out at the member's request (never silent).
  const edited = a.editedFrom ? el("p", { class: "meta draft-edited" }, "Edited: " + (a.changed || []).join(", ") + " (from version " + a.editedFrom.version + ")") : null;
  const leftOut = (a.leftOut || []).map((l) => el("p", { class: "notice link-gap" }, "Left out: ", el("span", { class: "mono" }, l.url), ": " + l.reason));
  return el("div", { class: "card artifact" }, el("div", { class: "row" }, el("strong", {}, (a.kind === "newsletter" ? "Newsletter" : "Agenda") + " draft · version " + a.version),
    el("span", { class: "note" }, shortTime(a.created_at)), isNl ? open : null, act), edited, ...leftOut, prev, release);
}
/** LIBRARY L2 (Fable P-1): "Preparing publishes these N images at files.example.org (anyone with the link can view
 *  them)". Resolves to the release id once the reviewer approved (or null: cancelled or refused, the reason shown). */
function publishCard(box, body, p) {
  const n = p.images.length, fmtBytes = (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB";
  const photos = n === 1 ? "1 photo" : n + " photos";
  return new Promise((resolve) => {
    // Director: plain words by default; the exact change (each URL and full hash, Fable P-1) stays on the card under Details.
    const ok = el("button", { type: "button", class: "btn" }, "Put " + photos + " online and continue");
    const no = el("button", { type: "button", class: "btn secondary" }, "Cancel"), status = el("div", { role: "status" });
    ok.addEventListener("click", busy(ok, async () => { const r = await approve("newsletter.release.publish", body, p.digest);
      if (!r.ok) return status.replaceChildren(refusal(r));
      box.replaceChildren(); resolve(r.result.releaseId); }));
    no.addEventListener("click", () => { box.replaceChildren(); resolve(null); });
    const details = el("details", { class: "publish-details" }, el("summary", {}, "Details"),
      el("p", { class: "note" }, (n === 1 ? "Preparing publishes this image" : "Preparing publishes these " + n + " images") + " at files.example.org (anyone with the link can view them)."),
      el("ul", { class: "list" }, p.images.filter((im) => !im.missing).map((im) => el("li", { class: "item" }, el("div", {}, el("strong", {}, im.name),
        el("div", { class: "meta" }, im.width + "×" + im.height + " · " + fmtBytes(im.bytes) + " (" + im.bytes.toLocaleString("en-US") + " bytes)" + (im.published ? " · already online" : "")),
        el("div", { class: "mono" }, im.url), el("div", { class: "meta mono" }, "SHA-256 " + im.sha256))))));
    box.replaceChildren(el("div", { class: "card plan publish" }, el("h3", {}, n === 1 ? "This newsletter uses a photo from the shared drive" : "This newsletter uses " + n + " photos from the shared drive"),
      el("div", { class: "publish-photos" }, p.images.map((im) => im.missing ? el("p", {}, "A photo that is no longer in the shared drive. Remove it from the draft first.")
        : el("figure", { class: "chat-image" }, el("img", { src: `/o/${org}/drive/image/${im.sha256}`, alt: im.name, width: "160", loading: "lazy" }),
          el("figcaption", { class: "note" }, el("strong", {}, im.name))))),
      el("p", {}, (n === 1 ? "This photo goes" : "These photos go") + " online so the email can show " + (n === 1 ? "it" : "them") + ". Anyone with the link can see " + (n === 1 ? "it" : "them") + "."),
      // Fable Addendum 4: the 14-day rule stays outside Details; Details is in the card from the start (never fetched on expand).
      el("p", { class: "note" }, "You'll confirm with a recent sign-in. If the newsletter isn't sent within 14 days, its photos go offline again; a sent newsletter keeps them online."),
      details, el("div", { class: "row" }, ok, no), status));
    if (p.images.some((im) => im.missing)) ok.disabled = true;
  });
}
// `typed`: the member's own words that opened this card (quick-start (a)): approving drafts from them; `asQuestion` sends them
// as a plain question instead (nothing saved).
async function planCard(pane, conversationId, capability, status, typed, asQuestion, heading) {
  const c = await api("chat.draft.card", { conversationId, capability });
  if (!c.ok) return status.replaceChildren(refusal(c));
  const card = c.result.card, ok = el("button", { type: "button", class: "btn" }, "Approve plan to start drafting");
  ok.addEventListener("click", busy(ok, async () => { const r = await approve("chat.draft.approve", { card }, c.result.cardHash);
    if (!r.ok) return status.replaceChildren(refusal(r));
    // Fable F-1: the typed words are being sent now; the box (and its kept draft) must not offer them again.
    if (typed) { chatState.drafts[conversationId] = ""; const box = document.getElementById("chat-text"); if (box) box.value = ""; }
    await runTurn(pane, conversationId, typed || (capability === "newsletter" ? "Please draft the newsletter from the latest approved notes." : "Please prepare the agenda for the next meeting."), null); }));
  const plain = asQuestion ? el("button", { type: "button", class: "btn secondary" }, "Just ask it as a question") : null;
  if (plain) plain.addEventListener("click", busy(plain, async () => { status.replaceChildren(); await asQuestion(); }));
  status.replaceChildren(el("div", { class: "card plan" }, el("h3", {}, heading || (typed ? "To save a draft, approve this plan first" : "Draft plan")), el("dl", {}, el("dt", {}, "Draft"), el("dd", {}, capability === "newsletter" ? "A newsletter" : "A meeting agenda"),
    el("dt", {}, "Reads"), el("dd", {}, c.result.files + " files (snapshot " + card.snapshotHash.slice(7, 15) + "…)"),
    el("dt", {}, "Limit"), el("dd", {}, "Up to " + card.caps.turns + " turns and $" + card.caps.usd.toFixed(2) + "; expires " + shortTime(card.expiresAt))),
    el("p", { class: "note" }, "Approving lets the agent save draft versions in this chat, with a preview. Nothing is sent or published."), el("div", { class: "row" }, ok, plain)));
  status.scrollIntoView?.({ block: "nearest" });
}
// S2-c (Fable R-8): the release card, the ONLY path to newsletter.send. Facts come from runtime rows; the 6-digit code is read
// once from the field, sent with the approval and cleared (never stored). A preview test says plainly it cannot unlock a release.
async function releaseCard(box, releaseId) {
  const v = await api("newsletter.release.view", { releaseId });
  if (!v.ok) return box.replaceChildren(refusal(v));
  const c = v.result, status = el("div");
  const test = c.test ? "Latest test: sent " + shortTime(c.test.sentAt) + " to you" + (c.test.state !== "sent" ? " (not confirmed)" : "")
    + (c.test.path === "preview" ? " · preview only: it can't unlock a release" : "") : "No test yet.";
  const sendTest = el("button", { type: "button", class: "btn secondary" }, "Send me a test");
  sendTest.addEventListener("click", busy(sendTest, async () => { const t = await api("newsletter.test", { releaseId }); if (!t.ok) return status.replaceChildren(refusal(t)); await releaseCard(box, releaseId); }));
  const attest = el("input", { type: "checkbox", id: "nl-attest-" + releaseId });
  const code = el("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", "aria-label": "Authenticator code" });
  const go = el("button", { type: "button", class: "btn" }, "Approve and send");
  go.addEventListener("click", busy(go, async () => {
    const value = code.value.trim(); code.value = "";
    if (!attest.checked) return status.replaceChildren(notice(say("newsletter_attestation_required"), true));
    const operationId = crypto.randomUUID(), body = { releaseId, testId: c.test ? c.test.testId : null, attested: true };
    const ch = await post("challenge", { action: "newsletter.send", body, artifactDigest: c.digest, operationId });
    if (!ch.ok) return status.replaceChildren(refusal(ch));
    const r = await post("act", { challengeId: ch.challengeId, action: "newsletter.send", body, artifactDigest: c.digest, operationId, totp: { code: value } });
    status.replaceChildren(r.ok ? notice("Approved. The release is recorded; sending runs once the newsletter account is connected.") : refusal(r));
  }));
  box.replaceChildren(el("div", { class: "card release" }, el("h3", {}, "Release"),
    el("dl", {}, el("dt", {}, "From"), el("dd", {}, c.from), el("dt", {}, "Subject"), el("dd", {}, c.subject), el("dt", {}, "Name"), el("dd", {}, c.slug),
      el("dt", {}, "Recipients"), el("dd", {}, c.recipientsKnown ? "Up to " + c.recipientCount + " subscribers (people who unsubscribe before sending are left out)" : "Subscriber list not connected yet"),
      // F6S-2: the F-6 suppression read (CP reads the list itself on prepare and before approval; the Mac sync is the fallback).
      el("dt", {}, "Unsubscribes"), el("dd", { class: "release-f6" }, c.suppressionSync ? "Synced " + shortTime(c.suppressionSync.at) + (c.suppressionSync.source === "server" ? " (on CP)" : " (from the Mac)") : "Not synced yet"),
      el("dt", {}, "Content"), el("dd", { class: "mono" }, c.contentShort),
      // Package E (Fable E-12d): every link, as approved: live ones with their site and where the address came from; the rest say why.
      el("dt", {}, "Links"), el("dd", {}, c.links && c.links.length ? el("ul", { class: "release-links" }, ...c.links.map((l) => el("li", {},
        l.live ? l.text + " → " + l.host + " (from " + (l.source === "member message" ? "your message" : l.source === "fixed address" ? "the newsletter's own address" : l.source) + ")"
          : l.text + (l.url ? " — " + l.url : "") + ": not linked (" + ({ no_source: "the address isn't in the sources or your messages", display_mismatch: "the text names a different site", not_https: "not a secure https link", malformed_text: "not a valid link" }[l.reason] || "not linked") + ")"))) : "None")),
    el("p", { class: "meta" }, test), c.testConfigured ? el("div", { class: "row" }, sendTest) : el("p", { class: "note" }, say("newsletter_test_not_configured")),
    // S3-b: say which way tests go, and the declared difference from the real send.
    c.testConfigured ? el("p", { class: "note" }, (c.testPath === "release" ? "Tests go out the release way (same sender and account as the real send)." : "Tests are previews: they show the newsletter but can't unlock a release.")
      + " The unsubscribe link appears only in the real send.") : "",
    el("label", { class: "attest", for: "nl-attest-" + releaseId }, attest, " " + c.attestation + " (content " + c.contentShort + ")"),
    el("div", { class: "row" }, code, go), status));
}
async function runTurn(pane, conversationId, text, ui) {
  const clientRequestId = crypto.randomUUID();
  const s = await api("chat.turn.start", { conversationId, clientRequestId, text });
  if (!s.ok) { if (ui) ui.status.replaceChildren(refusal(s)); return; }
  if (ui) { ui.stop.hidden = false; ui.stop.onclick = () => api("chat.turn.stop", { turnId: s.result.turnId }); ui.msgs.append(el("div", { class: "msg user" }, el("div", { class: "who" }, "You"), el("p", {}, text)),
    el("p", { class: "note working" }, "Working…")); }
  const started = Date.now();
  for (;;) {
    const r = await api("chat.turn.read", { turnId: s.result.turnId });
    if (!r.ok || r.result.terminal) {
      const t = r.result?.turn;
      if (t && t.state !== "done") chatState.notice = { conversationId, label: t.stopReason || "chat_turn_failed", error: t.state !== "stopped" };
      break;
    }
    await new Promise((x) => setTimeout(x, Date.now() - started < 30_000 ? 1000 : 2000)); // Fable N-1: 1 s polling, backing off
  }
  const listed = (await api("chat.conversation.list")).result;
  await drawConversation(pane, conversationId, listed?.allowance);
}
// CP cleanup (Oct 18): Website and Newsletter as simple tabs over the website copy (WC-1), and one "Manage" page for the
// reviewer/admin tools, so the top bar is Chat · Files · Website · Newsletter (+ Manage) instead of a console of sections.
async function siteFiles(prefix) {
  const r = await api("files.list"), files = (r.result?.files || []).filter((f) => f.path.startsWith(prefix));
  return { files: files.sort((a, b) => b.name.localeCompare(a.name)), website: r.result?.website || null };
}
// USABILITY v1: readable titles only (no raw file names); the Files page keeps the names.
const fileLink = (f, label) => { const href = "#files?" + new URLSearchParams({ path: f.path, line: "1" }); // Fable N-2: "Open" is a real link
  return el("li", { class: "item" }, el("a", { href }, label), el("a", { href, class: "meta", "aria-hidden": "true", tabindex: "-1" }, "Open")); };
const fileTitle = (name) => { const m = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/.exec(name); return m ? dayLong(m[1]) + " · " + m[2].replace(/-/g, " ") : name.replace(/\.md$/, ""); };
// THREE-JOBS J1 (owner: "those are the three things they can do with chat... that should be true of the UI they are seeing"):
// Home = the three jobs + "Ask anything" + Recent. UI only: every job page reuses the existing records, approvals and routes;
// nothing here starts a run, approves a plan or sends anything (a job card opens its page; the composer opens a private chat).
const JOBS = () => [
  ...(me.website ? [{ key: "website", title: "Website", sub: "Update pages and events." }] : []),
  ...(me.chat || me.website ? [{ key: "newsletter", title: "Newsletter", sub: "Draft the next edition." }] : []),
  { key: "meetings", title: "Meetings", sub: "Prepare agendas and notes." }];
// J2 (owner: "the simple version looks good"): one small line icon per job, drawn as DOM (no icon library, no external file, so the
// CSP is unchanged); decorative (aria-hidden), the card title is the label. Pattern reference: Lucide's 24-px stroke style (ISC).
const JOB_ICONS = {
  website: [["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 9h18" }], ["path", { d: "M7 6.5h.01M10 6.5h.01" }]],
  newsletter: [["rect", { x: "3", y: "5", width: "18", height: "14", rx: "2" }], ["path", { d: "m3 7 9 6 9-6" }]],
  meetings: [["rect", { x: "3", y: "5", width: "18", height: "16", rx: "2" }], ["path", { d: "M3 10h18M8 3v4M16 3v4" }], ["path", { d: "M8 14h3v3H8z" }]] };
function jobIcon(key) {
  const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "28", height: "28", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", class: "job-icon" })) svg.setAttribute(k, v);
  for (const [tag, attrs] of JOB_ICONS[key] || []) { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); svg.append(n); }
  return svg;
}
const homeLink = () => el("a", { href: "#home", class: "crumb" }, "← Home");
async function homeView() {
  const cards = el("div", { class: "jobs" }, JOBS().map((j) => el("a", { href: "#" + j.key, class: "job" }, jobIcon(j.key), el("strong", {}, j.title), el("span", {}, j.sub))));
  const out = [el("h1", { class: "sr-only" }, "Home"), cards];
  if (me.chat) {
    const box = el("textarea", { id: "ask-text", class: "ask-text", rows: "1", placeholder: "Ask anything", "aria-label": "Ask anything" });
    const go = el("button", { type: "button", class: "ask-go", "aria-label": "Send" }, "↑");
    const ask = async () => { const q = box.value.trim(); if (!q) return; await startTask({ ask: q }); };
    go.addEventListener("click", busy(go, ask));
    box.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go.click(); } });
    out.push(el("div", { class: "ask" }, box, go), el("p", { class: "meta" }, el("a", { href: "#chat" }, "Your chats"), " · private to you"));
    const l = (await api("chat.conversation.list")).result?.conversations || [];
    const recent = l.filter((c) => !c.empty).slice(0, 5);
    if (recent.length) out.push(el("h2", { class: "recent-h" }, "Recent"), el("ul", { class: "recent-list" }, recent.map((c) => {
      const a = el("a", { href: "#chat" }, c.title || "Chat");
      a.addEventListener("click", (e) => { e.preventDefault(); chatState.conversationId = c.conversationId; chatState.keep = true; location.hash = "#chat"; });
      return el("li", {}, a, el("span", { class: "meta" }, shortTime(c.lastAt))); })));
  }
  out.push(el("p", {}, el("a", { href: "#work", class: "quiet" }, "All work & files")));
  return out;
}
async function meetingsView() {
  const out = [homeLink(), el("h1", {}, "Meetings"), el("p", { class: "lede" }, "Prepare agendas, and find what was decided.")];
  if (me.chat) {
    const agenda = el("button", { type: "button", class: "btn" }, "Prepare a meeting agenda");
    agenda.addEventListener("click", busy(agenda, () => startTask({ plan: "agenda" })));
    const last = el("button", { type: "button", class: "btn secondary" }, "What happened at the last meeting?");
    last.addEventListener("click", busy(last, () => startTask({ ask: "What happened at the last meeting? Give me the main points, with sources." })));
    out.push(el("div", { class: "card" }, el("p", {}, "The agenda opens a new chat with a short plan to approve; then the agent drafts it from the approved notes."), el("div", { class: "row" }, agenda, last)));
  }
  const { files } = me.website ? await siteFiles("members/website/meeting-notes/") : { files: [] };
  const notes = files.filter((f) => /^members\/website\/meeting-notes\//.test(f.path)).slice(-8).reverse();
  out.push(el("div", { class: "card" }, el("h2", {}, "Meeting notes"), notes.length ? el("ul", { class: "list" }, notes.map((f) => fileLink(f, dayLong(f.name.slice(0, 10)))))
    : el("p", { class: "note" }, "No meeting notes copied from the website yet."),
    el("p", { class: "meta" }, el("a", { href: "#notes" }, "Approved meeting notes in this app"), me.transcription && reviewerRole() ? [" · ", el("a", { href: "#recordings" }, "Recordings")] : "")));
  return out;
}
/** THREE-JOBS J1: everything that is not one of the three jobs, one click from Home (nothing removed, only moved). */
async function workView() {
  const link = (href, name, sub) => el("li", { class: "item" }, el("div", {}, el("a", { href }, name), el("div", { class: "meta" }, sub)));
  return [homeLink(), el("h1", {}, "All work & files"), el("ul", { class: "list" },
    me.chat ? link("#chat", "Your chats", "Private conversations with the agent") : "",
    me.teamTasks ? link("#tasks", "Tasks", "Team tasks and schedules") : "",
    link("#files", "Shared drive", "Files your team and the agent can use"),
    link("#notes", "Approved meeting notes", "Notes your reviewers approved in this app"),
    reviewerRole() ? link("#manage", "Manage", "Review, activity, handbook" + (me.role === "admin" ? ", members" : "")) : "")];
}
async function websiteView() {
  const out = [...(me.chat ? [homeLink()] : []), el("h1", {}, "Website"), el("p", { class: "lede" }, reviewerRole() ? "Propose changes to events and meeting notes, and see what the website says today."
    : "What the public website says: events and meeting notes. Ask about them in Chat. To change the website, ask a reviewer.")];
  if (!me.website) return [...out, notice("The website isn't connected for this organization.")];
  // USABILITY v1: proposals first for reviewers ("Propose a change" + the list with status and preview links).
  if (reviewerRole()) out.push(await websiteSection());
  const { files, website } = await siteFiles("members/website/");
  const events = files.filter((f) => f.path === "members/website/events.md"), notes = files.filter((f) => f.path.startsWith("members/website/meeting-notes/"));
  out.push(el("div", { class: "card" }, el("h2", {}, "On the website now"), (events.length || notes.length) ? el("ul", { class: "list" },
    ...events.map((f) => fileLink(f, "Events")), ...notes.map((f) => fileLink(f, "Website meeting notes · " + dayLong(f.name.slice(0, 10))))) : el("p", { class: "note" }, "Nothing copied from the website yet."),
    website?.commit ? el("p", { class: "meta" }, "Copied from the website " + shortTime(website.fetchedAt)) : ""));
  return out;
}
async function newsletterView() {
  // J2 (owner, Oct 26): the page is ONLY Drafts (every newsletter draft from any of your chats, newest first, with Open preview and,
  // for reviewers, Send me a test) and Sent (past issues). Starting a draft is the one button above the list.
  const out = [...(me.chat ? [homeLink()] : []), el("h1", {}, "Newsletter")];
  if (me.chat) {
    const draft = el("button", { type: "button", class: "btn" }, "Draft the next newsletter");
    draft.addEventListener("click", busy(draft, () => startTask({ plan: "newsletter" })));
    const listed = (await api("chat.conversation.list", { drafts: true })).result || {}, drafts = listed.drafts || [], shared = listed.sharedDrafts || [];
    // J2 option a (Director; chats stay private): the owner shares one draft with reviewers, or stops. Only the draft is shared.
    const shareBtn = (d) => { const b = el("button", { type: "button", class: "link-btn" }, d.shared ? "Stop sharing" : "Share with reviewers");
      b.addEventListener("click", busy(b, async () => { const r = await api("chat.draft.share", { conversationId: d.conversationId, artifactId: d.artifact_id, share: !d.shared }); if (!r.ok) return b.replaceWith(refusal(r)); route(); }));
      return b; };
    const openChat = (d) => { const a = el("a", { href: "#chat" }, "Open the chat"); a.addEventListener("click", (e) => { e.preventDefault(); chatState.conversationId = d.conversationId; chatState.keep = true; location.hash = "#chat"; }); return a; };
    out.push(el("section", { class: "card nl-drafts" }, el("div", { class: "row spread" }, el("h2", {}, "Drafts"), draft),
      drafts.length ? el("div", {}, drafts.map((d) => el("div", { class: "nl-draft" }, el("div", { class: "row" }, el("strong", {}, d.title || "Untitled draft"), el("span", { class: "meta" }, shortTime(d.created_at)), openChat(d),
          d.shared ? el("span", { class: "tag ok" }, "Shared with reviewers") : "", shareBtn(d)),
        d.html_sha256 ? artifactCard({ ...d, kind: "newsletter" }, d.conversationId, true) : el("p", { class: "note" }, "Not previewed yet. Open the chat and ask the agent to render it."))))
        : el("p", { class: "note" }, "No drafts yet. Press Draft the next newsletter: you approve a short plan in the chat, then the agent writes a draft you can preview here."),
      el("p", { class: "note" }, "Your chats stay private. Share a draft to let reviewers preview it and send it; you can stop sharing at any time.")));
    // Reviewers: drafts other members shared (their latest version; never the chat).
    if (shared.length) out.push(el("section", { class: "card nl-drafts nl-shared" }, el("h2", {}, "Shared with reviewers"),
      el("div", {}, shared.map((d) => el("div", { class: "nl-draft" }, el("div", { class: "row" }, el("strong", {}, d.title || "Untitled draft"), el("span", { class: "meta" }, "Shared by " + d.sharedBy + " · " + shortTime(d.created_at))),
        d.html_sha256 ? artifactCard({ ...d, kind: "newsletter" }, d.conversationId, true) : el("p", { class: "note" }, "Not previewed yet."))))));
  }
  const { files } = me.website ? await siteFiles("members/website/newsletters/") : { files: [] };
  out.push(el("section", { class: "card" }, el("h2", {}, "Sent"), files.length ? el("ul", { class: "list" }, ...files.map((f) => fileLink(f, fileTitle(f.name))))
    : el("p", { class: "note" }, "No past newsletters copied yet.")));
  return out;
}
async function manageView() {
  if (!["admin", "reviewer"].includes(me.role)) return [el("h1", {}, "Manage"), notice("Only reviewers and admins manage the organization.", true)];
  const link = (href, name, sub) => el("li", { class: "item" }, el("div", {}, el("a", { href }, name), el("div", { class: "meta" }, sub)));
  // USABILITY v1 (owner): plain labels; "Approved meeting notes" are this app's, not the website's meeting notes.
  const paused = me.website ? websitePaused((await api("website.list")).result?.requests || []) : false;
  return [el("h1", {}, "Manage"), el("p", { class: "lede" }, "Tools for reviewers and admins. New here? See Help."), paused ? notice(PAUSED_BANNER, true) : "", el("ul", { class: "list" },
    link("#review", "Review", "Add meeting notes, approve the agent's plans, and decide what members see"),
    link("#notes", "Approved meeting notes", "Notes your reviewers approved in this app (separate from the website's meeting notes)"),
    me.transcription ? link("#recordings", "Recordings", "Meeting recordings and transcripts") : "",
    link("#activity", "Activity", me.emailIntake ? "Plan approvals, and member emails the agent handled" : "Who approved which plan"),
    me.handbook ? link("#handbook", "Agent handbook", "What the agent is told about how we work; reviewers edit and approve it") : "",
    me.role === "admin" ? link("#members", "Members", "Who belongs to the organization") : "")];
}
// USABILITY v1 (owner, Oct 19: "we need a how-to"): one short page, plain words, a how-to per task. Role-aware where the
// steps differ; the daily turn limit comes from the runtime (the allowance), never a fixed number in the page.
/** AGENT-HANDBOOK-V1 H2: Manage -> Agent handbook. Members read the approved text (Help links here); reviewers edit -> preview (size,
 *  cost, line diff, the schedules that will pause) -> approve EXACTLY the previewed text (session-fresh, its sha256). Chips land here
 *  with ?version=N&line=L (the numbered view opens at that line). */
async function handbookView() {
  const head = [el("h1", {}, "Agent handbook"), el("p", { class: "lede" }, "What the agent is told about how we work. It guides the agent's answers; it can't give it new powers or skip an approval.")];
  if (!me.handbook) return [...head, notice(say("handbook_not_enabled"))];
  const q = new URLSearchParams(location.hash.split("?")[1] || ""), ver = /^\d{1,4}$/.test(q.get("version") || "") ? Number(q.get("version")) : undefined,
    line = /^\d{1,4}$/.test(q.get("line") || "") ? Number(q.get("line")) : 0;
  const r = await api("handbook.read", ver ? { version: ver } : {});
  if (!r.ok) return [...head, refusal(r)];
  const h = r.result.handbook, out = [...head];
  if (!h) out.push(notice(reviewerRole() ? "No handbook is approved yet. Write the first one below." : "No handbook is approved yet."));
  else {
    const inUse = h.version === r.result.activeVersion, lines = h.content.replace(/\n$/, "").split("\n");
    const numbered = el("pre", { class: "file" }, ...lines.map((t, i) => el("span", { class: "ln" + (i + 1 === line ? " hit" : "") }, (i + 1) + "  " + (t || " "))));
    const nums = el("details", { class: "hb-lines" }, el("summary", {}, "Show with line numbers"), numbered); if (line) nums.open = true;
    out.push(el("div", { class: "card handbook", id: "handbook-text" }, el("div", { class: "row" }, el("strong", {}, "Version " + h.version), el("span", { class: "tag " + (inUse ? "ok" : "") }, inUse ? "In use" : "Earlier version"),
      el("span", { class: "note" }, "Approved by a reviewer " + shortTime(h.approvedAt))), el("div", { class: "result-text md" }, ...mdNodes(h.content, { tables: true })), nums));
    if (line) requestAnimationFrame(() => numbered.querySelector(".ln.hit")?.scrollIntoView({ block: "center" }));
  }
  if (r.result.history.length > 1) out.push(el("details", { class: "card hb-history" }, el("summary", {}, "All versions (" + r.result.history.length + ")"),
    el("ul", { class: "list" }, r.result.history.map((x) => el("li", { class: "item" }, el("div", {}, el("a", { href: "#handbook?version=" + x.version }, "Version " + x.version),
      el("div", { class: "meta" }, "Approved " + shortTime(x.approvedAt) + (x.active ? " · in use" : ""))))))));
  if (reviewerRole()) out.push(handbookEditor(h, r.result.activeVersion));
  return out;
}
function handbookEditor(shown, activeVersion) {
  const text = el("textarea", { id: "hb-text", maxlength: "8000" }); text.value = shown ? shown.content : "";
  const out = el("div", { "aria-live": "polite" }), go = el("button", { type: "button", class: "btn secondary" }, "Preview changes");
  go.addEventListener("click", busy(go, async () => {
    const p = await api("handbook.propose", { content: text.value });
    if (!p.ok) return out.replaceChildren(refusal(p));
    // Director render review: the size as a share of the limit and the cost per answer, in plain words (no KiB, no tokens).
    const v = p.result, pct = Math.max(1, Math.round(v.bytes / v.maxBytes * 100)), usd = v.cost?.usdPerRequest;
    const diff = v.diff.filter((d) => d.op !== "same");
    const card = el("div", { class: "card hb-preview", id: "hb-preview" }, el("h3", {}, "Preview"),
      el("p", { class: "note hb-size" + (v.fits ? "" : " error") }, pct + "% of the limit" + (usd === null || usd === undefined ? "" : " · adds " + (usd < 0.001 ? "under $0.001" : "about $" + usd.toFixed(3)) + " per answer")),
      v.unchanged ? notice("No changes from the version in use.") : el("ul", { class: "hb-diff" }, (diff.length ? diff : v.diff).map((d) => el("li", { class: "d-" + d.op }, (d.op === "add" ? "+ " : d.op === "del" ? "\u2212 " : "  ") + (d.line || " ")))),
      v.inFlight?.running ? notice(v.inFlight.running + (v.inFlight.running === 1 ? " task run in progress will stop at its next step." : " task runs in progress will stop at their next step.")) : "",
      v.inFlight?.plans ? notice(v.inFlight.plans + (v.inFlight.plans === 1 ? " planned task will need a new plan." : " planned tasks will need a new plan.")) : "",
      v.schedulesToPause.length ? notice((v.schedulesToPause.length === 1 ? "1 schedule will pause until a reviewer reviews it again: " : v.schedulesToPause.length + " schedules will pause until a reviewer reviews them again: ") + v.schedulesToPause.join(", ") + ".") : "");
    if (v.fits && !v.unchanged) { const ok = el("button", { type: "button", class: "btn" }, "Approve handbook");
      ok.addEventListener("click", busy(ok, async () => { const x = await approve("handbook.approve", { content: text.value, expectedPrev: activeVersion ?? null }, v.sha256);
        if (!x.ok) return out.append(refusal(x)); location.hash = "#handbook"; route(); }));
      card.append(el("p", { class: "note" }, "You approve exactly this text. The agent uses it in every chat and task from now on."), el("div", { class: "row" }, ok)); }
    out.replaceChildren(card);
  }));
  const box = el("details", { class: "card hb-edit", id: "hb-edit" }, el("summary", {}, shown ? "Edit the handbook" : "Write the handbook"),
    el("label", { for: "hb-text" }, "Handbook (up to about 2 pages)"), text,
    el("p", { class: "note" }, "Say who we are, how we decide, where to look and give a few short examples. No member names or private details: every member can read it."),
    el("div", { class: "row" }, go), out);
  if (!shown) box.open = true;
  return box;
}
/** H2: a run's frozen system map, opened from a system-map chip, through the turn's (owner) or the task's (audience) own read. */
async function mapView() {
  const q = new URLSearchParams(location.hash.split("?")[1] || ""), turn = q.get("turn"), task = q.get("task"), id = q.get("id"), line = /^\d{1,4}$/.test(q.get("line") || "") ? Number(q.get("line")) : 0;
  const back = el("a", { href: task ? "#tasks?id=" + task : "#chat" }, task ? "\u2190 Back to the task" : "\u2190 Back to chat");
  const head = [el("h1", {}, "System map"), el("p", { class: "lede" }, "What the app told the agent about itself for this run: generated from that run's files and settings.")];
  const r = turn ? await api("chat.turn.read", { turnId: turn, map: true }) : task && id ? await api("teamtask.read", { taskId: task, mapOf: id }) : { ok: false, error: "handbook_input_invalid" };
  if (!r.ok) return [...head, el("div", { class: "card" }, back, refusal(r))];
  const mp = r.result.map;
  if (!mp) return [...head, el("div", { class: "card" }, back, notice("This run has no system map."))];
  const pre = el("pre", { class: "file" }, ...mp.text.replace(/\n$/, "").split("\n").map((t, i) => el("span", { class: "ln" + (i + 1 === line ? " hit" : "") }, (i + 1) + "  " + (t || " "))));
  if (line) requestAnimationFrame(() => pre.querySelector(".ln.hit")?.scrollIntoView({ block: "center" }));
  return [...head, el("div", { class: "card", id: "map-view" }, back, mp.handbookVersion ? el("p", { class: "note" }, "Used with handbook ", el("a", { href: "#handbook?version=" + mp.handbookVersion }, "version " + mp.handbookVersion), ".") : "", pre)];
}
async function helpView() {
  const allowance = me.chat ? (await api("chat.conversation.list")).result?.allowance : null;
  const section = (title, intro, steps, after) => el("section", { class: "card help" }, el("h2", {}, title), intro ? el("p", {}, intro) : null,
    steps ? el("ol", { class: "steps" }, steps.map((x) => el("li", {}, x))) : null, after || null);
  const go = (label, href) => el("div", { class: "row" }, el("a", { class: "btn secondary", href }, label));
  const reviewer = reviewerRole();
  const out = [el("h1", {}, "How to use " + (me.label || "the agent")), el("p", { class: "lede" }, "Short how-tos for each task. Nothing is sent or published without a person approving it."),
    me.handbook ? el("p", { class: "note" }, "The agent follows the team's ", el("a", { href: "#handbook" }, "agent handbook"), ": how we work, approved by a reviewer.") : ""];
  if (me.chat) out.push(section("Ask a question", "The agent answers from approved meeting notes, the website's events and meeting notes, and past newsletters.", [
      "Open Chat and press New chat (or pick a starter).", "Type your question and press Send.",
      "Small grey chips show the sources. Click one to see the exact lines in Files."],
    el("p", { class: "note" }, "Only you can read your chats.")));
  if (me.teamTasks) out.push(section("Tasks", null, [
      "Tasks are work for the agent that the team can see. In a chat, press + and “Make this a task”: only what you typed is carried over (and any of that chat's text files you choose). The form shows who can see the task; files are shown again before they are copied.",
      "Reviewers press “Create and run”: the task is created, planned from its own words, and that exact plan approved and run, in one click. A member's task is planned at once and waits for a reviewer to approve the run.",
      "One run at a time per organization: while a chat answer or a task is running, the other waits. A run reads only its frozen files and can't send, publish or change anything.",
      "“Result ready” means the saved result is exactly what the run wrote, not that its facts are right. Check it, then mark it done. If a run's outcome can't be confirmed, an admin checks it; nothing is retried.",
      "Not right yet? “Revise or run again” makes a new plan with your note, and can give the agent the last checked result to improve on. A reviewer approves the new run.",
      ...(me.website ? ["Reviewers can press “Use for a website request” on a checked result: the Website page opens with it, and the website change still needs its own approval of the exact change. The task shows the draft pull request once it is checked."] : [])]));
  if (me.chat && me.images) out.push(section("Attach a flyer or image", null, [
      "In a chat, press + and “Attach a flyer/image”, and pick a JPEG, PNG or WebP (up to 4 MB).",
      "The app makes a clean copy: location, camera and other hidden details are removed, and very large images are shrunk.",
      "It shows in your chat. Only you can see it; attaching it does not share or publish it.",
      ...(me.imageExtract ? ["To get its event details, press “Read this flyer”. The note under the button says the flyer goes to the hosted model; then check every field under “From the flyer — check this” (each one saves as you go)."] : []),
      ...(me.imageExtract && me.website && reviewerRole() ? ["Reviewers: press “Add to the website”. The Website page opens with the details and the image; you see the exact change and where the image will be public before approving a draft pull request. Once you prepare it, other reviewers and admins can see the image too."] : [])]));
  if (me.chat) out.push(section("Draft, preview and test a newsletter", null, [
      "In Chat, pick “Draft the next newsletter”.", "Read the short plan (which files it reads, its limits) and approve it.",
      "The agent writes a draft. Press “Open preview” under its reply to see the email.",
      "Want changes? Ask in the same chat; each change is a new version with its own preview.",
      ...(reviewer && me.newsletter ? [me.newsletterTest ? "Press “Send me a test” to get the email in your own inbox." : "Test emails aren't switched on yet."] : [])],
    el("p", { class: "note" }, "Sending to subscribers needs one of the named approvers and a code from their authenticator app. Until then nothing goes out.")));
  if (me.website) out.push(reviewer ? section("Change the website (events, meeting notes)", null, [
      "Open Website and describe the change under “Propose a change” (for example: Add the tree planting on Sat Nov 8, 9 am at Riverside Park).",
      "The agent prepares it. You see the exact change, field by field.", "Approve it. A draft change opens on GitHub; a preview link appears on the card in about a minute.",
      "The website changes only when its maintainer publishes (merges) it."], go("Go to Website", "#website"))
    : section("Change the website", "Ask a reviewer: they propose website changes here, and the website's maintainer publishes them."));
  out.push(section("Who approves what", null, null, el("dl", { class: "who-approves" },
    el("dt", {}, "A draft plan (newsletter, agenda)"), el("dd", {}, "The person who asks for the draft."),
    el("dt", {}, "Sending a newsletter"), el("dd", {}, "A named approver, with a code from their authenticator app."),
    el("dt", {}, "Website changes"), el("dd", {}, "Reviewers and admins approve; the website's maintainer publishes."),
    el("dt", {}, "Meeting notes members can read"), el("dd", {}, "Reviewers, on the Review page."),
    el("dt", {}, "New members, roles"), el("dd", {}, "An admin."))));
  out.push(section("Limits", null, null, el("ul", {},
    allowance ? el("li", {}, allowance.limit + " chat turns per person per day (you have " + allowance.remaining + " left today).") : null,
    el("li", {}, "Messages up to 8,000 characters; attached files .md, .txt, .csv, Word (.docx) or web page (.html), up to 48 KB of text."),
    el("li", {}, "A draft plan has its own small budget, shown on the plan."),
    me.newsletter ? el("li", {}, "Test emails: a few per day, at least five minutes apart.") : null)));
  out.push(section("Two kinds of meeting notes", null, null, el("ul", {},
    el("li", {}, "Website meeting notes: copied from the public website (Website page). Read-only here."),
    el("li", {}, "Approved meeting notes: notes your reviewers approve in this app" + (reviewer ? " (Manage → Approved meeting notes)." : ".")))));
  return out;
}
/** "Plan joint Christmas meeting" -> "plan-joint-christmas-meeting.md" (display only). */
const taskFileName = (title) => (title.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "task-result") + ".md";
/** LIBRARY L1: "Save to shared drive" on one of the member's chat images (named first; nothing becomes public). */
function driveSave(im, status) {
  const box = el("div", { class: "row" }), name = el("input", { type: "text", class: "drive-name", maxlength: "80", "aria-label": "Name in the shared drive", placeholder: "Name in the shared drive" });
  const b = el("button", { type: "button", class: "btn secondary" }, "Save to shared drive");
  b.addEventListener("click", busy(b, async () => {
    const x = await api("image.drive.save", { imageId: im.imageId, name: name.value.trim() });
    status.replaceChildren(x.ok ? notice(say(x.result.deduplicated ? "drive_saved_again" : "drive_saved")) : refusal(x));
  }));
  box.append(name, b);
  return box;
}
/** LIBRARY L1 (Director: "keep it like a simple shared drive"): ONE Upload that takes documents and images; the type picks
 *  the path behind the scenes (images through the sanitizer; .md/.txt/.csv as they are, .docx/.html converted to text). */
function driveAdd(imagesEnabled, status) {
  const row = el("div", { class: "row drive-add" });
  const IMG = ["image/jpeg", "image/png", "image/webp"];
  const pick = el("input", { type: "file", id: "drive-upload", class: "sr-only", accept: TEXT_ACCEPT + (imagesEnabled ? ",image/jpeg,image/png,image/webp" : "") });
  pick.addEventListener("change", async () => { const f = pick.files?.[0]; pick.value = ""; if (!f) return;
    if (IMG.includes(f.type) || /\.(jpe?g|png|webp)$/i.test(f.name)) {
      if (!imagesEnabled) return status.replaceChildren(notice(say("drive_not_available"), true));
      if (!IMG.includes(f.type)) return status.replaceChildren(notice(say("image_type_not_admitted"), true));
      if (f.size > 4 * 1024 * 1024) return status.replaceChildren(notice(say("image_too_large"), true));
      const fileName = f.name.replace(/\.[A-Za-z0-9]+$/, "").replace(/[^A-Za-z0-9 ._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").slice(0, 80) || "image";
      status.replaceChildren(el("p", { class: "note" }, "Uploading and cleaning the image…"));
      const t = await api("image.upload", { drive: true, fileName, size: f.size, contentType: f.type });
      if (!t.ok) return status.replaceChildren(refusal(t));
      const r = await fetch(`/o/${org}/upload/${t.result.uploadId}`, { method: "PUT", headers: { "content-type": f.type }, credentials: "same-origin", body: f })
        .then((x) => x.json()).catch(() => ({ ok: false, error: "image_upload_aborted" }));
      if (!r.ok) return status.replaceChildren(notice(say(r.error), true));
      return route();
    }
    let r; try { r = await readTextFile(f); } catch { return status.replaceChildren(notice(say("chat_upload_unreadable"), true)); }
    if (!r) return status.replaceChildren(notice(say("chat_upload_type_not_admitted"), true));
    if (new TextEncoder().encode(r.text).length > 48 * 1024) return status.replaceChildren(notice(say("chat_upload_too_large"), true));
    const x = await api("files.upload", { fileName: r.name, text: r.text });
    if (!x.ok) return status.replaceChildren(refusal(x));
    route(); });
  row.append(el("label", { for: "drive-upload", class: "btn" }, "Upload"), pick);
  return row;
}
/** LIBRARY L2 (Fable L-4/R-3): an admin unpublishes a public drive image (its link answers "gone"; the file is kept). If a
 *  sent newsletter used it, the confirmation names those sends and the override is explicit. */
function unpublishButton(im, status) {
  const b = el("button", { type: "button", class: "btn secondary" }, "Unpublish");
  b.addEventListener("click", busy(b, async () => {
    const sent = im.sentIn || [];
    const words = sent.length ? "Sent newsletters use this image: " + sent.join(", ") + ". Unpublishing makes it disappear from those emails. Unpublish anyway?"
      : "Unpublish " + im.name + "? Its public link will stop working.";
    if (!confirm(words)) return;
    const x = await approve("files.unpublish", sent.length ? { sha256: im.sha256, override: true } : { sha256: im.sha256 }, null);
    if (!x.ok) return status.replaceChildren(refusal(x));
    route(); }));
  return b;
}
async function filesView() {
  // Director: the agent's generated image list is internal plumbing; it is not shown here (the agent still reads it).
  const r = await api("files.list"), files = (r.result?.files || []).filter((f) => f.folder !== "members/drive");
  const status = el("div", { role: "status" }), reviewer = ["admin", "reviewer"].includes(me.role);
  // Director: the viewer appears only once a file is opened (no empty box beside the list).
  const viewer = el("div", { class: "card viewer", hidden: true }), wrap = el("div", { class: "grid" });
  const showViewer = (...n) => { viewer.hidden = false; wrap.classList.add("two"); viewer.replaceChildren(...n); };
  const folders = [...new Set(files.map((f) => f.folder))], ws = r.result?.website;
  // WC-2: the website copy's state, and a refresh for reviewers.
  const site = ws ? el("div", { class: "card row" }, el("span", {}, ws.commit ? "Website copy: commit " + ws.commit.slice(0, 7) + ", updated " + shortTime(ws.fetchedAt) : "Website copy: not made yet.",
    ws.lastOutcome && !["ok", "unchanged"].includes(ws.lastOutcome) ? el("small", { class: "meta" }, " Last refresh: " + say(ws.lastOutcome)) : "")) : null;
  if (site && ["admin", "reviewer"].includes(me.role)) {
    const b = el("button", { type: "button", class: "btn secondary" }, "Refresh from website");
    b.addEventListener("click", busy(b, async () => { const x = await api("website.content.refresh"); if (!x.ok) return site.append(refusal(x)); route(); }));
    site.append(b);
  }
  // P-1 (Fable R-4): open a file in the viewer, one element per line (text nodes), the cited line marked and centred.
  const open = async (path, line) => {
    const x = await api("files.read", { path });
    if (!x.ok) return showViewer(refusal(x)); // files_unknown / files_too_large: the usual words
    const p = x.result, lines = p.text.replace(/\n$/, "").split("\n"), hit = line ? Math.min(Math.max(1, line), lines.length) : 0;
    const pre = el("pre", { class: "file" }, ...lines.map((t, i) => el("span", { class: "ln" + (i + 1 === hit ? " hit" : "") }, t || " ")));
    showViewer(el("div", { class: "row" }, el("strong", {}, path.split("/").pop()), el("span", { class: "tag" }, "Read-only"), hit ? el("span", { class: "tag" }, "Line " + hit) : ""), pre,
      el("h4", {}, "Provenance"), el("dl", {}, el("dt", {}, "Added by"), el("dd", {}, p.addedBy || "—"), el("dt", {}, "When"), el("dd", {}, shortTime(p.at)),
        el("dt", {}, "From"), el("dd", {}, p.from), el("dt", {}, "Visible to"), el("dd", {}, p.visibleTo), el("dt", {}, "SHA-256"), el("dd", { class: "mono" }, p.sha256.slice(7, 19) + "…")));
    if (hit) requestAnimationFrame(() => pre.querySelector(".ln.hit")?.scrollIntoView({ block: "center" }));
  };
  // J2 (owner, Oct 26): the shared drive first (images, shared files), then my chat uploads and the other folders; the website's raw
  // source files sit behind "Website source files" and the task results at the bottom, both closed.
  const rank = (d) => d === "members/shared" ? 0 : /^members\/uploads\//.test(d) ? 1 : d.startsWith("members/website") ? 3 : 2;
  const folderBlock = (d) => el("div", { class: "folder" }, el("h3", {}, ({ "members/shared": "Shared files", "members/drive": "The agent's list of drive images" })[d] ?? d.replace(/^members\//, "").replace(/^uploads\/[^/]+\/[^/]+$/, "My chat uploads")),
    el("ul", { class: "list" }, files.filter((f) => f.folder === d).map((f) => { const b = el("button", { type: "button", class: "secondary" }, "Open");
      // Opening another file drops a deep link's query, so a reload never reopens the old one.
      b.addEventListener("click", busy(b, async () => { if (location.hash !== "#files") history.replaceState(null, "", "#files"); await open(f.path, 0); }));
      // LIBRARY L1: reviewers and admins remove a shared-drive text file.
      const del = reviewer && /^members\/shared\/[^/]+$/.test(f.path) ? el("button", { type: "button", class: "secondary" }, "Remove") : null;
      if (del) del.addEventListener("click", busy(del, async () => { if (!confirm("Remove " + f.name + " from the shared drive? The agent will no longer read it.")) return;
        const x = await api("files.delete", { path: f.path }); if (!x.ok) return status.replaceChildren(refusal(x)); route(); }));
      return el("li", { class: "item" }, el("div", {}, el("strong", {}, f.name), el("div", { class: "meta" }, (f.addedBy || f.from) + " · " + shortTime(f.at))), del ? el("div", { class: "row" }, b, del) : b); })));
  const ordered = folders.slice().sort((x, y) => rank(x) - rank(y)), siteFolders = ordered.filter((d) => rank(d) === 3);
  const list = el("div", {}, ...ordered.filter((d) => rank(d) < 3).map(folderBlock));
  const siteBox = siteFolders.length || site ? el("details", { class: "folder site-source" }, el("summary", {}, "Website source files"),
    el("p", { class: "note" }, "The website's events and meeting notes as the agent reads them. Change the website on the Website page."), ...(site ? [site] : []), ...siteFolders.map(folderBlock)) : null;
  // LIBRARY L1: the drive's images (thumbnails through the logged-in route; never a public URL here).
  const images = r.result?.images || [];
  if (images.length) list.prepend(el("div", { class: "folder" }, el("h3", {}, "Images"),
    el("p", { class: "note" }, "A newsletter puts the photos it uses online when a reviewer prepares it."),
    el("div", { class: "drive-images" }, images.map((im) => {
      const del = reviewer ? el("button", { type: "button", class: "btn secondary" }, "Remove") : null;
      if (del) del.addEventListener("click", busy(del, async () => { if (!confirm("Remove " + im.name + " from the shared drive?")) return;
        const x = await api("files.delete", { sha256: im.sha256 }); if (!x.ok) return status.replaceChildren(refusal(x)); route(); }));
      return el("figure", { class: "chat-image" }, el("img", { src: `/o/${org}/drive/image/${im.sha256}`, alt: im.name, width: String(Math.min(im.width, 200)), loading: "lazy" }),
        el("figcaption", { class: "note" }, el("strong", {}, im.name), " · " + im.width + "×" + im.height + " · " + (im.addedBy || im.from) + " · " + shortTime(im.at)),
        im.published ? el("span", { class: "tag" }, "Public (in a newsletter)") : null, del, im.published && me.role === "admin" ? unpublishButton(im, status) : null); }))));
  // Owner (Oct 23): each completed task's verified result, as a file under "Task results" (same audience as the task; read from the
  // task store, not written into the org folder, so the agent does not read it as a source).
  const tl = me.teamTasks ? await api("teamtask.list", {}) : null;
  const results = (tl?.result?.tasks || []).filter((t) => t.state === "done" && t.done).map((t) => ({ t, a: t.attempts.find((x) => x.report?.resultDigest === t.done.resultDigest) })).filter((x) => x.a);
  // SCHEDULED-TASKS-V1 S2: a scheduled run's checked draft lands here as soon as it is ready (not partial; same audience as its
  // task; the runtime rechecks the audience on the list and on every read).
  for (const t of tl?.result?.tasks || []) { if (t.state !== "open") continue;
    const a = t.attempts.slice().reverse().find((x) => x.approval?.kind === "schedule" && x.state === "result_ready" && x.report && !x.partial); if (a) results.push({ t, a, scheduled: true }); }
  const openResult = async ({ t, a }) => { // a scheduled draft may not be done yet
    const x = await api("teamtask.read", { taskId: t.taskId, resultId: a.report.resultId });
    if (!x.ok) return showViewer(refusal(x));
    showViewer(el("div", { class: "row" }, el("strong", {}, taskFileName(t.title)), el("span", { class: "tag" }, "Read-only")), resultView(x.result.text, t.taskId),
      el("h4", {}, "Provenance"), el("dl", {}, el("dt", {}, "From"), el("dd", {}, el("a", { href: "#tasks?id=" + t.taskId }, "Team task: " + t.title)), el("dt", {}, t.done ? "Done" : "Status"), el("dd", {}, t.done ? shortTime(t.done.at) : "Scheduled draft, not marked done yet"),
        el("dt", {}, "Visible to"), el("dd", {}, t.audience === "members" ? "all members" : "reviewers and admins"), el("dt", {}, "Checked"), el("dd", {}, "exactly what the run wrote; check the facts yourself"),
        el("dt", {}, "SHA-256"), el("dd", { class: "mono" }, String(a.report.sha256 || "").replace(/^sha256:/, "").slice(0, 12) + "…")));
  };
  if (siteBox) list.append(siteBox);
  // Closed by default; a deep link to one result (#files?task=) opens it.
  if (results.length) list.append(el("details", { class: "folder task-results", open: !!new URLSearchParams(location.hash.split("?")[1] || "").get("task") },
    el("summary", {}, el("h3", { class: "inline" }, "Task results"), " (" + results.length + ")"), el("p", { class: "note" }, "Results of completed team tasks and scheduled drafts. The agent does not read these as sources."),
    el("ul", { class: "list" }, results.map((x) => { const b = el("button", { type: "button", class: "secondary" }, "Open");
      b.addEventListener("click", busy(b, async () => { if (location.hash !== "#files") history.replaceState(null, "", "#files"); await openResult(x); }));
      return el("li", { class: "item" }, el("div", {}, el("strong", {}, taskFileName(x.t.title)), el("div", { class: "meta" }, x.scheduled ? "Scheduled draft · ready, not done yet" : "Team task · done " + shortTime(x.t.done.at))), b); }))));
  const q = new URLSearchParams(location.hash.split("?")[1] || ""), qPath = q.get("path"), qLine = /^\d{1,6}$/.test(q.get("line") || "") ? Number(q.get("line")) : 0;
  if (qPath) await open(qPath, qLine);
  const qTask = q.get("task"), hit = qTask && results.find((x) => x.t.taskId === qTask);
  if (hit) await openResult(hit);
  if (!files.length && !(r.result?.images || []).length && !results.length) list.append(el("p", { class: "note" }, say("chat_no_files")));
  wrap.append(list, viewer);
  return [el("h1", {}, "Shared drive"), el("p", { class: "lede" }, "Files your team and the agent can use. Nothing here is public."),
    driveAdd(!!r.result?.imagesEnabled, status), status, wrap];
}
// S1-b: set up an authenticator app from an Ops enrollment link (not in the nav). The secret, the otpauth link and the QR are
// shown once and only as text nodes and canvas pixels; after confirmation the page drops them.
async function totpView() {
  const token = totpToken; totpToken = null; // never a second enroll.start for one token
  const head = [el("h1", {}, "Set up your authenticator"), el("p", { class: "lede" }, "Newsletter releases need a 6-digit code from an authenticator app on your phone.")];
  if (!token) return [...head, notice("Open the setup link an admin gave you. Each link works once, within 15 minutes, after you sign in.")];
  const r = await api("totp.enroll.start", { token });
  if (!r.ok) return [...head, refusal(r)];
  const x = r.result, box = el("div", { class: "card totp" }), status = el("div");
  const qr = el("canvas", { class: "qr", "aria-label": "QR code for your authenticator app" }), n = x.qr.length, px = 6, pad = 4;
  qr.width = qr.height = (n + 2 * pad) * px;
  const g = qr.getContext("2d");
  if (g) { g.fillStyle = "#fff"; g.fillRect(0, 0, qr.width, qr.height); g.fillStyle = "#000";
    x.qr.forEach((row, y) => { for (let i = 0; i < row.length; i++) if (row[i] === "1") g.fillRect((i + pad) * px, (y + pad) * px, px, px); }); }
  const link = /^otpauth:\/\/totp\//.test(x.uri) ? el("a", { href: x.uri }, "Open in an authenticator app") : "";
  const c1 = el("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", "aria-label": "First code" });
  const c2 = el("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", "aria-label": "Next code" });
  const ok = el("button", { type: "button", class: "btn" }, "Confirm");
  ok.addEventListener("click", busy(ok, async () => {
    const y = await api("totp.enroll.confirm", { code1: c1.value.trim(), code2: c2.value.trim() });
    if (!y.ok) return status.replaceChildren(refusal(y));
    box.replaceChildren(notice("Your authenticator is set up. You'll enter a code from it when you release a newsletter.")); // the secret leaves the page
  }));
  box.append(el("ol", {}, el("li", {}, "Scan the QR code with your authenticator app, or open the link on your phone, or type the key."),
      el("li", {}, "Enter the code it shows, wait for the next code, and enter that one too.")),
    qr, el("p", {}, link), el("p", { class: "meta" }, "Key: ", el("span", { class: "mono" }, x.secret)),
    el("div", { class: "row" }, c1, c2, ok), status, el("p", { class: "meta" }, "Set it up before " + shortTime(x.expiresAt) + ". This page shows the key only once."));
  return [...head, box];
}
const routes = { home: homeView, meetings: meetingsView, work: workView, handbook: handbookView, map: mapView, chat: chatView, tasks: tasksView, files: filesView, website: websiteView, newsletter: newsletterView, manage: manageView, help: helpView,
  notes: notesView, review: reviewView, recordings: recordingsView, activity: activityView, members: membersView, totp: totpView };
// The top bar: Chat · Files · Website · Newsletter, and Manage for reviewers/admins (the tool pages open from Manage).
const TABS = ["chat", "tasks", "files", "website", "newsletter", "manage", "help"], UNDER_MANAGE = ["notes", "review", "recordings", "activity", "members", "handbook"];
/** THREE-JOBS J1: the top bar for chat orgs: Home · Website · Newsletter · Meetings, then Help and the account menu (Your chats,
 *  All work & files, Manage for reviewers/admins). On a phone the four jobs fold into one "Jobs" menu (no scrolling tab strip). */
function drawJobsNav(name, reviewer) {
  const JOB_OF = { home: "home", website: "website", newsletter: "newsletter", meetings: "meetings", notes: "meetings", recordings: "meetings" };
  const current = JOB_OF[name] ?? null, jobs = [{ key: "home", title: "Home" }, ...JOBS()];
  const tab = (j) => el("a", { href: "#" + j.key, "aria-current": j.key === current ? "page" : null }, j.title);
  const menu = (label, cls, items) => { const d = el("details", { class: "nav-menu " + cls }, el("summary", {}, label), el("div", { class: "menu" }, ...items));
    d.querySelector(".menu").addEventListener("click", () => { d.open = false; }); return d; };
  const account = menu(me.email, "account", [el("a", { href: "#chat" }, "Your chats"), el("a", { href: "#work" }, "All work & files"),
    ...(reviewer ? [el("a", { href: "#manage" }, "Manage")] : [])]);
  nav.replaceChildren(el("span", { class: "jobs-tabs" }, ...jobs.map(tab)), menu("Jobs", "jobs-menu", jobs.map(tab)), el("span", { class: "spacer" }),
    el("a", { href: "#help", class: "help-link", "aria-current": name === "help" ? "page" : null }, "Help"), account);
  document.getElementById("who").textContent = "";
}
let routeSeq = 0; // only the LATEST navigation draws (a slow earlier page must not overwrite the one the member moved to)
let lastRoute = null;
async function route() {
  const seq = ++routeSeq;
  const name = (location.hash || (me.chat ? "#home" : "#notes")).slice(1).split("?")[0]; // P-1: "#files?path=…&line=…" is the files route
  if (name === "chat" && lastRoute !== "chat") chatState.landing = true; // a visit, not a click inside Chat
  lastRoute = routes[name] || !me.chat ? name : "home";
  const reviewer = ["admin", "reviewer"].includes(me.role);
  if (me.chat) drawJobsNav(routes[name] ? name : "home", reviewer);
  else {
    // An org without chat keeps Notes (its question page) as the first tab; Newsletter needs chat or the website copy.
    const tabs = ["notes", ...TABS];
    const current = UNDER_MANAGE.includes(name) && !tabs.includes(name) ? "manage" : name;
    nav.replaceChildren(...tabs.filter((k) => k !== "chat" && (k !== "tasks" || me.teamTasks) && (k !== "website" || me.website) && (k !== "newsletter" || me.website)
      && (k !== "manage" || reviewer)).map((k) =>
      el("a", { href: "#" + k, "aria-current": k === current ? "page" : null }, k[0].toUpperCase() + k.slice(1))));
  }
  main.replaceChildren(el("p", { class: "note" }, "Loading…"));
  const view = [await (routes[name] || (me.chat ? homeView : notesView))()].flat(Infinity);
  if (seq !== routeSeq) return;
  main.replaceChildren(...view);
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
async function render() {
  if (!org) { main.replaceChildren(el("h1", {}, "Not found")); return; }
  if (inviteToken !== null) { nav.replaceChildren(); main.replaceChildren(...(await inviteView()).flat()); return; }
  if (!me) { const r = await api("member.me"); if (r.ok) me = r.result; }
  if (!me) { nav.replaceChildren(); document.getElementById("who").textContent = ""; main.replaceChildren(...loginView()); return; }
  document.getElementById("org-label").textContent = me.label || org;
  document.title = me.label || org;
  document.getElementById("who").textContent = me.chat ? "" : me.email; // no internal role word in the top bar (chat orgs: the account menu)
  await route();
}
window.addEventListener("hashchange", () => { if (me) route(); });
render();
