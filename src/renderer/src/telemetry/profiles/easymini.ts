import type { EventProfile } from './types';

// AltOS EasyMini flight states.
export const EASYMINI_STATE_NAMES: Record<number, string> = {
  3: 'boost',
  5: 'coast',
  6: 'drogue',
  7: 'main',
  8: 'landed'
};

export const easyMiniProfile: EventProfile = {
  state: {
    stateColumn: 'state',
    stateNames: EASYMINI_STATE_NAMES,
    isLaunchTransition: (_previousState, currentState) => currentState === 5,
    isEndTransition: (_previousState, currentState) => currentState === 8
  }
};
