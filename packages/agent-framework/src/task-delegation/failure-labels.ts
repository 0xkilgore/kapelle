/** Fixed failure vocabulary for persisted worker reasons. Only these exact strings are ever stored; anything else is
 * 'unlabeled'. Native assertion prose maps to a fixed slug. Never derived from an error's text by shape. */
import {CLI_BUILTIN_PLUGINS} from '../worker/claude-adapter.js';
/** The persisted journal format for uncertainReason (worker attempt schema). Every stored reason conforms. */
export const REASON_PATTERN=/^[a-z][a-z0-9_]{0,80}(?::[a-z0-9_.,:+=@-]{1,300})?$/;
const CODES=new Set<string>([
 'claude_auth_mode_invalid','claude_auth_mode_required','claude_boot_identity_unavailable','claude_child_identity','claude_completion_unconfirmed','claude_cwd_identity',
 'claude_incomplete_result','claude_init_unavailable','claude_interrupted','claude_invalid_message','claude_process_admission_unconfirmed','claude_process_pin_changed',
 'claude_process_scope_closed','claude_provider_account_interrupted','claude_provider_account_mismatch','claude_provider_account_unavailable','claude_provider_binding_invalid','claude_provider_context_invalid',
 'claude_session_mismatch','claude_termination_audit_failed','claude_termination_reconciliation_required','claude_uncertainty_persistence_failed','claude_unexpected_assistant','claude_unexpected_message',
 'claude_unexpected_retry','claude_unexpected_status','claude_unexpected_progress','claude_unexpected_rate_limit','claude_cli_builtin_plugins_unpinned','claude_oauth_not_available','claude_private_runtime_required','claude_provider_binding_mismatch',
 'independent_reader_write_forbidden','publisher_model_not_admitted','independent_report_reader_required','invocation_fence_changed','observation_only','pilot_ambiguous','pilot_approval_required',
 'pilot_binding_changed','pilot_control_command_forbidden','pilot_control_nested','pilot_control_owner_changed','pilot_control_scope_changed','pilot_deadlines_changed',
 'pilot_definition_changed','pilot_direct_owner_task_only','pilot_exact_plan_required','pilot_exact_task_source_required','pilot_explicit_opt_in_required','pilot_explicit_reconciliation_required',
 'pilot_file_pin_changed','pilot_generation_forbidden','pilot_generic_effect_forbidden','pilot_grant_scope','pilot_instance_changed','pilot_invocation_consumed',
 'pilot_lifecycle_only','pilot_model_policy','pilot_not_production','pilot_packet_changed','pilot_profile_changed','pilot_publication_identity_changed',
 'pilot_publication_nested','pilot_publication_transport_required','pilot_recipient_changed','pilot_recovery_allocation_forbidden','pilot_recovery_command_forbidden','pilot_recovery_completed_claim_required',
 'pilot_recovery_context_forbidden','pilot_recovery_generation_forbidden','pilot_recovery_inference_forbidden','pilot_recovery_native_claim','pilot_recovery_native_result_uncertain','pilot_recovery_nested',
 'pilot_recovery_offer_changed','pilot_recovery_other_effect_forbidden','pilot_recovery_publication_changed','pilot_recovery_request_changed','pilot_recovery_scope','pilot_recovery_unavailable',
 'pilot_recovery_unrelated_operation_pending','pilot_recovery_unscoped_receipt_forbidden','pilot_recovery_unsettled','pilot_recovery_write_forbidden','pilot_runtime_binding','pilot_scope_or_expiry',
 'pilot_settlement_scope_unknown','pilot_task_or_permission','task_host_binding_changed','task_host_profile_changed_or_expired','task_launcher_asset_changed','task_launcher_publisher_code_changed',
 'task_launcher_qualification_changed','task_launcher_qualification_invalid','task_launcher_release_invalid','task_launcher_revoked','task_launcher_scope_invalid','task_launcher_storage_overlap',
 'task_launcher_token_invalid','task_packet_changed','task_packet_identity_ambiguous','task_packet_not_admitted','task_report_scope_changed','task_runtime_scope_changed',
 'task_runtime_token_unavailable','task_token_changed','worker_approved_context_required','worker_authority_scope_changed','worker_binding_changed','worker_busy',
 'worker_command_conflict','worker_context_limit','worker_dispatch_scope_changed','worker_execution_binding_changed','worker_execution_history_required','worker_execution_unconfirmed',
 'worker_invocation_reconciliation_required','worker_late_callback','worker_lock_ownership_changed','worker_model_policy_changed','worker_native_command_unconfirmed','worker_native_result_changed',
 'worker_output_unconfirmed','worker_packet_changed','worker_publisher_binding_changed','worker_recipient_binding_changed','worker_report_readback_changed','worker_report_receipt_changed',
 'worker_request_changed','worker_result_binding_changed','worker_runtime_version_changed','worker_stopping','worker_unavailable',
]);
const NATIVE=new Map<string,string>([
 ['Dispatch authority facts unavailable','dispatch_authority_facts_unavailable'],
 ['Dispatch is no longer active','dispatch_is_no_longer_active'],
 ['Dispatch parent cycle or depth exceeded','dispatch_parent_cycle_or_depth_exceeded'],
 ['Dispatch recipient differs','dispatch_recipient_differs'],
 ['Instance is paused or retired','instance_is_paused_or_retired'],
 ['Invalid dispatch offer','invalid_dispatch_offer'],
 ['Task Dispatch binding differs','task_dispatch_binding_differs'],
 ['Task approved plan differs','task_approved_plan_differs'],
 ['Task authority not configured','task_authority_not_configured'],
 ['Task authority unavailable','task_authority_unavailable'],
 ['Task authority refused','task_authority_refused'],
 ['Task delegation envelope unavailable','task_delegation_envelope_unavailable'],
 ['Task delegation is not configured','task_delegation_is_not_configured'],
 ['Task identity invalid','task_identity_invalid'],
 ['Task identity or owner differs','task_identity_or_owner_differs'],
 ['Task not admitted','task_not_admitted'],
 ['Task owner differs','task_owner_differs'],
 ['Task proposal approval differs','task_proposal_approval_differs'],
 ['Task proposal approval required','task_proposal_approval_required'],
 ['Task proposal approval scope differs','task_proposal_approval_scope_differs'],
 ['Task recipient capability changed','task_recipient_capability_changed'],
 ['Task recipient capability unavailable','task_recipient_capability_unavailable'],
 ['Task recipient model policy unavailable','task_recipient_model_policy_unavailable'],
 ['Task recipient unavailable','task_recipient_unavailable'],
 ['Task selected context too large','task_selected_context_too_large'],
 ['Task source changed','task_source_changed'],
 ['Task source envelope differs','task_source_envelope_differs'],
 ['Task source too large','task_source_too_large'],
 ['Stale document revision','stale_document_revision'],
]);
const INIT_FIELDS=new Set(['duplicate_init','model','cwd','claude_code_version','session_id','permissionMode',
 ...['tools','mcp_servers','plugins','skills','agents'].flatMap(f=>[f+'.invalid_array',f+'.nonempty'])]);
