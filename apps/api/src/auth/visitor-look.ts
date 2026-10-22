// The visitor's look, made in the game's customiser: which person they play (a playable avatar from
// the game's people manifest), their outfit's colours, their hair tint, height and build. Members
// keep it on their account (users.visitor_look) so it follows them to any browser.
//
// This mirrors VisitorLook and VISITOR_LOOK_LIMITS in apps/web/src/world/crowd/people-manifest.ts,
// which the API can't import: change both together.

/** What the game's customiser can make. Height and build are [min, max] scales on the avatar's own. */
export const VISITOR_LOOK_LIMITS = {
  height: [0.92, 1.08],
  build: [0.94, 1.06],
  avatarId: /^[A-Za-z0-9_]{1,48}$/,
  colour: /^#[0-9a-f]{6}$/,
} as const;

export interface VisitorLook {
  v: 1;
  /** A playable avatar's id in the game's people manifest, e.g. `Female_Adult_04`. */
  avatar: string;
  /** '#rrggbb' (lowercase) to recolour that part of the outfit, or null for its own colour. */
  top: string | null;
  bottom: string | null;
  shoes: string | null;
  /** '#rrggbb' hair tint, or null for the avatar's own. */
  hair: string | null;
  /** Scale on the avatar's own height. */
  height: number;
  /** Scale on its width. */
  build: number;
}

/** Just the look's own fields, in order: what gets stored (the request's object may carry a class prototype). */
export function toVisitorLook(look: VisitorLook): VisitorLook {
  const { avatar, top, bottom, shoes, hair, height, build } = look;
  return { v: 1, avatar, top, bottom, shoes, hair, height, build };
}
