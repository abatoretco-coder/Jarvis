export type HomePreset = {
  presetId: string;
  label: string;
  domain: string;
  icon: string;
  capabilities: string[];
  riskLevel: 'low' | 'moderate' | 'high';
};

export const HOME_PRESETS: readonly HomePreset[] = [
  { presetId: 'light', label: 'Lumière', domain: 'light', icon: 'lamp', capabilities: ['turn_on', 'turn_off', 'toggle'], riskLevel: 'low' },
  { presetId: 'plug', label: 'Prise', domain: 'switch', icon: 'plug', capabilities: ['turn_on', 'turn_off', 'toggle'], riskLevel: 'low' },
  { presetId: 'television', label: 'Télévision', domain: 'media_player', icon: 'tv', capabilities: ['turn_on', 'turn_off', 'play_pause'], riskLevel: 'low' },
  { presetId: 'heating', label: 'Chauffage', domain: 'climate', icon: 'thermometer', capabilities: ['turn_on', 'turn_off', 'set_temperature'], riskLevel: 'moderate' },
  { presetId: 'water-heater', label: 'Chauffe-eau', domain: 'water_heater', icon: 'droplets', capabilities: ['turn_on', 'turn_off'], riskLevel: 'moderate' },
  { presetId: 'vacuum', label: 'Robot', domain: 'vacuum', icon: 'bot', capabilities: ['start', 'return_to_base'], riskLevel: 'low' },
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
