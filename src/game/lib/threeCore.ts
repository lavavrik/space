/**
 * The parts of three.js the game uses (lib/three.ts gathers them as `THREE`): maths, colours and
 * geometry building, nothing that renders (the renderer is our own WebGPU one, docs/webgpu.md).
 * From three's per-class source files: its package is one flat bundle the bundler can't prune, so
 * importing from it kept all of it, the WebGL renderer included. A class the game starts using goes
 * here.
 */
export { BufferAttribute, Float32BufferAttribute } from 'three/src/core/BufferAttribute.js';
export { BufferGeometry } from 'three/src/core/BufferGeometry.js';
export { Color } from 'three/src/math/Color.js';
export { ColorManagement } from 'three/src/math/ColorManagement.js';
export { MathUtils } from 'three/src/math/MathUtils.js';
export { Matrix4 } from 'three/src/math/Matrix4.js';
export { Quaternion } from 'three/src/math/Quaternion.js';
export { Vector3 } from 'three/src/math/Vector3.js';
export { Vector4 } from 'three/src/math/Vector4.js';
export { BoxGeometry } from 'three/src/geometries/BoxGeometry.js';
export { ConeGeometry } from 'three/src/geometries/ConeGeometry.js';
export { CylinderGeometry } from 'three/src/geometries/CylinderGeometry.js';
export { IcosahedronGeometry } from 'three/src/geometries/IcosahedronGeometry.js';
export { RingGeometry } from 'three/src/geometries/RingGeometry.js';
export { ShapeGeometry } from 'three/src/geometries/ShapeGeometry.js';
export { SphereGeometry } from 'three/src/geometries/SphereGeometry.js';
export { Path } from 'three/src/extras/core/Path.js';
export { Shape } from 'three/src/extras/core/Shape.js';
export { PerspectiveCamera } from 'three/src/cameras/PerspectiveCamera.js';
