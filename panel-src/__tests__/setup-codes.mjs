// Setup HTTP errors and symbolic diagnostics from profile-session.cjs,
// managed-setup.cjs, project-access.cjs, auth.cjs and the API fallback.
export const setupErrors = [
  'setup_failed', 'not_connected', 'reauthorize_required', 'frozen', 'no_access',
  'access_required', 'admin_required', 'preview_changed', 'busy', 'not_renewable',
  'dist_failed', 'stale_base', 'merge_conflict', 'setup_not_installed', 'framework_update_required',
  'preview_stale', 'preview_required', 'publish_failed', 'unexpected_response', 'invalid_input',
  'not_found', 'key_unavailable', 'invalid_age_key', 'biz_access_unavailable',
  'invalid_biz_access_decision', 'profile_required', 'biz_access_not_configured', 'invalid_origin',
  'biz_unreachable', 'unexpected_empty_response',
];

export const pauseReasons = [
  'reauthorize_required', 'not_connected', 'biz_unreachable', 'unexpected_empty_response',
];
