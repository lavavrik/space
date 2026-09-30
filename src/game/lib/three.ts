import * as THREE from './threeCore';

// Every colour in the game is authored in linear space and the shaders output it directly.
// This must run before any THREE.Color is created, so every game module imports THREE from here.
// (Only the classes in threeCore.ts: the rest of three.js, its WebGL renderer among it, stays out
// of the bundle.)
THREE.ColorManagement.enabled = false;

export { THREE };
