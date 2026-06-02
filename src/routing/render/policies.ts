import type { ActionExecutionResult, RenderPolicy, RenderPolicyMap } from './types';

export const DEFAULT_RENDER_POLICY: RenderPolicy = {
  mode: 'service_text_passthrough',
  maxChars: 600,
  allowVoiceCompression: true,
};

export const RENDER_POLICY_MAP: RenderPolicyMap = {
  // Spotify blind deterministic actions
  'spotify.pause': { mode: 'deterministic_static', maxChars: 80, allowVoiceCompression: true },
  'spotify.play': { mode: 'deterministic_static', maxChars: 80, allowVoiceCompression: true },
  'spotify.next': { mode: 'deterministic_static', maxChars: 80, allowVoiceCompression: true },
  'spotify.previous': { mode: 'deterministic_static', maxChars: 80, allowVoiceCompression: true },
  'spotify.clear_queue': { mode: 'deterministic_static', maxChars: 80, allowVoiceCompression: true },

  // Spotify data-driven actions
  'spotify.now_playing': { mode: 'deterministic_template', templateKey: 'spotify.now_playing', maxChars: 140, allowVoiceCompression: true },
  'spotify.list_devices': { mode: 'deterministic_template', templateKey: 'spotify.list_devices', maxChars: 220, allowVoiceCompression: true },
  'spotify.search': { mode: 'deterministic_template', templateKey: 'spotify.search', maxChars: 220, allowVoiceCompression: true },
  'spotify.search_and_play': { mode: 'deterministic_template', templateKey: 'spotify.search_and_play', maxChars: 220, allowVoiceCompression: true },
  'spotify.queue_add': { mode: 'deterministic_template', templateKey: 'spotify.queue_add', maxChars: 220, allowVoiceCompression: true },
  'spotify.transfer': { mode: 'deterministic_template', templateKey: 'spotify.transfer', maxChars: 220, allowVoiceCompression: true },
  'spotify.add_to_playlist': { mode: 'deterministic_template', templateKey: 'spotify.add_to_playlist', maxChars: 220, allowVoiceCompression: true },
  'spotify.volume_set': { mode: 'deterministic_template', templateKey: 'spotify.volume_set', maxChars: 220, allowVoiceCompression: true },

  // Search E2 direct
  'search.news.external_weather': { mode: 'service_text_passthrough', maxChars: 700, allowVoiceCompression: true },
  'search.news.live_sport': { mode: 'service_text_passthrough', maxChars: 700, allowVoiceCompression: true },
  'search.news.current_news': { mode: 'service_text_passthrough', maxChars: 700, allowVoiceCompression: true },
  'search.web.definition': { mode: 'service_text_passthrough', maxChars: 700, allowVoiceCompression: true },
  'search.web.quick_lookup': { mode: 'service_text_passthrough', maxChars: 700, allowVoiceCompression: true },

  // Search E1 deep
  'search.deep.analysis': { mode: 'llm_domain_rephrase', promptKey: 'search.deep', maxChars: 520, allowVoiceCompression: true },
  'search.deep.history': { mode: 'llm_domain_rephrase', promptKey: 'search.deep', maxChars: 520, allowVoiceCompression: true },
  'search.deep.comparison': { mode: 'llm_domain_rephrase', promptKey: 'search.deep', maxChars: 520, allowVoiceCompression: true },

  // Weather E2
  'weather.current_temperature': { mode: 'deterministic_template', templateKey: 'weather.current_temperature', maxChars: 220, allowVoiceCompression: true },
  'weather.current_humidity': { mode: 'deterministic_template', templateKey: 'weather.current_humidity', maxChars: 220, allowVoiceCompression: true },
  'weather.current_precipitation': { mode: 'deterministic_template', templateKey: 'weather.current_precipitation', maxChars: 220, allowVoiceCompression: true },
  'weather.current_conditions': { mode: 'deterministic_template', templateKey: 'weather.current_conditions', maxChars: 220, allowVoiceCompression: true },

  // Todo E1
  'todo.list_tasks': { mode: 'deterministic_template', templateKey: 'todo.list_tasks', maxChars: 360, allowVoiceCompression: true },
  'todo.list_tasks.today': { mode: 'deterministic_template', templateKey: 'todo.list_tasks.today', maxChars: 360, allowVoiceCompression: true },
  'todo.list_tasks.tomorrow': { mode: 'deterministic_template', templateKey: 'todo.list_tasks.tomorrow', maxChars: 360, allowVoiceCompression: true },
  'todo.list_tasks.this_week': { mode: 'deterministic_template', templateKey: 'todo.list_tasks.this_week', maxChars: 360, allowVoiceCompression: true },
  'todo.list_tasks.overdue': { mode: 'deterministic_template', templateKey: 'todo.list_tasks.overdue', maxChars: 360, allowVoiceCompression: true },
  'todo.list_lists': { mode: 'deterministic_template', templateKey: 'todo.list_lists', maxChars: 320, allowVoiceCompression: true },
  'todo.add_task': { mode: 'llm_domain_rephrase', promptKey: 'todo.action', maxChars: 300, allowVoiceCompression: true },
  'todo.complete_task': { mode: 'deterministic_template', templateKey: 'todo.complete_task', maxChars: 280, allowVoiceCompression: true },
  'todo.delete_task': { mode: 'deterministic_template', templateKey: 'todo.delete_task', maxChars: 280, allowVoiceCompression: true },
  'todo.update_task': { mode: 'llm_domain_rephrase', promptKey: 'todo.action', maxChars: 300, allowVoiceCompression: true },
  'todo.create_list': { mode: 'deterministic_template', templateKey: 'todo.create_list', maxChars: 280, allowVoiceCompression: true },
  'todo.delete_list': { mode: 'deterministic_template', templateKey: 'todo.delete_list', maxChars: 280, allowVoiceCompression: true },
  'todo.add_checklist_item': { mode: 'deterministic_template', templateKey: 'todo.add_checklist_item', maxChars: 280, allowVoiceCompression: true },
  'todo.complete_checklist_item': { mode: 'deterministic_template', templateKey: 'todo.complete_checklist_item', maxChars: 280, allowVoiceCompression: true },
  'todo.delete_checklist_item': { mode: 'deterministic_template', templateKey: 'todo.delete_checklist_item', maxChars: 280, allowVoiceCompression: true },

  // Mail E1
  'mail.list_inbox': { mode: 'deterministic_template', templateKey: 'mail.list_inbox', maxChars: 360, allowVoiceCompression: true },
  'mail.list_inbox.unread': { mode: 'deterministic_template', templateKey: 'mail.list_inbox.unread', maxChars: 360, allowVoiceCompression: true },
  'mail.search_emails': { mode: 'service_text_passthrough', maxChars: 420, allowVoiceCompression: true },
  'mail.send_email': { mode: 'llm_domain_rephrase', promptKey: 'mail.action', maxChars: 340, allowVoiceCompression: true },
  'mail.reply_email': { mode: 'llm_domain_rephrase', promptKey: 'mail.action', maxChars: 340, allowVoiceCompression: true },
  'mail.forward_email': { mode: 'llm_domain_rephrase', promptKey: 'mail.action', maxChars: 340, allowVoiceCompression: true },
  'mail.mark_read': { mode: 'deterministic_template', templateKey: 'mail.mark_read', maxChars: 260, allowVoiceCompression: true },
  'mail.mark_unread': { mode: 'deterministic_template', templateKey: 'mail.mark_unread', maxChars: 260, allowVoiceCompression: true },
  'mail.trash_email': { mode: 'deterministic_template', templateKey: 'mail.trash_email', maxChars: 260, allowVoiceCompression: true },
  'mail.flag_email': { mode: 'deterministic_template', templateKey: 'mail.flag_email', maxChars: 260, allowVoiceCompression: true },

  // Executors E1
  'executor.greeting': { mode: 'deterministic_template', templateKey: 'executor.greeting', maxChars: 220, allowVoiceCompression: true },
  'executor.help': { mode: 'service_text_passthrough', maxChars: 420, allowVoiceCompression: true },
  'executor.status': { mode: 'service_text_passthrough', maxChars: 420, allowVoiceCompression: true },
  'executor.timer': { mode: 'deterministic_template', templateKey: 'executor.timer', maxChars: 260, allowVoiceCompression: true },
  'executor.note': { mode: 'deterministic_template', templateKey: 'executor.note', maxChars: 260, allowVoiceCompression: true },
  'executor.scene_set': { mode: 'deterministic_template', templateKey: 'executor.scene_set', maxChars: 260, allowVoiceCompression: true },
  'executor.media_play_pause': { mode: 'deterministic_template', templateKey: 'executor.media_play_pause', maxChars: 260, allowVoiceCompression: true },
  'executor.media_next': { mode: 'deterministic_template', templateKey: 'executor.media_next', maxChars: 260, allowVoiceCompression: true },
  'executor.media_previous': { mode: 'deterministic_template', templateKey: 'executor.media_previous', maxChars: 260, allowVoiceCompression: true },
  'executor.volume_up': { mode: 'deterministic_template', templateKey: 'executor.volume_up', maxChars: 260, allowVoiceCompression: true },
  'executor.volume_down': { mode: 'deterministic_template', templateKey: 'executor.volume_down', maxChars: 260, allowVoiceCompression: true },
  'executor.mute': { mode: 'deterministic_template', templateKey: 'executor.mute', maxChars: 260, allowVoiceCompression: true },
  'executor.unmute': { mode: 'deterministic_template', templateKey: 'executor.unmute', maxChars: 260, allowVoiceCompression: true },
  'executor.climate_set': { mode: 'deterministic_template', templateKey: 'executor.climate_set', maxChars: 300, allowVoiceCompression: true },
  'executor.lock': { mode: 'deterministic_template', templateKey: 'executor.lock', maxChars: 260, allowVoiceCompression: true },
  'executor.unlock': { mode: 'deterministic_template', templateKey: 'executor.unlock', maxChars: 260, allowVoiceCompression: true },
  'executor.vacuum_start': { mode: 'deterministic_template', templateKey: 'executor.vacuum_start', maxChars: 260, allowVoiceCompression: true },
  'executor.vacuum_stop': { mode: 'deterministic_template', templateKey: 'executor.vacuum_stop', maxChars: 260, allowVoiceCompression: true },
  'executor.cover_open': { mode: 'deterministic_template', templateKey: 'executor.cover_open', maxChars: 260, allowVoiceCompression: true },
  'executor.cover_close': { mode: 'deterministic_template', templateKey: 'executor.cover_close', maxChars: 260, allowVoiceCompression: true },

  // Domain-level defaults
  spotify: { mode: 'deterministic_template', maxChars: 220, allowVoiceCompression: true },
  search: { mode: 'llm_domain_rephrase', promptKey: 'search.domain', maxChars: 520, allowVoiceCompression: true },
  weather: { mode: 'deterministic_template', maxChars: 260, allowVoiceCompression: true },
  todo: { mode: 'llm_domain_rephrase', promptKey: 'todo.domain', maxChars: 360, allowVoiceCompression: true },
  mail: { mode: 'llm_domain_rephrase', promptKey: 'mail.domain', maxChars: 360, allowVoiceCompression: true },
  calendar: { mode: 'llm_domain_rephrase', promptKey: 'calendar.domain', maxChars: 360, allowVoiceCompression: true },
  executors: { mode: 'deterministic_template', maxChars: 280, allowVoiceCompression: true },
  general: { mode: 'service_text_passthrough', maxChars: 500, allowVoiceCompression: true },
};

export function resolveRenderPolicy(result: ActionExecutionResult): RenderPolicy {
  if (result.status !== 'success') {
    return { mode: 'deterministic_error', maxChars: 260, allowVoiceCompression: true };
  }

  if (RENDER_POLICY_MAP[result.actionKey]) {
    return RENDER_POLICY_MAP[result.actionKey];
  }

  if (result.actionKey.startsWith('spotify.')) return RENDER_POLICY_MAP.spotify;
  if (result.actionKey.startsWith('search.')) return RENDER_POLICY_MAP.search;
  if (result.actionKey.startsWith('weather.')) return RENDER_POLICY_MAP.weather;
  if (result.actionKey.startsWith('todo.')) return RENDER_POLICY_MAP.todo;
  if (result.actionKey.startsWith('mail.')) return RENDER_POLICY_MAP.mail;
  if (result.actionKey.startsWith('calendar.')) return RENDER_POLICY_MAP.calendar;
  if (result.actionKey.startsWith('executor.')) return RENDER_POLICY_MAP.executors;
  if (result.actionKey.startsWith('executors.')) return RENDER_POLICY_MAP.executors;

  return RENDER_POLICY_MAP[result.domain] ?? DEFAULT_RENDER_POLICY;
}
