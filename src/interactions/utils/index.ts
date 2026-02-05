export {
  EMPTY_MODIFIERS,
  extractModifiers,
  hasSelection,
  getSelectionOrigin,
  getSelectionOriginFromRoomState,
  type SelectionOriginConfig,
} from './interactionUtils';

export {
  applyGridSnap,
  applyAxisConstraint,
  type GridSnapConfig,
  type GridSnapResult,
} from './snapHelpers';

export {
  isAxisLockKey,
  getAxisFromKey,
  handleAxisLockKey,
  type AxisLockHandlerConfig,
} from './axisLockHelpers';
