import * as THREE from 'three';
import type { Ctx } from './context';
import { ZONES, type ZoneId } from './layout';
import { MaintenanceSite } from './maintenance';
import { floatingTextTexture, hdr, makeSprite, PALETTE } from './textures';

interface Marker {
  id: ZoneId;
  ring: THREE.Mesh;
  fill: THREE.Mesh;
  label: THREE.Sprite;
  baseY: number;
  /** Within reach of the visitor (see REACH): only these are drawn and animated. */
  near: boolean;
  closed: boolean;
  /** Switched off (an empty plot in Creators' Valley): no ring, no label, no prompt. */
  off: boolean;
  /** Built the first time the attraction closes. */
  site: MaintenanceSite | null;
}

/**
 * How far away a ring is still drawn and animated. The world has places 40 km apart (the airport,
 * Palm Cay): only those round the visitor are worth a draw call or a thought.
 */
const REACH = 600;

/** Glowing ground rings: step onto one to get the "Press E" prompt. */
export class Zones {
  private markers: Marker[] = [];
  /** The labels are hidden during a ride (setVisible). */
  private labels = true;
  /** A ring the camera stands over for a close-up (the changing room's, while dressing): not drawn. */
  private hidden: ZoneId | null = null;
  active: ZoneId | null = null;

  constructor(private ctx: Ctx) {
    for (const [id, z] of Object.entries(ZONES) as [ZoneId, (typeof ZONES)[ZoneId]][]) {
      if (!z.radius) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(z.radius - 0.35, z.radius, 48),
        new THREE.MeshBasicMaterial({ color: hdr(PALETTE.mustard, 2.4), transparent: true, opacity: 0.95 }),
      );
      ring.rotation.x = -Math.PI / 2;
      // on its floor: the ground, or a terminal's tiles a little above it
      const y = z.y ?? 0;
      ring.position.set(z.x, y + 0.04, z.z);
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(z.radius - 0.35, 48),
        new THREE.MeshBasicMaterial({ color: PALETTE.mustard, transparent: true, opacity: 0.12, depthWrite: false }),
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(z.x, y + 0.03, z.z);
      const label = makeSprite(floatingTextTexture(z.title, z.action), 7);
      label.position.set(z.x, y + 3.4, z.z);
      ring.visible = fill.visible = label.visible = false;
      ctx.scene.add(ring, fill, label);
      this.markers.push({ id, ring, fill, label, baseY: y + 3.4, near: false, closed: false, off: false, site: null });
    }
  }

  /** Attractions closed for maintenance get a red ring, an "Under maintenance" label, and roadworks (a barricade, beacons, cones). */
  setClosed(closed: ReadonlySet<ZoneId>) {
    for (const m of this.markers) {
      const now = closed.has(m.id);
      if (now === m.closed) continue;
      m.closed = now;
      const z = ZONES[m.id];
      const color = now ? PALETTE.candy : PALETTE.mustard;
      (m.ring.material as THREE.MeshBasicMaterial).color.copy(hdr(color, 2.4));
      (m.fill.material as THREE.MeshBasicMaterial).color.set(color);
      const mat = m.label.material as THREE.SpriteMaterial;
      mat.map?.dispose();
      mat.map = now ? floatingTextTexture(z.title, '🚧 Under maintenance') : floatingTextTexture(z.title, z.action);
      mat.needsUpdate = true;
      if (now && !m.site) this.ctx.scene.add((m.site = new MaintenanceSite(m.id)).group);
      if (m.site) m.site.group.visible = now && !m.off && m.near;
    }
  }

  /**
   * Switches a zone on or off (a plot in Creators' Valley, with or without a coaster), and draws
   * its label again from its title (a plot is named after its coaster).
   */
  setZone(id: ZoneId, on: boolean) {
    const m = this.markers.find((k) => k.id === id);
    if (!m) return;
    m.off = !on;
    this.show(m);
    const z = ZONES[id];
    const mat = m.label.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.map = floatingTextTexture(z.title, m.closed ? '🚧 Under maintenance' : z.action);
    mat.needsUpdate = true;
    if (!on && this.active === id) this.active = null;
  }

  setVisible(v: boolean) {
    this.labels = v;
    for (const m of this.markers) this.show(m);
  }

  /** Hides one zone's ring and label (`null`: none) while the camera looks across it at the visitor. */
  setHidden(id: ZoneId | null) {
    this.hidden = id;
    for (const m of this.markers) this.show(m);
  }

  /** Shows or hides a marker's ring, fill, label and roadworks: only near the visitor, and not when switched off. */
  private show(m: Marker) {
    const on = m.near && !m.off && m.id !== this.hidden;
    m.ring.visible = m.fill.visible = on;
    m.label.visible = on && this.labels;
    if (m.site) m.site.group.visible = on && m.closed;
  }

  /** `eye`: the camera, if a label it comes close to should fade away rather than fill the screen. */
  update(carPos: THREE.Vector3, t: number, eye?: THREE.Vector3) {
    let found: ZoneId | null = null;
    for (const m of this.markers) {
      const z = ZONES[m.id];
      // the far ones (another district of the airport, the other side of the sea) sleep
      const near = Math.abs(carPos.x - z.x) < REACH && Math.abs(carPos.z - z.z) < REACH;
      if (near !== m.near) {
        m.near = near;
        this.show(m);
      }
      if (m.off || !near) continue;
      const inside = Math.hypot(carPos.x - z.x, carPos.z - z.z) < z.radius;
      if (inside) found = m.id;
      const k = inside ? 1 : 0;
      (m.fill.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.lerp((m.fill.material as THREE.MeshBasicMaterial).opacity, 0.12 + k * 0.3, 0.15);
      m.ring.scale.setScalar(1 + Math.sin(t * 3 + z.x) * 0.03 + k * 0.05);
      m.label.position.y = m.baseY + Math.sin(t * 2 + z.z) * 0.15;
      // fade labels that are far away so the scene stays readable
      const d = Math.hypot(carPos.x - z.x, carPos.z - z.z);
      // (and those the camera passes close to, as it does a neighbour's behind the visitor: the
      // booth's, from the changing room's ring)
      const pass = eye ? THREE.MathUtils.smoothstep(m.label.position.distanceTo(eye), 3, 7) : 1;
      (m.label.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp(1.4 - d / 45, 0.25, 1) * pass;
      if (m.closed && d < 120) m.site?.update(t);
    }
    this.active = found;
    return found;
  }
}
