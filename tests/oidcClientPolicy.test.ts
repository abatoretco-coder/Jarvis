import { describe, expect, test } from '@jest/globals';

import {
  isStreamDeckHomeActionAllowed,
  isStreamDeckMusicActionAllowed,
  isStreamDeckRouteAllowed,
} from '../src/identity/oidcClientPolicy';

describe('Stream Deck least-privilege policy', () => {
  test('allows only the four routes required by the physical buttons', () => {
    expect(isStreamDeckRouteAllowed('GET', '/v1/music')).toBe(true);
    expect(isStreamDeckRouteAllowed('POST', '/v1/music/actions')).toBe(true);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home/lights')).toBe(true);
    expect(isStreamDeckRouteAllowed('POST', '/v1/home/actions')).toBe(true);
    expect(isStreamDeckRouteAllowed('GET', '/v1/admin/users')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/threads')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/mail/messages')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/calendar/events')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/auth/me')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home/devices/living-vacuum/robot')).toBe(false);
    expect(isStreamDeckRouteAllowed('POST', '/v1/home/devices/living-vacuum/robot/clean')).toBe(false);
    expect(isStreamDeckRouteAllowed('GET', '/v1/home')).toBe(false);
  });

  test('denies advanced Spotify mutations and non-light home controls', () => {
    expect(isStreamDeckMusicActionAllowed('volume')).toBe(true);
    expect(isStreamDeckMusicActionAllowed('next')).toBe(true);
    expect(isStreamDeckMusicActionAllowed('save_library')).toBe(false);
    expect(isStreamDeckMusicActionAllowed('transfer')).toBe(false);
    expect(isStreamDeckHomeActionAllowed('light', 'turn_on')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('light', 'turn_off')).toBe(true);
    expect(isStreamDeckHomeActionAllowed('media_player', 'turn_on')).toBe(false);
    expect(isStreamDeckHomeActionAllowed('vacuum', 'start')).toBe(false);
  });
});
