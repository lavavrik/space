import * as THREE from 'three';

// Every colour in the game is authored in linear space and the shaders output it directly.
// This must run before any THREE.Color is created, so every game module imports THREE from here.
THREE.ColorManagement.enabled = false;

export { THREE };
