import type { EventProfile } from './types';

// stm32-avionics StateId_e (common/system/scheduler.h)
export const FCB_STATE_NAMES: Record<number, string> = {
  0: 'CliEraseFlash',
  1: 'CliOffload',
  2: 'Ascent',
  3: 'Descent',
  4: 'Initialize',
  5: 'PostFlight',
  6: 'PreFlight',
  7: 'SimTempState'
};

const FCB_LAUNCH_STATE = 2; // Ascent
const FCB_END_STATE = 5; // PostFlight

const fcbStateConfig = {
  stateColumn: 'state',
  stateNames: FCB_STATE_NAMES,
  isLaunchTransition: (_previousState: number, currentState: number) => currentState === FCB_LAUNCH_STATE,
  isEndTransition: (_previousState: number, currentState: number) => currentState === FCB_END_STATE
};

// On-board FCB log: state column is trustworthy.
export const fcbProfile: EventProfile = {
  state: fcbStateConfig
};

// Ground-station relayed telemetry: same state codes, but transitions are
// noisy (dropped/garbled packets produce spurious PostFlight), so the raw
// states are only trusted when auto-detect is off.
export const fcbGroundStationProfile: EventProfile = {
  state: fcbStateConfig,
  unreliableStates: true
};
