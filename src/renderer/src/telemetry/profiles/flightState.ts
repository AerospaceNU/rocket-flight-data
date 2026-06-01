import type { EventProfile } from './types';

// Generic "flightState" column (e.g. SillyGoose firmware).
export const FLIGHT_STATE_NAMES: Record<number, string> = {
  0: 'PRE_FLIGHT',
  1: 'ASCENT',
  2: 'DESCENT',
  3: 'POST_FLIGHT'
};

export const flightStateProfile: EventProfile = {
  state: {
    stateColumn: 'flightState',
    stateNames: FLIGHT_STATE_NAMES,
    isLaunchTransition: (previousState, currentState) => previousState === 0 && currentState !== 0,
    isEndTransition: (_previousState, currentState) => currentState === 3
  }
};
