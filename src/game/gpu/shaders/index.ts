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

const parts: Record<string, string> = { noise, frame };
const build = (src: string) => src.replace(/^\/\/ #include (\w+)$/gm, (_, name: string) => parts[name] ?? `// (no ${name})`);

export const SKY_BAKE_WGSL = build(skyBake);
export const SKY_WGSL = build(sky);
export const STARS_WGSL = build(stars);
export const TONEMAP_WGSL = build(tonemap);
