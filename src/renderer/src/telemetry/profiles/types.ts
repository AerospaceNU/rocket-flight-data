/*
 * Per-altimeter event profiles.
 *
 * Each altimeter family reports flight phase differently (different state
 * column, different numeric codes, different launch/end semantics). A profile
 * captures that altimeter-specific knowledge so the generic event-marker
 * builder in events.ts stays free of per-altimeter branching. Adding a new
 * altimeter = add a profile module and register it in profiles/index.ts.
 */

export type StateEventProfile = {
  /** Header name of the integer flight-state column this altimeter writes. */
  stateColumn: string;
  /** Human-readable name for each known state code (used for event labels). */
  stateNames: Record<number, string>;
  /** True when a transition prev -> cur marks liftoff (first match wins). */
  isLaunchTransition: (previousState: number, currentState: number) => boolean;
  /** True when a transition prev -> cur marks the end of flight (last match wins). */
  isEndTransition: (previousState: number, currentState: number) => boolean;
};

export type EventProfile = {
  /** State-machine config, or undefined for altimeters with no state column. */
  state?: StateEventProfile;
  /**
   * When true the raw state column is considered unreliable: it is only used
   * when auto-detect is OFF. With auto-detect ON the builder ignores it and
   * relies on altitude-based launch/end estimation instead.
   */
  unreliableStates?: boolean;
};
