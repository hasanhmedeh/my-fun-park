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
  closed: boolean;
  /** Switched off (an empty plot in Creators' Valley): no ring, no label, no prompt. */
  off: boolean;
  /** Built the first time the attraction closes. */
  site: MaintenanceSite | null;
}

/** Glowing ground rings: step onto one to get the "Press E" prompt. */
export class Zones {
  private markers: Marker[] = [];
  active: ZoneId | null = null;

  constructor(private ctx: Ctx) {
    for (const [id, z] of Object.entries(ZONES) as [ZoneId, (typeof ZONES)[ZoneId]][]) {
      if (!z.radius) continue;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(z.radius - 0.35, z.radius, 48),
        new THREE.MeshBasicMaterial({ color: hdr(PALETTE.mustard, 2.4), transparent: true, opacity: 0.95 }),
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(z.x, 0.04, z.z);
      const fill = new THREE.Mesh(
        new THREE.CircleGeometry(z.radius - 0.35, 48),
        new THREE.MeshBasicMaterial({ color: PALETTE.mustard, transparent: true, opacity: 0.12, depthWrite: false }),
      );
      fill.rotation.x = -Math.PI / 2;
      fill.position.set(z.x, 0.03, z.z);
      const label = makeSprite(floatingTextTexture(z.title, z.action), 7);
      label.position.set(z.x, 3.4, z.z);
      ctx.scene.add(ring, fill, label);
      this.markers.push({ id, ring, fill, label, baseY: 3.4, closed: false, off: false, site: null });
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
      if (m.site) m.site.group.visible = now && !m.off;
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
    m.ring.visible = m.fill.visible = m.label.visible = on;
    if (m.site) m.site.group.visible = on && m.closed;
    const z = ZONES[id];
    const mat = m.label.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.map = floatingTextTexture(z.title, m.closed ? '🚧 Under maintenance' : z.action);
    mat.needsUpdate = true;
    if (!on && this.active === id) this.active = null;
  }

  setVisible(v: boolean) {
    for (const m of this.markers) m.label.visible = v && !m.off;
  }

  update(carPos: THREE.Vector3, t: number) {
    let found: ZoneId | null = null;
    for (const m of this.markers) {
      if (m.off) continue;
      const z = ZONES[m.id];
      const inside = Math.hypot(carPos.x - z.x, carPos.z - z.z) < z.radius;
      if (inside) found = m.id;
      const k = inside ? 1 : 0;
      (m.fill.material as THREE.MeshBasicMaterial).opacity = THREE.MathUtils.lerp((m.fill.material as THREE.MeshBasicMaterial).opacity, 0.12 + k * 0.3, 0.15);
      m.ring.scale.setScalar(1 + Math.sin(t * 3 + z.x) * 0.03 + k * 0.05);
      m.label.position.y = m.baseY + Math.sin(t * 2 + z.z) * 0.15;
      // fade labels that are far away so the scene stays readable
      const d = Math.hypot(carPos.x - z.x, carPos.z - z.z);
      (m.label.material as THREE.SpriteMaterial).opacity = THREE.MathUtils.clamp(1.4 - d / 45, 0.25, 1);
      if (m.closed && d < 120) m.site?.update(t);
    }
    this.active = found;
    return found;
  }
}
