// Cloud cover (render/shaders/clouds.glsl): cloudRaw is what the per-world bake evaluates (into a
// cube map in the world's own frame), cloudCover turns a raw value into cover (0…1).
// The weather turns round the world's axis (its local y) a little faster than the ground: ~16 m/s
// at an Earth's equator (sim/clouds.ts CLOUD_WIND). A local direction → where in the (baked, still)
// cloud map it is now. Everything that reads the map goes through it (the deck, the volumetric
// clouds, their shadows on the ground), so they move together.
const CLOUD_WIND: f32 = 2.5e-6; // rad/s
fn cloudDir(p: vec3f) -> vec3f {
  let a = -world.time * CLOUD_WIND;
  let c = cos(a);
  let s = sin(a);
  return vec3f(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

// The weather map now: the baked map read twice, once moving with the wind (cloudDir) and once
// slower, round a tilted axis and from another part of the map; the two slide past each other, so
// weather systems grow, merge and die away over hours instead of only turning round the world.
// `p`: a unit direction in the world's own frame.
fn cloudMap(p: vec3f) -> f32 {
  let a = cloudDir(p);
  let ang = -world.time * CLOUD_WIND * 0.55;
  let axis = normalize(vec3f(0.35, 1.0, 0.2));
  let b = p * cos(ang) + cross(axis, p) * sin(ang) + axis * dot(axis, p) * (1.0 - cos(ang));
  let s1 = textureSampleLevel(cloudTex, cloudSamp, a, 0.0).r;
  let s2 = textureSampleLevel(cloudTex, cloudSamp, vec3f(b.z, -b.y, b.x), 0.0).r;
  return (s1 + s2) * 0.7; // (two independent fields: × 0.7 keeps the spread about the same)
}

// How far the cloud layer is lifted over high ground (m), at a unit direction in the world's own
// frame (not the wind's: the ground stays put): enough for the volumetric layer's base (0.4 deck
// heights) to clear the ground's coarse height (the cube's second channel, cloudBake.wgsl) by
// LIFT_CLEAR, as gpu/worlds.ts's vcLift does for the ground under you, plus a fifth of the relief
// for the peaks finer than the bake. Without it the plateaus and
// ranges rose through the clouds and cut them off (up to ~1.3 × the relief: on an Earth-like world
// a fifth of the ground is over the base): from orbit, gaps with the haze's gradient round them.
const LIFT_CLEAR: f32 = 1200.0;
fn cloudLiftAt(p: vec3f) -> f32 {
  let g = textureSampleLevel(cloudTex, cloudSamp, p, 0.0).g;
  return max(g + (LIFT_CLEAR + 0.2 * world.terrA) * smoothstep(0.0, 500.0, g) - world.cloudH * 0.4, 0.0); // (none over the sea)
}
// …at most (the ground's at most ~1.3 × the relief)
fn cloudLiftMax() -> f32 { return max(world.terrA * 1.6 + LIFT_CLEAR - world.cloudH * 0.4, 0.0); }

fn cloudRaw(p: vec3f, oct: i32) -> f32 {
  let s = world.seed;
  let cp = (p * 1.6 + vec3f(s * 1.7, s * 2.3, s * 0.9)) * 1.25;
  return fbmF(cp + fbmF(cp * 2.0, 4) * 0.7, oct);
}
// Earth-like and ocean worlds (wtype 2, 3) are clouded over most of their face, with clear
// stretches between weather systems (at the others' threshold, from 0.02, about half their face was
// bare, and the volumetric clouds' own gaps, vclouds.wgsl, left most of the rest clear too)
fn cloudCover(raw: f32) -> f32 {
  let wet = world.wtype == 2 || world.wtype == 3;
  return smoothstep(select(0.02, -0.2, wet), select(0.5, 0.25, wet), raw) * select(0.85, 0.95, world.wtype == 3);
}
