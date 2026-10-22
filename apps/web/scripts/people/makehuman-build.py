# Blender side of the MakeHuman people (run by makehuman.mjs, not by hand): makes one person with
# MPFB, poses them into the Rocketbox Biped's bind pose and exports a GLB that makehuman-post.mjs
# rebuilds onto the Biped skeleton.
#
#   blender --background --factory-startup --python makehuman-build.py -- <job.json>
#
# job.json: { id, gender 'm' | 'f', ageYears, macro {gender 0..1, muscle, weight, height, proportions,
# cupsize, firmness, race {african, asian, caucasian}}, skin, eyes, eyebrows, eyelashes, hair, clothes [],
# (absolute paths to .mhmat / .mhclo files), template (Biped JSON from makehuman-template.mjs),
# out (the .glb to write; a .json with the same name gets what the post step needs) }.
#
# Why the pose: Rocketbox clips are rotation-only and set every bone's local rotation outright, so a
# body plays them as Rocketbox people do only if its bones point the same way as the Biped's in the
# bind pose (bone lengths may differ). MakeHuman's game_engine rig has a bone for every Biped body
# bone (53 of them; the Biped's 27 face bones have no counterpart), so each one is turned, parent
# first, until it points along its Biped bone; elbows also take the Biped's bend plane, hands its
# palm. The head and feet keep their own orientation (face ahead, soles flat). That pose becomes
# the rest pose before export.

import bpy, bmesh, addon_utils, sys, json, math, os
from mathutils import Vector, Matrix
from mathutils.bvhtree import BVHTree

job = json.load(open(sys.argv[sys.argv.index('--') + 1], encoding='utf-8'))
tpl = {j['name']: j for j in json.load(open(job['template'], encoding='utf-8'))['joints']}

addon_utils.enable('bl_ext.user_default.mpfb', default_set=True)
from bl_ext.user_default.mpfb.services.humanservice import HumanService
from bl_ext.user_default.mpfb.services.targetservice import TargetService

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o)


def age_value(years):
    # MakeHuman's age slider: 0 → 1 year, 0.5 → 25, 1 → 90, linear on each side.
    return (years - 1) / 48 if years < 25 else 0.5 + (years - 25) / 130


macro = TargetService.get_default_macro_info_dict()
macro.update({k: v for k, v in job.get('macro', {}).items() if k != 'race'})
macro['race'].update(job.get('macro', {}).get('race', {}))
macro['gender'] = job.get('macro', {}).get('gender', 1.0 if job['gender'] == 'm' else 0.0)
macro['age'] = age_value(job['ageYears'])

basemesh = HumanService.create_human(macro_detail_dict=macro)
basemesh.name = job['id']
rig = HumanService.add_builtin_rig(basemesh, 'game_engine')
assert rig.matrix_world == Matrix.Identity(4), 'the rig should sit at the origin'

parts = [{'obj': basemesh, 'kind': 'skin', 'mhmat': job['skin'], 'mhclo': None}]
for kind in ('eyes', 'eyebrows', 'eyelashes', 'hair'):
    if job.get(kind):
        obj = HumanService.add_mhclo_asset(job[kind], basemesh, asset_type=kind, subdiv_levels=0, material_type='GAMEENGINE')
        parts.append({'obj': obj, 'kind': kind, 'mhclo': job[kind]})
for path in job.get('clothes', []):
    obj = HumanService.add_mhclo_asset(path, basemesh, asset_type='Clothes', subdiv_levels=0, material_type='GAMEENGINE')
    parts.append({'obj': obj, 'kind': 'clothes', 'mhclo': path})
HumanService.set_character_skin(job['skin'], basemesh, skin_type='GAMEENGINE', material_instances=False)


def mhclo_material(path):
    for line in open(path, encoding='utf-8', errors='replace'):
        if line.startswith('material '):
            return os.path.normpath(os.path.join(os.path.dirname(path), line.split(None, 1)[1].strip()))
    return None


for p in parts:
    if p['mhclo']:
        p['mhmat'] = job.get('eyesMaterial') if p['kind'] == 'eyes' and job.get('eyesMaterial') else mhclo_material(p['mhclo'])


def with_obj(obj, fn):
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
        fn()


