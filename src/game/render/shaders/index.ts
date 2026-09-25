import noise from './noise.glsl?raw';
import bodyVert from './body.vert.glsl?raw';
import planetFrag from './planet.frag.glsl?raw';
import atmosphereFrag from './atmosphere.frag.glsl?raw';
import starFrag from './star.frag.glsl?raw';
import glowVert from './glow.vert.glsl?raw';
import glowFrag from './glow.frag.glsl?raw';
import ringFrag from './ring.frag.glsl?raw';
import pointVert from './point.vert.glsl?raw';
import pointFrag from './point.frag.glsl?raw';
import skyVert from './sky.vert.glsl?raw';
import skyFrag from './sky.frag.glsl?raw';
import skyPointVert from './skyPoint.vert.glsl?raw';
import skyPointFrag from './skyPoint.frag.glsl?raw';

// Shaders that need simplex noise and fBm mark the spot with this pragma.
const withNoise = (src: string) => src.replace('#pragma farlight_noise', noise);

/** Planets, moons, atmospheres, rings and stars share one vertex shader. */
export const BODY_VS = bodyVert;
export const PLANET_FS = withNoise(planetFrag);
export const ATMO_FS = atmosphereFrag;
export const STAR_FS = withNoise(starFrag);
export const GLOW_VS = glowVert;
export const GLOW_FS = glowFrag;
export const RING_FS = withNoise(ringFrag);
/** Point sprites: distant bodies and dust. */
export const POINT_VS = pointVert;
export const POINT_FS = pointFrag;
/** Milky Way backdrop and the star field. */
export const SKY_VS = skyVert;
export const SKY_FS = withNoise(skyFrag);
export const SKYPT_VS = skyPointVert;
export const SKYPT_FS = skyPointFrag;
