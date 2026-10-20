// Palm Cay's landmass alone: the sand rim, the jungle and its palms, the two hills, the reef and the
// lagoon (the island builder's park and airport aren't in this scene; see flight-view.ts for the
// parameters).
//
//   ?scene=island-terrain&cam=0,300,42700&look=0,0,41300          from the south over the reef
//   ?scene=island-terrain&cam=1900,120,41700&look=1250,20,41150   the east hill from the sea
//   ?scene=island-terrain&cam=0,1.7,41545&look=0,0,42000          on the south beach, the lagoon ahead
import type { PreviewScene } from '../main';
import { geography } from './flight-view';

const scene: PreviewScene = (p) => {
  p.view({ x: 0, y: 300, z: 42700 }, { x: 0, y: 0, z: 41300 });
  geography(p);
};
export default scene;
