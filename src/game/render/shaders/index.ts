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
import headlightGlsl from './headlight.glsl?raw';
import corridorFrag from './corridor.frag.glsl?raw';
import corridorLightVert from './corridorLight.vert.glsl?raw';
import corridorLightFrag from './corridorLight.frag.glsl?raw';
import skyFrag from './sky.frag.glsl?raw';
import skyCubeFrag from './skyCube.frag.glsl?raw';
import skyPointVert from './skyPoint.vert.glsl?raw';
import skyPointFrag from './skyPoint.frag.glsl?raw';
import stationFrag from './station.frag.glsl?raw';
import skyStationFrag from './skyStation.frag.glsl?raw';
import terrainGlsl from './terrain.glsl?raw';
import atmoGlsl from './atmo.glsl?raw';
import cloudsGlsl from './clouds.glsl?raw';
import cloudLayerFrag from './cloudLayer.frag.glsl?raw';
import cloudBakeFrag from './cloudBake.frag.glsl?raw';
import planetVert from './planet.vert.glsl?raw';
import terrainBakeFrag from './terrainBake.frag.glsl?raw';

// Shaders that need simplex noise and fBm mark the spot with this pragma.
const withNoise = (src: string) => src.replace('#pragma farlight_noise', noise);

/** Planets, moons, atmospheres, rings and stars share one vertex shader. */
export const BODY_VS = bodyVert;
/** Planets: exact simplex noise for coarse octaves, the 3D noise texture (uNoise3D) for fine ones. */
const withTerrain = (src: string) =>
  withNoise(src).replace('#pragma farlight_noise3d', noise3d).replace('#pragma farlight_terrain', terrainGlsl).replace('#pragma farlight_atmo', atmoGlsl).replace('#pragma farlight_clouds', cloudsGlsl);
export const PLANET_FS = withTerrain(planetFrag);
/** Planets: the far sphere, or (with the TERRAIN define) a displaced terrain chunk (render/Terrain.ts). */
export const PLANET_VS = withTerrain(planetVert);
/** The cloud layer (a shell at the deck's height). */
export const CLOUD_FS = withTerrain(cloudLayerFrag);
/** Bakes a world's cloud pattern into a cube map. */
export const CLOUD_BAKE_FS = withTerrain(cloudBakeFrag);
/** The terrain bake pass (render/Terrain.ts): PLANET_VS with TERRAIN_BAKE, as points. */
export const TERRAIN_BAKE_FS = terrainBakeFrag;
/** The sky shell (scattering, atmo.glsl). */
export const ATMO_FS = atmosphereFrag.replace('#pragma farlight_atmo', atmoGlsl);
export const STAR_FS = withNoise(starFrag);
export const GLOW_VS = glowVert;
export const GLOW_FS = glowFrag;
export const RING_FS = withNoise(ringFrag);
/** Orbital stations (drawn with BODY_VS on a unit cube). */
const withHeadlight = (src: string) => src.replace('#pragma farlight_headlight', headlightGlsl);
export const STATION_FS = withHeadlight(withNoise(stationFrag));
/** Sky stations (drawn with BODY_VS on render/skyMesh.ts): lit and hazed through their world's air. */
export const SKY_STATION_FS = withHeadlight(skyStationFrag.replace('#pragma farlight_atmo', atmoGlsl));
/** Station interiors: slot tunnel, hangar and pads (drawn with BODY_VS). */
export const STATION_INTERIOR_FS = withHeadlight(stationInteriorFrag);
/** The lit approach corridor in front of a station's slot while you have a pad there. */
export const CORRIDOR_FS = corridorFrag;
/** The entry corridor's approach lights (points). */
export const CORRIDOR_LIGHT_VS = corridorLightVert;
export const CORRIDOR_LIGHT_FS = corridorLightFrag;
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
