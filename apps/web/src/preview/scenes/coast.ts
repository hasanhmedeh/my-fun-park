// The home coast: the beach, the surf and the sea south of the airport, and the coast road and
// villages along it (see flight-view.ts for the parameters).
//
//   ?scene=coast&cam=300,1.7,1255&look=300,0,1700          on the beach at eye height, looking out to sea
//   ?scene=coast&cam=-600,40,1000&look=200,0,1250          over the dunes
//   ?scene=coast&cam=16000,250,2200&look=16600,0,820       a coastal village from the air
import type { PreviewScene } from '../main';
import { geography } from './flight-view';

const scene: PreviewScene = (p) => {
  p.view({ x: 300, y: 1.7, z: 1255 }, { x: 300, y: 0, z: 1700 });
  geography(p);
};
export default scene;
