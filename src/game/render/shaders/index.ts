import noise from './noise.glsl?raw';
import noise3d from './noise3d.glsl?raw';
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
import stationInteriorFrag from './stationInterior.frag.glsl?raw';
import skyFrag from './sky.frag.glsl?raw';
import skyCubeFrag from './skyCube.frag.glsl?raw';
import skyPointVert from './skyPoint.vert.glsl?raw';
import skyPointFrag from './skyPoint.frag.glsl?raw';
import stationFrag from './station.frag.glsl?raw';

// Shaders that need simplex noise and fBm mark the spot with this pragma.
const withNoise = (src: string) => src.replace('#pragma farlight_noise', noise);

/** Planets, moons, atmospheres, rings and stars share one vertex shader. */
export const BODY_VS = bodyVert;
/** Planets: exact simplex noise for coarse octaves, the 3D noise texture (uNoise3D) for fine ones. */
export const PLANET_FS = withNoise(planetFrag).replace('#pragma farlight_noise3d', noise3d);
export const ATMO_FS = atmosphereFrag;
export const STAR_FS = withNoise(starFrag);
export const GLOW_VS = glowVert;
export const GLOW_FS = glowFrag;
export const RING_FS = withNoise(ringFrag);
/** Orbital stations (drawn with BODY_VS on a unit cube). */
export const STATION_FS = withNoise(stationFrag);
/** Station interiors: slot tunnel, hangar and pads (drawn with BODY_VS). */
export const STATION_INTERIOR_FS = stationInteriorFrag;
/** Point sprites: distant bodies and dust. */
export const POINT_VS = pointVert;
export const POINT_FS = pointFrag;
/** Milky Way backdrop and the star field. */
export const SKY_VS = skyVert;
export const SKY_FS = withNoise(skyFrag);
/** The procedural sky, writing sqrt(colour) for baking into an 8-bit cube map. */
export const SKY_BAKE_FS = SKY_FS.replace('gl_FragColor=vec4(col,1.0);', 'gl_FragColor=vec4(sqrt(col),1.0);');
/** Draws the baked sky cube map. */
export const SKY_CUBE_FS = skyCubeFrag;
export const SKYPT_VS = skyPointVert;
export const SKYPT_FS = skyPointFrag;
