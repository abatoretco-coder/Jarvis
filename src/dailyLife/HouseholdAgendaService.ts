import { createHash } from 'node:crypto';

import {
  discoverOwnedCalendarIds,
  fetchUpcomingEventsMultiCalendarDetailed,
  type GoogleCalendarEvent,
} from '../calendar/googleCalendarClient';
import type { Env } from '../env';
import type { IntegrationService } from '../integrations/IntegrationService';
import { DailyLifeRepository, type HouseholdAgendaMember } from './DailyLifeRepository';

const MEMBER_COLORS = ['#38d6a4', '#55a7ff', '#f5ae4f', '#cf78ff', '#ff7f91', '#52c7d9'];

export type HouseholdAgendaOwner = { userId: string; displayName: string; color: string };
export type HouseholdAgendaEvent = {
  eventKey: string;
  title: string;
  location: string | null;
  start: string;
  end: string;
  allDay: boolean;
  busy: boolean;
  owners: HouseholdAgendaOwner[];
};
export type HouseholdAgendaMemberState = HouseholdAgendaMember & {
  color: string;
  sourceStatus: 'ready' | 'private' | 'not_connected' | 'error';
};
export type HouseholdAgendaSnapshot = {
  householdId: string;
  timeMin: string;
  timeMax: string;
  status: 'ok' | 'partial';
  members: HouseholdAgendaMemberState[];
  events: HouseholdAgendaEvent[];
};

type CalendarCredential = { userId: string; displayName: string; refreshToken: string };

function eventStart(event: GoogleCalendarEvent): string | null {
  return event.start?.dateTime ?? event.start?.date ?? null;
}

function eventEnd(event: GoogleCalendarEvent): string | null {
  return event.end?.dateTime ?? event.end?.date ?? null;
}

function eventIdentity(event: GoogleCalendarEvent): string {
  return `${event.iCalUID?.trim() || event.id}|${eventStart(event) ?? ''}|${eventEnd(event) ?? ''}`;
}

function opaqueEventKey(identity: string): string {
  return createHash('sha256').update(identity, 'utf8').digest('base64url').slice(0, 22);
}

export class HouseholdAgendaService {
  constructor(
    private readonly dailyLife: DailyLifeRepository,
    private readonly integrations: IntegrationService,
    private readonly env: Env,
  ) {}

  async snapshot(userId: string, timeMin: string, timeMax: string): Promise<HouseholdAgendaSnapshot> {
    const household = this.dailyLife.calendarMembers(userId);
    const colors = new Map(household.members.map((member, index) => [
      member.userId,
      MEMBER_COLORS[index % MEMBER_COLORS.length]!,
    ]));
    const credentials = this.integrations.resolveSharedHouseholdRefreshTokens(
      userId,
      'google-calendar',
    ) as CalendarCredential[];
    const results = await Promise.all(credentials.map(async (credential) => {
      try {
        const calendarEnv = {
          GOOGLE_CLIENT_ID: this.env.GOOGLE_CLIENT_ID!,
          GOOGLE_CLIENT_SECRET: this.env.GOOGLE_CLIENT_SECRET!,
          GOOGLE_REFRESH_TOKEN: credential.refreshToken,
        };
        const calendarIds = await discoverOwnedCalendarIds(calendarEnv);
        const fetched = await fetchUpcomingEventsMultiCalendarDetailed(
          calendarEnv, calendarIds, timeMin, timeMax, 100,
        );
        return { credential, events: fetched.events, failed: fetched.failedCalendarIds.length > 0 };
      } catch {
        return { credential, events: [] as GoogleCalendarEvent[], failed: true };
      }
    }));
    const failedUsers = new Set(results.filter((result) => result.failed).map((result) => result.credential.userId));
    const grouped = new Map<string, HouseholdAgendaEvent>();
    for (const result of results) {
      const owner = {
        userId: result.credential.userId,
        displayName: result.credential.displayName,
        color: colors.get(result.credential.userId) ?? MEMBER_COLORS[0]!,
      };
      for (const event of result.events) {
        if (event.status === 'cancelled') continue;
        const start = eventStart(event);
        const end = eventEnd(event);
        if (!start || !end) continue;
        const identity = eventIdentity(event);
        const privateEvent = event.visibility === 'private' || event.visibility === 'confidential';
        const existing = grouped.get(identity);
        if (existing) {
          if (!existing.owners.some((candidate) => candidate.userId === owner.userId)) existing.owners.push(owner);
          if (privateEvent) {
            existing.title = 'Occupé';
            existing.location = null;
          }
          continue;
        }
        grouped.set(identity, {
          eventKey: opaqueEventKey(identity),
          title: privateEvent ? 'Occupé' : event.summary?.trim() || '(sans titre)',
          location: privateEvent ? null : event.location?.trim() || null,
          start,
          end,
          allDay: Boolean(event.start?.date && !event.start?.dateTime),
          busy: event.transparency !== 'transparent',
          owners: [owner],
        });
      }
    }
    const members: HouseholdAgendaMemberState[] = household.members.map((member) => ({
      ...member,
      color: colors.get(member.userId) ?? MEMBER_COLORS[0]!,
      sourceStatus: !member.connected ? 'not_connected'
        : !member.sharing ? 'private'
          : failedUsers.has(member.userId) ? 'error' : 'ready',
    }));
    return {
      householdId: household.householdId,
      timeMin,
      timeMax,
      status: failedUsers.size > 0 ? 'partial' : 'ok',
      members,
      events: [...grouped.values()].sort((left, right) => left.start.localeCompare(right.start)),
    };
  }
}
