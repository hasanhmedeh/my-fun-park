import * as THREE from 'three';
import { shadowed, staticBox, staticCylinder, std, type Attraction, type Ctx } from '../context';
import { LAYOUT } from '../layout';
import { textMesh } from '../letters';
import type { PersonRig } from '../crowd/person-rig';
import { Wardrobe } from '../souvenirs';
import { hdr, PALETTE, signMaterial, signTexture, stripeTexture } from '../textures';

/** Decorative merry-go-round in the central plaza. */
export class Carousel implements Attraction {
  private spin = new THREE.Group();
  private horses: THREE.Group[] = [];

  constructor(ctx: Ctx) {
    const root = new THREE.Group();
    root.position.set(LAYOUT.carousel.x, 0, LAYOUT.carousel.z);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(7, 7.3, 0.7, 40), std(PALETTE.cream));
    base.position.y = 0.35;
    root.add(base);

    const deck = new THREE.Mesh(new THREE.CylinderGeometry(6.6, 6.6, 0.15, 40), std('#b98a5a'));
    deck.position.y = 0.78;
    this.spin.add(deck);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 6, 20), std('#ffffff', { map: stripeTexture(PALETTE.candy, PALETTE.cream, 10, true) }));
    pole.position.y = 3.8;
    this.spin.add(pole);
    const canopyTex = stripeTexture(PALETTE.candy, PALETTE.cream, 16);
    const canopy = new THREE.Mesh(new THREE.ConeGeometry(7.6, 3, 32), std('#ffffff', { map: canopyTex }));
    canopy.position.y = 8.2;
    this.spin.add(canopy);
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(7.6, 7.6, 0.9, 32, 1, true), std(PALETTE.mustard, { side: THREE.DoubleSide }));
    skirt.position.y = 6.3;
    this.spin.add(skirt);
    // a ring of warm bulbs around the skirt: the classic carousel glow
    const ringN = 48;
    const ring = new THREE.InstancedMesh(new THREE.SphereGeometry(0.11, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }), ringN);
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * Math.PI * 2;
      ring.setMatrixAt(i, new THREE.Matrix4().makeTranslation(Math.cos(a) * 7.68, 6.3, Math.sin(a) * 7.68));
      ring.setColorAt(i, hdr(i % 3 ? '#ffe2a0' : '#ff7a90', 6));
    }
    this.spin.add(ring);
    const topper = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 12), std('#ffcf5a', { metalness: 1, roughness: 0.2 }));
    topper.position.y = 10;
    this.spin.add(topper);

    const horseColors = [PALETTE.cream, PALETTE.teal, PALETTE.violet, PALETTE.mustard];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = 5;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 5.2), std('#d9d4e6', { metalness: 0.9, roughness: 0.2 }));
      rod.position.set(Math.cos(a) * r, 3.4, Math.sin(a) * r);
      this.spin.add(rod);
      const horse = new THREE.Group();
      const mat = std(horseColors[i % horseColors.length], { roughness: 0.4 });
      const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 1.1, 4, 10), mat);
      body.rotation.z = Math.PI / 2;
      const neck = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.6, 4, 8), mat);
      neck.position.set(0.7, 0.45, 0);
      neck.rotation.z = -0.6;
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.3, 0.3), mat);
      head.position.set(1.05, 0.8, 0);
      const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.6), std(PALETTE.candy));
      saddle.position.y = 0.38;
      horse.add(body, neck, head, saddle);
      for (const lx of [-0.45, 0.45])
        for (const lz of [-0.18, 0.18]) {
          const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.06, 0.7), mat);
          leg.position.set(lx, -0.5, lz);
          leg.rotation.z = lx > 0 ? -0.5 : 0.5;
          horse.add(leg);
        }
      horse.position.set(Math.cos(a) * r, 2.2, Math.sin(a) * r);
      horse.rotation.y = -a + Math.PI; // face along the direction of travel
      this.spin.add(horse);
      this.horses.push(horse);
    }
    root.add(this.spin);
    shadowed(root, true);
    ctx.scene.add(root);
    staticCylinder(ctx, LAYOUT.carousel.x, LAYOUT.carousel.z, 7.3, 2);
  }

  update(_dt: number, t: number) {
    this.spin.rotation.y = t * 0.35;
    this.horses.forEach((h, i) => (h.position.y = 2.2 + Math.sin(t * 2.2 + i * 1.3) * 0.45));
  }
}

