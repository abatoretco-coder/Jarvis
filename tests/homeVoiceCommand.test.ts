import { join } from 'node:path';

import { describe, expect, it } from '@jest/globals';

import { HomeCatalog, inferDeterministicTvVolumeAction } from '../src/home/HomeCatalog';

const television = [{ deviceId: 'living-room-tv', name: 'TV du séjour' }];

describe('deterministic TV voice commands', () => {
  it.each([
    ['Jarvis, tamise le salon', 'room_living', 'dimmed'],
    ['Allume les lumières du salon', 'room_living', 'on'],
    ['Jarvis, allume la cuisine', 'room_kitchen', 'on'],
    ['Je voudrais que tu allumes la chambre, s’il te plaît', 'room_bedroom', 'on'],
    ['Allumne salon', 'room_living', 'on'],
    ['Je voudrais que tu allumes la chambre, elle est uniquement en mode tamisé', 'room_bedroom', 'on'],
    ['Jarvis, éteins la chambre', 'room_bedroom', 'off'],
    ['Éclaire le bureau', 'room_office', 'on'],
  ] as const)('maps a room lighting mode locally: %s', (text, roomId, mode) => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );

    expect(catalog.inferDeterministicRoomLightingMode(text)).toMatchObject({ roomId, mode });
  });

  it('keeps an explicitly named lamp on the individual-device command path', () => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );

    expect(catalog.inferDeterministicRoomLightingMode('Éteins le plafonnier de la cuisine')).toBeUndefined();
    expect(catalog.inferDeterministicVoiceAction('Éteins le plafonnier de la cuisine')).toMatchObject({
      deviceId: 'hue-kitchen-ceiling',
      action: 'turn_off',
    });
  });

  it.each([
    'Tout couper',
    'Je suis parti',
    'Éteins tout',
  ])('finds the one-shot departure scene from its configured voice phrase: %s', (text) => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );

    expect(catalog.findSceneByVoicePhrase(text)?.sceneId).toBe('leave-home');
  });

  it.each([
    'Jarvis, allume la télé.',
    'Jervis, allume la télé.',
    'Hey Jarvis, allume la télé.',
  ])('ignores the wake word before an exact configured action: %s', (text) => {
    const catalog = new HomeCatalog(
      join(process.cwd(), 'config', 'homes'),
      'home_fr_paris_10_fsm_236_lot_204'
    );

    expect(catalog.findQuickActionByVoicePhrase(text)?.quickActionId).toBe('tv-power-on');
  });

  it.each([
    'hey jarvis, met le son de la téléphone à 2',
    'met le son de la télé à 2',
    'règle le volume de la télévision à 35',
  ])('maps an explicit TV volume command locally: %s', (text) => {
    expect(inferDeterministicTvVolumeAction(text, television)).toEqual({
      name: 'TV du séjour',
      deviceId: 'living-room-tv',
      action: 'set_volume',
      value: text.includes('35') ? 35 : 2,
    });
  });

  it.each([
    'mets le son',
    'mets de la musique sur Spotify',
    'mets le son de la télé à 101',
    'mets le son de la télé à 2 et allume la lumière',
  ])('does not execute an ambiguous or invalid request: %s', (text) => {
    expect(inferDeterministicTvVolumeAction(text, television)).toBeUndefined();
  });

  it('does not guess when several televisions exist', () => {
    expect(inferDeterministicTvVolumeAction('mets le son de la télé à 2', [
      ...television,
      { deviceId: 'bedroom-tv', name: 'TV chambre' },
    ])).toBeUndefined();
  });
});