# Bake the body's shape keys (MakeHuman's targets) and its masks (helper geometry, skin under clothes).
if basemesh.data.shape_keys:
    with_obj(basemesh, lambda: bpy.ops.object.shape_key_remove(all=True, apply_mix=True))
# A copy of the whole body, skin under the clothes included, for measuring the seat only: skirts
# hang below where someone sits and the skin under them is deleted (makehuman-post.mjs drops it).
seat = basemesh.copy()
seat.data = basemesh.data.copy()
seat.name = job['id'] + '.seat'
bpy.context.collection.objects.link(seat)
for m in list(seat.modifiers):
    if m.type == 'MASK' and m.name.startswith('Delete'):
        seat.modifiers.remove(m)
parts.append({'obj': seat, 'kind': 'seat', 'mhmat': job['skin'], 'mhclo': None})
for p in parts:
    for m in list(p['obj'].modifiers):
        if m.type in ('MASK', 'SUBSURF'):
            with_obj(p['obj'], lambda: bpy.ops.object.modifier_apply(modifier=m.name))


def hide_covered(obj, covers, reach, tuck=0.0):
    # MakeHuman only deletes the skin a garment's author marked, so some pokes through (more so
    # once the body and the clothes are simplified apart), and two garments' edges cross where
    # they overlap (a sweater's hem and a skirt's waistband). Delete every face of `obj` whose
    # corners all have a covering garment within `reach` straight out (or a little way in, where
    # it already pokes through, or touching it); the faces at collars, cuffs and hems stay.
    # With `tuck`, the covered corners of those remaining faces are pulled that far inside the
    # cover, so a waistband's last ring sits under a hem instead of poking out through it.
    if not covers:
        return 0
    trees = []
    for o in covers:
        mw = o.matrix_world
        trees.append(BVHTree.FromPolygons([mw @ v.co for v in o.data.vertices], [list(f.vertices) for f in o.data.polygons]))
    mw = obj.matrix_world
    nm = mw.to_3x3()
    covered = set()
    for v in obj.data.vertices:
        n = (nm @ v.normal).normalized()
        p = mw @ v.co
        if any(t.ray_cast(p + n * 1e-4, n, reach)[0] is not None or t.ray_cast(p - n * 1e-4, -n, reach * 0.6)[0] is not None
               or t.find_nearest(p, 0.004)[0] is not None for t in trees):
            covered.add(v.index)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    gone = [f for f in bm.faces if all(v.index in covered for v in f.verts)]
    if tuck:
        inv = mw.inverted()
        dead = set(gone)
        for v in bm.verts:
            if v.index not in covered or all(f in dead for f in v.link_faces):
                continue
            n = outward(v, nm)
            if n is not None:
                v.co = inv @ (mw @ v.co - n * tuck)
    bmesh.ops.delete(bm, geom=gone, context='FACES_ONLY')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    bm.to_mesh(obj.data)
    bm.free()
    return len(gone)


def outward(v, nm):
    # a vertex's normal flattened to the ground: garments here only ever move sideways, so a
    # hem's rim (facing down) or a shoulder (facing up) never gets pulled into a spike
    n = (nm @ v.normal).normalized()
    n.z = 0
    return n.normalized() if n.length > 0.6 else None


def lift_over(obj, unders, reach, gap):
    # A top's hem is fitted to the bare body, so where a waistband or a seat bulges out past it the
    # hem dips inside and the bottom shows through it in teeth. Move each vertex of `obj` that has
    # an under-garment within `reach` straight out to `gap` beyond it, and each one that is outside
    # but closer than `gap` out to `gap`: the two are simplified apart later, each by up to a few
    # millimetres, so surfaces that merely touch here would cross there.
    trees = []
    for o in unders:
        mw = o.matrix_world
        trees.append(BVHTree.FromPolygons([mw @ v.co for v in o.data.vertices], [list(f.vertices) for f in o.data.polygons]))
    mw = obj.matrix_world
    inv = mw.inverted()
    nm = mw.to_3x3()
    moved = 0
    for v in obj.data.vertices:
        n = outward(v, nm)
        if n is None:
            continue
        p = mw @ v.co
        hits = [h for h in (t.ray_cast(p - n * gap, n, reach + gap) for t in trees) if h[0] is not None]
        if hits:
            out = max((h[0] - p).dot(n) for h in hits) + gap
            if out > 0:
                v.co = inv @ (p + n * out)
                moved += 1
    obj.data.update()
    return moved


