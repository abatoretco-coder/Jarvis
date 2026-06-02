#!/usr/bin/env sh
set -eu

f="/opt/naas/stacks/Jarvis/.env"
v="abatoretco@gmail.com,family10771944489655853150@group.calendar.google.com,a40aae65f3ce47e21be3428716626691685228972d5ea1a07a65abd42c78b5d6@group.calendar.google.com,kgdkom6eoo0fvtv408c0a6lakg@group.calendar.google.com"

if grep -q '^GOOGLE_CALENDAR_CALENDAR_IDS=' "$f"; then
  sed -i "s|^GOOGLE_CALENDAR_CALENDAR_IDS=.*|GOOGLE_CALENDAR_CALENDAR_IDS=${v}|" "$f"
else
  printf '\nGOOGLE_CALENDAR_CALENDAR_IDS=%s\n' "$v" >> "$f"
fi

grep '^GOOGLE_CALENDAR_CALENDAR_IDS=' "$f"