/**
 * Where the vendor stands inside the kiosk, and where a customer stands at its counter (world). The
 * vendor stands a little left of the middle: one of the entrance plaza's garland poles comes down
 * through the kiosk just right of it, and from the shop's camera (Shop.shot) it hid her face.
 */
export const BOOTH_VENDOR = { x: LAYOUT.booth.x - 0.45, z: LAYOUT.booth.z + 0.5 };
export const BOOTH_COUNTER = { x: LAYOUT.booth.x, z: LAYOUT.booth.z + 2.75 };

/**
 * The Ticket Booth: an open kiosk with a serving window over the counter, shelves of treats inside
 * and balloons tied at the corner. The vendor (Rosa, see shop.ts) stands behind the counter once the
 * people are loaded (setVendor). Its window faces south, towards the booth's ring.
 */
export class Booth implements Attraction {
  private ticket: THREE.Mesh;
  private vendor: PersonRig | null = null;
  private vendorWardrobe: Wardrobe | null = null;
  private balloons: THREE.Group[] = [];
  readonly root = new THREE.Group();

  constructor(private ctx: Ctx) {
    const root = this.root;
    root.position.set(LAYOUT.booth.x, 0, LAYOUT.booth.z);
    const teal = std(PALETTE.teal);
    const inside = std('#fff1d6', { roughness: 0.9, emissive: '#ffb46b', emissiveIntensity: 0.18 });
    const wood = std('#b98a5a', { roughness: 0.8 });
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, m: THREE.Material) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      b.position.set(x, y, z);
      root.add(b);
      return b;
    };
    // the shell: back, sides, roof slab, and a front with a window from the counter (1.25 m) to 2.7 m
    box(4, 3, 0.12, 0, 1.5, -1.44, teal);
    box(0.12, 3, 3, -1.94, 1.5, 0, teal);
    box(0.12, 3, 3, 1.94, 1.5, 0, teal);
    box(4.1, 0.14, 3.1, 0, 3.05, 0, teal);
    box(4, 1.25, 0.12, 0, 0.625, 1.44, teal);
    box(4, 0.3, 0.12, 0, 2.85, 1.44, teal);
    for (const x of [-1.84, 1.84]) box(0.32, 1.45, 0.12, x, 1.975, 1.44, teal);
    // a warm lit interior: floor, back wall and ceiling in cream that glows a little
    box(3.76, 0.04, 2.76, 0, 0.02, 0, inside);
    box(3.76, 2.9, 0.02, 0, 1.5, -1.37, inside);
    box(3.76, 0.02, 2.76, 0, 2.97, 0, inside);
    // the counter, out over the front wall
    const counter = box(4.3, 0.1, 0.75, 0, 1.3, 1.55, std(PALETTE.cream, { roughness: 0.6 }));
    counter.name = 'counter';
    // shelves of treats behind the vendor: popcorn boxes, cotton candy, soda cups, candy apples
    for (const y of [1.25, 1.85]) box(3.4, 0.05, 0.36, 0, y, -1.18, wood);
    this.stockShelves(root);
    // a small till on the counter
    box(0.42, 0.22, 0.32, 1.35, 1.46, 1.45, std('#3a2f4a', { roughness: 0.4, metalness: 0.5 }));

    const roof = new THREE.Mesh(new THREE.ConeGeometry(3.4, 2, 4), std('#ffffff', { map: stripeTexture(PALETTE.candy, PALETTE.cream, 8) }));
    roof.rotation.y = Math.PI / 4;
    roof.position.y = 4.1;
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 1.5), signMaterial(signTexture('TICKETS', { sub: 'Tickets · Treats · Souvenirs', border: PALETTE.candy })));
    sign.position.set(0, 3.65, 1.75);
    sign.rotation.x = -0.2;
    // giant spinning ticket
    this.ticket = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.2, 0.08),
      signMaterial(signTexture('ADMIT ONE', { border: PALETTE.mustard, width: 768, height: 384, bulbs: false }), { emissiveIntensity: 1.2, metalness: 0.3, roughness: 0.3 }),
    );
    this.ticket.position.y = 6.3;
    root.add(roof, sign, this.ticket);
    // balloons for sale, tied to the front corner
    this.tieBalloons(root);
    shadowed(root, true);
    // the roof mustn't plunge the window into shade: the vendor has to be seen
    roof.castShadow = false;
    ctx.scene.add(root);
    staticBox(ctx, LAYOUT.booth.x, 1.5, LAYOUT.booth.z, 2.2, 1.5, 1.8);
  }

  /** The vendor behind the counter, facing the window. */
  setVendor(rig: PersonRig) {
    this.vendor = rig;
    rig.root.position.set(BOOTH_VENDOR.x - LAYOUT.booth.x, 0, BOOTH_VENDOR.z - LAYOUT.booth.z);
    // the rig faces -z; the window is at +z
    rig.root.rotation.y = Math.PI;
    rig.setShadows(true);
    rig.setDetail(true);
    // a little light of her own: the kiosk's warm interior lamp
    rig.setGlow(0.22);
    this.root.add(rig.root);
    this.vendorWardrobe = new Wardrobe(rig, this.ctx.scene);
    this.vendorWardrobe.set(['cap']);
  }

  get vendorRig() {
    return this.vendor;
  }

  update(dt: number, t: number) {
    this.ticket.rotation.y = t * 1.2;
    this.ticket.position.y = 6.3 + Math.sin(t * 2) * 0.2;
    this.balloons.forEach((b, i) => {
      b.rotation.z = Math.sin(t * 1.3 + i * 1.7) * 0.07;
      b.rotation.x = Math.cos(t * 1.1 + i) * 0.05;
    });
    if (this.vendor) {
      this.vendor.update(dt, 0);
      this.vendorWardrobe?.update(dt);
    }
  }

  private stockShelves(root: THREE.Group) {
    const popcorn = std('#ffffff', { map: stripeTexture(PALETTE.candy, PALETTE.cream, 6) });
    const kernels = std('#ffe7a3', { roughness: 0.95 });
    const candy = std('#ff9ec7', { roughness: 1 });
    const cone = std(PALETTE.cream, { roughness: 0.8 });
    const cup = std(PALETTE.teal, { roughness: 0.5 });
    const apple = std('#c4161c', { roughness: 0.25, metalness: 0.1 });
    for (let i = 0; i < 6; i++) {
      const x = -1.45 + i * 0.58;
      // lower shelf: popcorn boxes and soda cups
      const lower = new THREE.Group();
      if (i % 2 === 0) {
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.08, 0.24, 12), popcorn);
        b.position.y = 0.12;
        const top = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), kernels);
        top.position.y = 0.24;
        lower.add(b, top);
      } else {
        const c = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.055, 0.2, 12), cup);
        c.position.y = 0.1;
        const straw = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.16), std(PALETTE.candy));
        straw.position.set(0.02, 0.24, 0);
        straw.rotation.z = 0.2;
        lower.add(c, straw);
      }
      lower.position.set(x, 1.275, -1.15);
      // upper shelf: cotton candy on cones and candy apples
      const upper = new THREE.Group();
      if (i % 2 === 0) {
        const fluff = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 10), candy);
        fluff.position.y = 0.3;
        fluff.scale.set(1, 1.15, 1);
        const stick = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.2, 8), cone);
        stick.rotation.x = Math.PI;
        stick.position.y = 0.12;
        upper.add(fluff, stick);
      } else {
        const a = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), apple);
        a.position.y = 0.08;
        const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14), wood());
        stick.position.y = 0.18;
        upper.add(a, stick);
      }
      upper.position.set(x, 1.875, -1.15);
      root.add(lower, upper);
    }
    function wood() {
      return std('#b98a5a', { roughness: 0.8 });
    }
  }

  private tieBalloons(root: THREE.Group) {
    const colors = ['#e8283c', PALETTE.mustard, PALETTE.teal, PALETTE.violet, PALETTE.candy];
    const anchor = new THREE.Vector3(2.15, 1.35, 1.75);
    colors.forEach((c, i) => {
      const g = new THREE.Group();
      g.position.copy(anchor);
      const a = (i / colors.length) * Math.PI * 2;
      const top = new THREE.Vector3(Math.cos(a) * 0.35, 1.5 + (i % 2) * 0.35, Math.sin(a) * 0.3);
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(0.22, 18, 14),
        new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.08 }),
      );
      ball.scale.y = 1.16;
      ball.position.copy(top);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), top.clone().setY(top.y - 0.26)]),
        new THREE.LineBasicMaterial({ color: '#f4efe6' }),
      );
      g.add(ball, line);
      root.add(g);
      this.balloons.push(g);
    });
  }
}