def region(p):
    return job.get('regions', {}).get(os.path.basename(os.path.dirname(p['mhclo'])))


garments = [p for p in parts if p['kind'] == 'clothes']
# tops are worn over bottoms: a top's hem first goes out over the bottom, then the bottom loses
# what the top hides (its last ring tucked under the hem)
tops = [p['obj'] for p in garments if region(p) == 'top']
bottoms = [p['obj'] for p in garments if region(p) == 'bottom']
lifted = sum(lift_over(o, bottoms, 0.025, 0.008) for o in tops) if bottoms else 0
hidden = hide_covered(basemesh, [p['obj'] for p in garments], 0.035)
for o in bottoms:
    hidden += hide_covered(o, tops, 0.02, tuck=0.005)

# ---- pose into the Biped's bind pose ------------------------------------------------------------


def g2b(v):
    # glTF (+Y up, faces +Z) → Blender (+Z up, faces -Y)
    return Vector((v[0], -v[2], v[1]))


def tpl_pos(name):
    return g2b(tpl[name]['wp'])


def tpl_xaxis(name):
    x, y, z, w = tpl[name]['wq']
    from mathutils import Quaternion
    return g2b(Quaternion((w, x, y, z)) @ Vector((1, 0, 0))).normalized()


def tpl_dir(bone, child):
    return (tpl_pos(child) - tpl_pos(bone)).normalized() if child else tpl_xaxis(bone)


pose = rig.pose.bones
# each bone's rest orientation, for the ones that keep it (see keep())
original = {pb.name: pb.matrix.to_3x3() for pb in pose}


def mh_head(name):
    return pose[name].head.copy()


def mh_dir(bone, child):
    end = pose[child].head if child else pose[bone].tail
    return (end - pose[bone].head).normalized()


def frame(a, b):
    # Orthonormal frame from a main axis and a second vector (made perpendicular to it).
    a = a.normalized()
    n = (b - a * a.dot(b)).normalized()
    return Matrix((a, n, a.cross(n))).transposed()


def turn(bone, rot):
    pb = pose[bone]
    h = pb.head.copy()
    pb.matrix = Matrix.Translation(h) @ rot.to_4x4() @ Matrix.Translation(-h) @ pb.matrix
    bpy.context.view_layer.update()


def align(bone, child, biped, biped_child, twist=None):
    a, b = mh_dir(bone, child), tpl_dir(biped, biped_child)
    if twist:
        # Also match a second direction across the bone (the palm, or the elbow's bend plane).
        a2, b2 = twist
        a2, b2 = a2(), b2()
        if a2 is not None and b2 is not None:
            rot = frame(b, b2) @ frame(a, a2).transposed()
            turn(bone, rot)
            return
    turn(bone, a.rotation_difference(b).to_matrix())


def keep(bone):
    # Turns a bone back to its own rest orientation after its parents moved: the head (so the face
    # looks straight ahead, as a Rocketbox face does in the bind pose) and the feet (soles flat).
    # Matching their bone axes instead would nod a big toddler head or tip the soles, since
    # MakeHuman's head and foot bones sit at other angles to the face and the sole.
    turn(bone, original[bone] @ pose[bone].matrix.to_3x3().inverted())


def bend_normal(upper, lower, child):
    # Normal of the plane a limb bends in, or None when it is too straight to tell.
    u, l = mh_dir(upper, lower), mh_dir(lower, child)
    return u.cross(l) if u.cross(l).length > math.sin(math.radians(12)) else None


