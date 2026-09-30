// GPU particles (gpu/particles.ts; docs/particles.md): a ring of particles in a storage buffer.
// Each frame the CPU lists its emitters and how many each spawns; `spawn` writes the new ones into
// the ring after the last, `simulate` ages and moves every particle (camera-relative positions,
// velocities relative to the frame body, so p += (v − camera's v) dt) and lists the living for an
// indirect draw, and `vs`/`fs` draw them as sprites (sprite.wgsl), streaked by their motion.
// #include frame
// #include sprite

struct Particle {
  pos: vec3f,   // camera-relative (m)
  age: f32,     // s
  vel: vec3f,   // m/s, relative to the frame body
  life: f32,    // s (0: dead)
  col: vec4f,   // rgb (display light at birth); w: size (m)
  k: vec4f,     // growth (size × (1 + growth · age)), drag (1/s), streak (s of motion shown), fade-in (s)
}

struct Emitter {
  pos: vec4f,    // camera-relative; w: the first of this frame's new particles that are its
  vel: vec4f,    // base velocity (relative to the frame body); w: how many it spawns this frame
  dir: vec4f,    // ejection direction (unit, or 0); w: ejection speed (m/s)
  col: vec4f,    // rgb; w: size (m)
  p: vec4f,      // life (s), life jitter (0…1), random speed (m/s), spawn region radius (m)
  q: vec4f,      // growth, drag, streak, fade-in
}

struct Sim {
  camVel: vec4f,  // the camera's velocity (relative to the frame body); w: dt (s)
  head: u32,      // where this frame's new particles start in the ring
  spawnN: u32,    // how many
  emitters: u32,
  cap: u32,       // the ring's size
  seed: u32,
  _p0: u32,
  _p1: u32,
  _p2: u32,
  e: array<Emitter, 32>,
}

@group(1) @binding(0) var<uniform> sim: Sim;
@group(1) @binding(1) var<storage, read_write> parts: array<Particle>;
@group(1) @binding(2) var<storage, read_write> alive: array<u32>;
@group(1) @binding(3) var<storage, read_write> args: array<atomic<u32>>; // the draw's; [1] = instances
// (the draw reads the same buffers, read-only: a vertex stage can't have writable storage)
@group(1) @binding(1) var<storage, read> partsR: array<Particle>;
@group(1) @binding(2) var<storage, read> aliveR: array<u32>;

fn pcg(v0: u32) -> u32 {
  let s = v0 * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
var<private> rs: u32;
fn rnd() -> f32 {
  rs = pcg(rs);
  return f32(rs) / 4294967295.0;
}
fn rndDir() -> vec3f {
  let z = rnd() * 2.0 - 1.0;
  let a = rnd() * 6.2831853;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), r * sin(a), z);
}

@compute @workgroup_size(64)
fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.spawnN) { return; }
  // which emitter's (their ranges are consecutive)
  var e = sim.e[0];
  for (var k = 0u; k < 32u; k++) {
    if (k >= sim.emitters) { break; }
    let first = u32(sim.e[k].pos.w);
    if (i >= first && i < first + u32(sim.e[k].vel.w)) {
      e = sim.e[k];
      break;
    }
  }
  rs = pcg(i ^ (sim.seed * 1664525u));
  var p: Particle;
  p.pos = e.pos.xyz + rndDir() * pow(rnd(), 0.333) * e.p.w;
  p.vel = e.vel.xyz + e.dir.xyz * e.dir.w * (0.5 + rnd()) + rndDir() * e.p.z * rnd();
  p.age = 0.0;
  p.life = e.p.x * (1.0 - e.p.y * rnd());
  p.col = vec4f(e.col.rgb * (0.7 + 0.6 * rnd()), e.col.w * (0.6 + 0.8 * rnd()));
  p.k = e.q;
  parts[(sim.head + i) % sim.cap] = p;
}

@compute @workgroup_size(64)
fn simulate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= sim.cap) { return; }
  var p = parts[i];
  if (p.life <= 0.0) { return; }
  let dt = sim.camVel.w;
  p.age += dt;
  if (p.age >= p.life) {
    p.life = 0.0;
    parts[i] = p;
    return;
  }
  // drag toward the ship's frame (the local medium), not the frame body's: in a ring's belt you
  // orbit at ~20 km/s, and slowing toward the planet flung everything backward along the orbit
  p.vel = sim.camVel.xyz + (p.vel - sim.camVel.xyz) * exp(-p.k.y * dt);
  p.pos += (p.vel - sim.camVel.xyz) * dt;
  parts[i] = p;
  let k = atomicAdd(&args[1], 1u);
  alive[k] = i;
}

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteOut {
  let p = partsR[aliveR[ii]];
  let u = p.age / p.life;
  let fade = (1.0 - u) * (1.0 - u) * select(1.0, clamp(p.age / p.k.w, 0.0, 1.0), p.k.w > 0.0);
  let streak = (p.vel - sim.camVel.xyz) * p.k.z;
  return sprite(vi, p.pos, streak, p.col.w * (1.0 + p.k.x * p.age), p.col.rgb * fade);
}

@fragment
fn fs(in: SpriteOut) -> @location(0) vec4f {
  return spriteLight(in);
}