/** Entrance arch with the fair's name in 3D letters. */
export class Arch implements Attraction {
  private bulbs: THREE.InstancedMesh;

  constructor(ctx: Ctx) {
    const root = new THREE.Group();
    root.position.set(LAYOUT.arch.x, 0, LAYOUT.arch.z);
    const towerMat = std('#ffffff', { map: stripeTexture(PALETTE.candy, PALETTE.cream, 6, true) });
    for (const x of [-8, 8]) {
      const tower = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 9, 16), towerMat);
      tower.position.set(x, 4.5, 0);
      const cap = new THREE.Mesh(new THREE.ConeGeometry(1.4, 2.2, 16), std(PALETTE.mustard));
      cap.position.set(x, 10.1, 0);
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8), std(PALETTE.candy));
      ball.position.set(x, 11.4, 0);
      root.add(tower, cap, ball);
      staticCylinder(ctx, LAYOUT.arch.x + x, LAYOUT.arch.z, 1.1, 9);
    }
    // arched beam
    const curve = new THREE.QuadraticBezierCurve3(new THREE.Vector3(-8, 8, 0), new THREE.Vector3(0, 11.5, 0), new THREE.Vector3(8, 8, 0));
    const beam = new THREE.Mesh(new THREE.TubeGeometry(curve, 40, 0.45, 10, false), std(PALETTE.violet));
    root.add(beam);
    const pts = curve.getSpacedPoints(30);
    this.bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshBasicMaterial({ color: '#ffffff' }), pts.length);
    pts.forEach((p, i) => {
      this.bulbs.setMatrixAt(i, new THREE.Matrix4().makeTranslation(p.x, p.y - 0.55, p.z + 0.3));
      this.bulbs.setColorAt(i, hdr(i % 2 ? '#ffd23d' : '#ff5d7a', 6));
    });
    root.add(this.bulbs);

    const title = textMesh('THE FUNFAIR', 1.15, 0.35, std('#ffcf5a', { roughness: 0.22, metalness: 1 })); // gilded marquee lettering
    title.position.set(0, 7.6, 0.2);
    root.add(title);
    const sub = new THREE.Mesh(
      new THREE.PlaneGeometry(9, 1.3),
      signMaterial(signTexture('RIDES · GAMES · THRILLS · PRIZES', { border: PALETTE.violet, height: 160, width: 1100, bulbs: false })),
    );
    sub.position.set(0, 6.1, 0.3);
    root.add(sub);

    shadowed(root);
    this.bulbs.castShadow = false;
    ctx.scene.add(root);
  }

  update(_dt: number, t: number) {
    const on = Math.floor(t * 4) % 2;
    (this.bulbs.material as THREE.MeshBasicMaterial).color.setScalar(on ? 1 : 0.75);
  }
}