FINGERS = [('thumb', 0), ('index', 1), ('middle', 2), ('ring', 3), ('pinky', 4)]
align('spine_01', 'spine_02', 'Bip01 Spine', 'Bip01 Spine1')
align('spine_02', 'spine_03', 'Bip01 Spine1', 'Bip01 Spine2')
align('spine_03', 'neck_01', 'Bip01 Spine2', 'Bip01 Neck')
align('neck_01', 'head', 'Bip01 Neck', 'Bip01 Head')
keep('head')
for s, S in (('l', 'L'), ('r', 'R')):
    B = f'Bip01 {S} '
    align(f'clavicle_{s}', f'upperarm_{s}', B + 'Clavicle', B + 'UpperArm')
    biped_elbow = (tpl_dir(B + 'UpperArm', B + 'Forearm').cross(tpl_dir(B + 'Forearm', B + 'Hand')))
    align(f'upperarm_{s}', f'lowerarm_{s}', B + 'UpperArm', B + 'Forearm',
          twist=(lambda s=s: bend_normal(f'upperarm_{s}', f'lowerarm_{s}', f'hand_{s}'), lambda e=biped_elbow: e))
    align(f'lowerarm_{s}', f'hand_{s}', B + 'Forearm', B + 'Hand')
    align(f'hand_{s}', f'middle_01_{s}', B + 'Hand', B + 'Finger2',
          twist=(lambda s=s: mh_head(f'index_01_{s}') - mh_head(f'pinky_01_{s}'),
                 lambda B=B: tpl_pos(B + 'Finger1') - tpl_pos(B + 'Finger4')))
    for f, n in FINGERS:
        align(f'{f}_01_{s}', f'{f}_02_{s}', f'{B}Finger{n}', f'{B}Finger{n}1')
        align(f'{f}_02_{s}', f'{f}_03_{s}', f'{B}Finger{n}1', f'{B}Finger{n}2')
        align(f'{f}_03_{s}', None, f'{B}Finger{n}2', None)
    align(f'thigh_{s}', f'calf_{s}', B + 'Thigh', B + 'Calf')
    align(f'calf_{s}', f'foot_{s}', B + 'Calf', B + 'Foot')
    keep(f'foot_{s}')
    keep(f'ball_{s}')

# Bake the pose into the meshes and make it the rest pose.
for p in parts:
    obj = p['obj']
    for m in list(obj.modifiers):
        if m.type == 'ARMATURE':
            with_obj(obj, lambda: bpy.ops.object.modifier_apply(modifier=m.name))
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='POSE')
bpy.ops.pose.select_all(action='SELECT')
bpy.ops.pose.armature_apply(selected=False)
bpy.ops.object.mode_set(mode='OBJECT')
for p in parts:
    m = p['obj'].modifiers.new('Armature', 'ARMATURE')
    m.object = rig

# ---- export -------------------------------------------------------------------------------------
for p in parts:
    p['obj'].data.name = p['obj'].name
bpy.ops.export_scene.gltf(
    filepath=job['out'], export_format='GLB', use_selection=False, export_yup=True, export_apply=False,
    export_skins=True, export_animations=False, export_morph=False, export_materials='EXPORT',
    export_image_format='NONE', export_texcoords=True, export_normals=True, export_tangents=False,
    export_extras=False, export_all_influences=False)


def b2g(v):
    return [v.x, v.z, -v.y]


eyes = next((p['obj'] for p in parts if p['kind'] == 'eyes'), None)
eye_centres = {}
if eyes:
    for side, sign in (('l', 1), ('r', -1)):
        vs = [eyes.matrix_world @ v.co for v in eyes.data.vertices if v.co.x * sign > 0]
        eye_centres[side] = b2g(sum(vs, Vector()) / len(vs))
skin_vs = [basemesh.matrix_world @ v.co for v in basemesh.data.vertices]
info = {
    'id': job['id'],
    'parts': [{'node': p['obj'].name, 'kind': p['kind'], 'mhmat': p.get('mhmat'), 'mhclo': p['mhclo'],
               'verts': len(p['obj'].data.vertices), 'faces': len(p['obj'].data.polygons)} for p in parts],
    'eyes': eye_centres,
    'hiddenFaces': hidden,
    'height': max(v.z for v in skin_vs),
}
json.dump(info, open(os.path.splitext(job['out'])[0] + '.json', 'w', encoding='utf-8'), indent=1)
print('MH-BUILD-OK', job['id'], round(info['height'], 3), 'm,', sum(p['faces'] for p in info['parts'] if p['kind'] != 'seat'), 'faces,', hidden, 'hidden faces deleted,', lifted, 'hem vertices lifted')
