import { describe, expect, test } from '@jest/globals';

import {
  isStreamDeckHomeActionAllowed,
  isStreamDeckMusicActionAllowed,
  isStreamDeckRouteAllowed,
  isStreamDeckSceneActionAllowed,
} from '../src/identity/oidcClientPolicy';

describe('Stream Deck least-privilege policy', () => {
  test('allows only the routes required by the physical buttons', () => {
    expect(isStreamDeckRouteAllowed('GET', '/v1/music')).toBe(true);
    expect(isStreamDeckRouteAllowed('POST', '/v1/music/actions')).toBe(true);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home/lights')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home/lighting/rooms')).toBe(true);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home/stream-deck/status')).toBe(true);
    expect(isStreamDeckRouteAllowed('PUT', '/v1/home/lighting/rooms/room_living/mode')).toBe(true);
    expect(isStreamDeckRouteAllowed('PUT', '/v1/home/lighting/rooms/room living/mode')).toBe(false);
    expect(isStreamDeckRouteAllowed('PUT', '/v1/home/lighting/rooms/room_living/profile')).toBe(false);
    expect(isStreamDeckRouteAllowed('POST', '/v1/home/actions')).toBe(true);
    expect(isStreamDeckRouteAllowed('POST', '/v1/home/scenes/film/run')).toBe(true);
    expect(isStreamDeckRouteAllowed('POST', '/v1/home/scenes/leave-home/run')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/admin/users')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/threads')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/mail/messages')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/calendar/events')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/auth/me')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home/devices/living-vacuum/robot')).toBe(false);
    expect(isStreamDeckRouteAllowed('POST', '/v1/home/devices/living-vacuum/robot/clean')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home')).toBe(false);
  });

  test('denies advanced Spotify mutations and permits only binary light and TV controls', () => {
    expect(isStreamDeckMusicActionAllowed('volume')).toBe(true);
    expect(isStreamDeckMusicActionAllowed('next')).toBe(true);
    expect(isStreamDeckMusicActionAllowed('transfer')).toBe(true);
    expect(isStreamDeckMusicActionAllowed('shuffle')).toBe(false);
    expect(isStreamDeckMusicActionAllowed('save_library')).toBe(false);
    expect(isStreamDeckHomeActionAllowed('light', 'turn_on')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('light', 'turn_off')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'turn_on')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'turn_off')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'select_source')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'volume_up')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'mute')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'set_volume')).toBe(false);
    expect(isStreamDeckHomeActionAllowed('vacuum', 'start')).toBe(false);
    expect(isStreamDeckSceneActionAllowed('film', 'switch', 'turn_on')).toBe(true);
    expect(isStreamDeckSceneActionAllowed('film', 'switch', 'turn_off')).toBe(true);
    expect(isStreamDeckSceneActionAllowed('film', 'switch', 'toggle')).toBe(false);
    expect(isStreamDeckSceneActionAllowed('leave-home', 'switch', 'turn_off')).toBe(false);
  });
});
