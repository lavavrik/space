/*
 * The WGSL shaders (docs/webgpu.md), with their shared pieces spliced in: a line
 * `// #include name` is replaced by that file. One file per material or pass.
 */
import noise from './noise.wgsl?raw';
import frame from './frame.wgsl?raw';
import skyBake from './skyBake.wgsl?raw';
import sky from './sky.wgsl?raw';
import stars from './stars.wgsl?raw';
import tonemap from './tonemap.wgsl?raw';
import world from './world.wgsl?raw';
import noise3d from './noise3d.wgsl?raw';
import terrain from './terrain.wgsl?raw';
import atmo from './atmo.wgsl?raw';
import clouds from './clouds.wgsl?raw';
import city from './city.wgsl?raw';
import planet from './planet.wgsl?raw';
import atmosphere from './atmosphere.wgsl?raw';
import cloudLayer from './cloudLayer.wgsl?raw';
import cloudBake from './cloudBake.wgsl?raw';
import ring from './ring.wgsl?raw';
import star from './star.wgsl?raw';
import dots from './dots.wgsl?raw';
import chunk from './chunk.wgsl?raw';
import terrainBake from './terrainBake.wgsl?raw';
import rock from './rock.wgsl?raw';
import rocksCull from './rocksCull.wgsl?raw';
import rocks from './rocks.wgsl?raw';
import stationBody from './stationBody.wgsl?raw';
import station from './station.wgsl?raw';
import stationInterior from './stationInterior.wgsl?raw';
import corridor from './corridor.wgsl?raw';
import skyStation from './skyStation.wgsl?raw';
import fx from './fx.wgsl?raw';
import meter from './meter.wgsl?raw';
import ringband from './ringband.wgsl?raw';
import shadow from './shadow.wgsl?raw';
import vclouds from './vclouds.wgsl?raw';

const parts: Record<string, string> = { noise, frame, world, chunk, rock, stationBody, ringband, shadow, noise3d, terrain, atmo, clouds, city };
const build = (src: string) => src.replace(/^\/\/ #include (\w+)$/gm, (_, name: string) => parts[name] ?? `// (no ${name})`);

export const SKY_BAKE_WGSL = build(skyBake);
export const SKY_WGSL = build(sky);
export const STARS_WGSL = build(stars);
export const TONEMAP_WGSL = build(tonemap);
export const PLANET_WGSL = build(planet);
export const ATMO_WGSL = build(atmosphere);
export const CLOUD_WGSL = build(cloudLayer);
export const CLOUD_BAKE_WGSL = build(cloudBake);
export const RING_WGSL = build(ring);
export const STAR_WGSL = build(star);
export const DOTS_WGSL = build(dots);
export const TERRAIN_BAKE_WGSL = build(terrainBake);
export const ROCKS_CULL_WGSL = build(rocksCull);
export const ROCKS_WGSL = build(rocks);
export const STATION_WGSL = build(station);
export const STATION_INTERIOR_WGSL = build(stationInterior);
export const CORRIDOR_WGSL = build(corridor);
export const SKY_STATION_WGSL = build(skyStation);
export const FX_WGSL = build(fx);
export const METER_WGSL = build(meter);
export const VCLOUDS_WGSL = build(vclouds);
