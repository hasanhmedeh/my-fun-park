// The park's environment alone (the harness's own check, and a backdrop reference).
import type { PreviewScene } from '../main';

const scene: PreviewScene = (p) => {
  p.view({ x: 0, y: 40, z: 160 }, { x: 0, y: 0, z: 0 });
};
export default scene;
