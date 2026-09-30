/** The scene pass's targets (docs/webgpu.md): HDR colour, reversed-Z depth, 4× MSAA. */
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
export const SAMPLES = 4;
