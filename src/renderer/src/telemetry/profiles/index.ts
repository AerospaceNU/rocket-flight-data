import { easyMiniProfile } from './easymini';
import { fcbGroundStationProfile, fcbProfile } from './fcb';
import { flightStateProfile } from './flightState';
import type { EventProfile } from './types';

export type { EventProfile, StateEventProfile } from './types';
export { FLIGHT_STATE_NAMES } from './flightState';
export { EASYMINI_STATE_NAMES } from './easymini';
export { FCB_STATE_NAMES } from './fcb';

// Maps importer_id -> event profile. Importers without an entry have no state
// column and produce only altitude/attribute-derived events.
const EVENT_PROFILES: Record<string, EventProfile> = {
  fcb: fcbProfile,
  fcbgroundstation: fcbGroundStationProfile,
  easymini: easyMiniProfile,
  sillygoose: flightStateProfile
};

export function getEventProfile(importerId: string): EventProfile | null {
  return EVENT_PROFILES[importerId] ?? null;
}
