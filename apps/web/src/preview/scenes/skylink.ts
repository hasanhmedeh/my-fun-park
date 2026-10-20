// The SkyLink (world/airport/skylink.ts) with the forecourt and the terminal at its airport end and
// the fair at its park end.
//
//   ?scene=skylink&cam=60,30,40&look=22,8,120             the park station and the guideway heading south
//   ?scene=skylink&cam=22,1.7,62&look=22,3,75             inside the park station's hall
//   ?scene=skylink&cam=-30,40,330&look=22,8,240           the guideway over the trail and the road
//   ?scene=skylink&t=40                                   run the trains on 40 s first
//   ?scene=skylink&ride=park&rideT=30&rider=1             start a ride, run it 30 s, look from the rider's eyes
//   ?scene=skylink&ride=park&check=1                      run a whole ride and print its timeline (console)
import * as THREE from 'three';
import type { PreviewScene } from '../main';
import { HomeTerminal } from '../../world/airport/terminal';
import { Landside } from '../../world/airport/landside';
import { SkyLink, type SkyLinkPose } from '../../world/airport/skylink';
import { homeStage } from './terminal';

const preview: PreviewScene = (p) => {
  homeStage(p);
  const { scene, camera } = p.ctx;
  const link = new SkyLink(p.ctx);
  const land = new Landside(p.ctx);
  const term = new HomeTerminal(p.ctx);
  scene.add(link.group, land.group, term.group);
  const step = (dt: number) => {
    link.update(dt, 0, camera);
    land.update(dt, 0, camera);
  };
  const ff = Number(p.params.get('t') ?? 0);
  for (let t = 0; t < ff; t += 0.1) step(0.1);

  const from = p.params.get('ride') as 'park' | 'airport' | null;
  let pose: SkyLinkPose | null = null;
  let ride: ReturnType<SkyLink['ride']> | null = null;
  if (from) {
    ride = link.ride(from);
    if (p.params.get('check')) {
      // the whole trip, its phases and timings, and that it ends where it should
      let last = '';
      let t = 0;
      const lines: string[] = [];
      for (; t < 400; t += 0.05) {
        step(0.05);
        pose = ride.update(0.05);
        if (pose.phase !== last) {
          lines.push(`${t.toFixed(1)}s ${pose.phase} at ${pose.pos.toArray().map((v) => v.toFixed(1)).join(',')}`);
          last = pose.phase;
        }
        if (pose.done) break;
      }
      lines.push(`done=${pose?.done} after ${t.toFixed(1)}s, piers ${link.piers.map((z) => z.toFixed(0)).join(' ')}`);
      console.warn(lines.join('\n'));
    } else {
      const rt = Number(p.params.get('rideT') ?? 20);
      for (let t = 0; t < rt; t += 0.05) {
        step(0.05);
        pose = ride.update(0.05);
      }
    }
  }
  const eye = new THREE.Vector3();
  const look = new THREE.Vector3();
  const rider = () => {
    if (!pose) return;
    eye.set(pose.pos.x, pose.pos.y + 1.65, pose.pos.z);
    look.set(eye.x - Math.sin(pose.yaw) * 10, eye.y - 0.4, eye.z - Math.cos(pose.yaw) * 10);
    p.view(eye, look);
  };
  p.onFrame((dt, t) => {
    const n = p.env?.night ?? 0;
    link.setNight(n);
    land.setNight(n);
    term.setNight(n);
    link.update(dt, t, camera);
    land.update(dt, t, camera);
    term.update(dt, t, camera);
    if (ride) {
      pose = ride.update(dt);
      if (p.params.get('rider')) rider();
    }
  });
  p.view({ x: 60, y: 30, z: 40 }, { x: 22, y: 8, z: 120 });
  if (p.params.get('rider')) rider();
};
export default preview;
