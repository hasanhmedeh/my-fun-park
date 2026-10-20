// Palm Cay's airfield (world/airport/airfield.ts) on the island, with the same staging and
// parameters as the airfield-home scene.
//
//   ?scene=airfield-island&cam=11600,290,40300&look=1400,0,40300&far=60000&near=2   on final for 27, 5 NM out
import type { PreviewScene } from '../main';
import { stage } from './airfield-home';

const preview: PreviewScene = (p) => {
  stage(p, 'island');
  p.view({ x: 2600, y: 220, z: 39900 }, { x: 0, y: 0, z: 40400 });
};
export default preview;
