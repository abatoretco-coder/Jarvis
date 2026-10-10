export type HomePreset = {
  presetId: string;
  label: string;
  domain: string;
  icon: string;
  capabilities: string[];
  riskLevel: 'low' | 'moderate' | 'high';
};

export const HOME_PRESETS: readonly HomePreset[] = [
  { presetId: 'light', label: 'Lumière', domain: 'light', icon: 'lamp', capabilities: ['turn_on', 'turn_off', 'toggle', 'set_brightness'], riskLevel: 'low' },
  { presetId: 'plug', label: 'Prise', domain: 'switch', icon: 'plug', capabilities: ['turn_on', 'turn_off', 'toggle'], riskLevel: 'low' },
  { presetId: 'television', label: 'Télévision', domain: 'media_player', icon: 'tv', capabilities: ['turn_on', 'turn_off', 'play_pause', 'media_play', 'media_pause', 'media_stop', 'media_next', 'media_previous', 'set_volume', 'volume_up', 'volume_down', 'mute', 'unmute', 'play_channel', 'select_source', 'select_sound_output', 'remote_key'], riskLevel: 'low' },
  { presetId: 'heating', label: 'Chauffage', domain: 'climate', icon: 'thermometer', capabilities: ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode', 'set_preset_mode', 'set_temperature_offset', 'set_child_lock', 'set_preheating'], riskLevel: 'moderate' },
  { presetId: 'water-heater', label: 'Chauffe-eau', domain: 'water_heater', icon: 'droplets', capabilities: ['turn_on', 'turn_off', 'set_temperature', 'set_operation_mode', 'set_away_mode', 'set_eco_mode', 'set_boost_mode', 'set_antilegionella'], riskLevel: 'moderate' },
  { presetId: 'vacuum', label: 'Robot', domain: 'vacuum', icon: 'bot', capabilities: ['start', 'stop', 'return_to_base', 'locate', 'set_suction_mode', 'set_mop_mode', 'empty_dust_bin', 'wash_mop', 'start_mop_drying', 'stop_mop_drying'], riskLevel: 'low' },
  { presetId: 'shutter', label: 'Volet', domain: 'cover', icon: 'blinds', capabilities: ['open', 'close', 'stop'], riskLevel: 'moderate' },
  { presetId: 'doorbell', label: 'Sonnette', domain: 'binary_sensor', icon: 'bell', capabilities: [], riskLevel: 'low' },
  { presetId: 'camera', label: 'Caméra', domain: 'camera', icon: 'camera', capabilities: ['view'], riskLevel: 'high' },
  { presetId: 'sensor', label: 'Capteur', domain: 'sensor', icon: 'gauge', capabilities: [], riskLevel: 'low' },
] as const;

export function getHomePreset(presetId: string): HomePreset | undefined {
  return HOME_PRESETS.find((preset) => preset.presetId === presetId);
}

export function getDefaultPresetForDomain(domain: string): HomePreset | undefined {
  return HOME_PRESETS.find((preset) => preset.domain === domain);
}
