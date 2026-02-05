import type { SnapController } from '../controllers/SnapController';

export interface GridSnapConfig {
  snapController: SnapController;
  getGridSnapEnabled: () => boolean;
  getGridSize: () => number;
}

