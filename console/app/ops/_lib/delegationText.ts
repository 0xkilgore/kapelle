/** Fixed public text shared by the Task page and the scoped chat surface, so both say exactly the same thing for the
 * same saved state. Never raw exception or provider text. */
import type {TaskHostReadReason} from './taskHostContract';

/** Fixed public text for worker reasons. No control here starts work again; these only explain the saved state. */
export function workReason(reason:string|null){
 switch(reason){
  case null:return '';
  case 'provider_receipt_unconfirmed':return 'The agent run did not return a confirmed result. Nothing is started again automatically.';
  case 'provider_termination_unconfirmed':return 'The agent run is being stopped, but its end is not confirmed yet.';
  case 'publisher_not_admitted':return 'The output is retained, but no admitted Report publisher is available yet.';
  case 'publisher_model_not_admitted':return 'The output is retained. The Report library is not ready to accept it yet.';
  case 'publication_uncertain':return 'The Report publication was not acknowledged. The same publication is checked, never repeated.';
  case 'readback_unconfirmed':return 'The Report could not be verified through the current Report reader. Its saved execution is retained.';
  case 'reader_not_admitted':return 'The independent Report reader is unavailable, so the result stays unverified.';
  case 'native_result_unconfirmed':return 'The Report exists, but the assignment record has not confirmed it yet.';
  case 'claude_unexpected_message':return 'The agent runtime sent an unexpected message. Execution is unconfirmed and will not be started again.';
  case 'rejection_limit':return 'The agent runtime refused to start three times. Nothing was produced.';
  case 'claude_oauth_not_available':return 'The agent runtime had no usable sign-in. Nothing was started or charged.';
  case 'claude_private_runtime_required':return 'The agent runtime could not create its private working directory. Nothing was started.';
  default:return reason.startsWith('claude_runtime_mismatch')?'The agent runtime refused initialization. Execution is unconfirmed and will not be started again.':'The agent runtime reported a status this page does not describe yet. Execution is unconfirmed.';
 }
}
export const READ_REASONS:Record<TaskHostReadReason,string>={
 deadline:'The check took too long and was stopped.',host_unavailable:'The task host could not be reached.',execution_unavailable:'Its execution status could not be read.',
 worker_bound_elsewhere:'Its worker is not the one currently connected.',admission_unavailable:'Current agent availability could not be read.',
 page_limit:'More assignments exist than one check reads.',reader_unavailable:'The Report reader could not be reached.',report_changed:'The Report no longer matches the saved result.',
};