const BUILTINS=new Set(Object.values(CLI_BUILTIN_PLUGINS).flatMap(p=>[...p.disabled,p.policyOnly]));
/** claude_runtime_mismatch details: each field from the init vocabulary, a plugin count 1..999, or pinned built-in names only. */
function initField(f:string){
 if(INIT_FIELDS.has(f))return true;
 const plugin=/^plugins\.nonempty:(.+)$/.exec(f);if(!plugin)return false;
 if(/^count=[1-9][0-9]{0,2}$/.test(plugin[1]))return true;
 const names=plugin[1].split('+');return names.length<=16&&names.every(n=>BUILTINS.has(n));
}
export function failureLabel(e:unknown):string{
 const m=e instanceof Error?e.message:undefined;
 if(m===undefined)return 'unlabeled';
 if(CODES.has(m))return m;
 const native=NATIVE.get(m);if(native)return native;
 const init=/^claude_runtime_mismatch:fields=(.+)$/.exec(m);
 if(init){
  const fields=init[1].split(',');if(fields.length>16||!fields.every(initField))return 'claude_runtime_mismatch';
  // Canonical persisted spelling (lowercase journal charset); a detail that does not fit the journal, bare or under the
  // recheck: prefix, degrades to the fixed outer code. The reason is never dropped.
  const label='claude_runtime_mismatch:fields='+fields.map(f=>f==='permissionMode'?'permission_mode':f).join(',');
  return REASON_PATTERN.test(label)&&REASON_PATTERN.test('recheck:'+label)?label:'claude_runtime_mismatch';
 }
 return 'unlabeled';
}
/** Final guard before persisting: a fixed reason, optionally under a fixed prefix, that always satisfies the journal format. */
export function persistedReason(label:string,prefix?:'recheck'):string{
 const value=prefix?prefix+':'+label:label;
 return REASON_PATTERN.test(value)?value:prefix?prefix+':unlabeled':'unlabeled';
}
