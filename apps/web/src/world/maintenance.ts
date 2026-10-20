import * as THREE from 'three';
import { shadowed, std } from './context';
import { ZONES, type ZoneId } from './layout';
import { glowTexture, hdr, PALETTE, signMaterial, signTexture, stripeTexture } from './textures';

const AMBER = '#ffb02e';

// shared by every site: there are at most a dozen, and most of the time none
let parts: ReturnType<typeof makeParts> | null = null;
function makeParts() {
  const stripes = stripeTexture(PALETTE.candy, PALETTE.cream, 8);
  stripes.repeat.set(1.5, 1);
  return {
    leg: new THREE.BoxGeometry(0.08, 1.3, 0.08),
    plank: new THREE.BoxGeometry(2.6, 0.26, 0.05),
    board: new THREE.PlaneGeometry(2.1, 0.79),
    lamp: new THREE.SphereGeometry(0.11, 12, 8),
    lampBase: new THREE.CylinderGeometry(0.07, 0.09, 0.08, 10),
    cone: new THREE.ConeGeometry(0.2, 0.62, 14, 1, true),
    band: new THREE.CylinderGeometry(0.088, 0.127, 0.12, 14, 1, true), // hugs the cone between y 0.30 and 0.42
    coneBase: new THREE.BoxGeometry(0.44, 0.05, 0.44),
    plankMat: std('#ffffff', { map: stripes }),
    legMat: std(PALETTE.ink, { roughness: 0.6, metalness: 0.4 }),
    boardMat: signMaterial(signTexture('CLOSED', { sub: '🚧 Under maintenance', border: AMBER, bulbs: false }), { emissiveIntensity: 1.6 }),
    coneMat: std(PALETTE.orange, { roughness: 0.55, side: THREE.DoubleSide }),
    bandMat: std(PALETTE.cream, { roughness: 0.4, side: THREE.DoubleSide }),
    glow: glowTexture(AMBER),
  };
}

/**
 * Roadworks across an attraction closed for maintenance: a striped barricade with a CLOSED board
 * and two flashing beacons at the far side of its ring, facing whoever steps in, and traffic cones
 * round the edge. No colliders: staff still walk in to test it, and players get the sign anyway.
 */
export class MaintenanceSite {
  readonly group = new THREE.Group();
  private lamps: { mat: THREE.MeshBasicMaterial; glow: THREE.Sprite }[] = [];

  constructor(id: ZoneId) {
    const p = (parts ??= makeParts());
    const z = ZONES[id];
    const fx = -Math.sin(z.heading);
    const fz = -Math.cos(z.heading);
    // on the ring's floor (a terminal's tiles stand a little above the ground)
    this.group.position.y = z.y ?? 0;

    // the barricade, near the far edge of the ring; its front (+z) faces back at the visitor
    const barricade = new THREE.Group();
    barricade.position.set(z.x + fx * (z.radius - 0.7), 0, z.z + fz * (z.radius - 0.7));
    barricade.rotation.y = z.heading;
    for (const side of [-1, 1]) {
      for (const lean of [-1, 1]) {
        const leg = new THREE.Mesh(p.leg, p.legMat);
        leg.position.set(side * 1.1, 0.62, lean * 0.18);
        leg.rotation.x = lean * 0.28;
        barricade.add(leg);
      }
    }
    for (const y of [1.08, 0.62]) {
      const plank = new THREE.Mesh(p.plank, p.plankMat);
      plank.position.y = y;
      barricade.add(plank);
    }
    // the board, readable from both sides
    for (const back of [false, true]) {
      const board = new THREE.Mesh(p.board, p.boardMat);
      board.position.set(0, 1.68, back ? -0.03 : 0.03);
      if (back) board.rotation.y = Math.PI;
      barricade.add(board);
    }
    for (const side of [-1, 1]) {
      const base = new THREE.Mesh(p.lampBase, p.legMat);
      base.position.set(side * 1.1, 1.25, 0);
      const mat = new THREE.MeshBasicMaterial({ color: hdr(AMBER, 3) });
      const lamp = new THREE.Mesh(p.lamp, mat);
      lamp.position.set(side * 1.1, 1.36, 0);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: p.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      glow.position.copy(lamp.position);
      barricade.add(base, lamp, glow);
      this.lamps.push({ mat, glow });
    }
    this.group.add(shadowed(barricade));

    // cones round the ring, leaving the side the visitor walks in from clear
    for (const a of [-1.15, -0.55, 0.55, 1.15, -2.0, 2.0]) {
      const ang = Math.atan2(fx, fz) + a;
      const r = z.radius + 0.1;
      const cone = new THREE.Group();
      cone.position.set(z.x + Math.sin(ang) * r, 0, z.z + Math.cos(ang) * r);
      const body = new THREE.Mesh(p.cone, p.coneMat);
      body.position.y = 0.36;
      const band = new THREE.Mesh(p.band, p.bandMat);
      band.position.y = 0.36;
      const base = new THREE.Mesh(p.coneBase, p.coneMat);
      base.position.y = 0.025;
      base.rotation.y = ang;
      cone.add(body, band, base);
      this.group.add(shadowed(cone));
    }
    this.group.visible = false;
  }

  /** The beacons flash in turn. */
  update(t: number) {
    this.lamps.forEach(({ mat, glow }, i) => {
      const on = Math.max(0, Math.sin(t * 6 + i * Math.PI)) ** 0.6;
      mat.color.copy(hdr(AMBER, 0.6 + on * 3.4));
      glow.scale.setScalar(0.4 + on * 1.4);
      glow.material.opacity = on;
    });
  }
}
