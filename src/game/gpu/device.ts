/**
 * WebGPU setup (docs/webgpu.md): which renderer to use, and the GPU device for the WebGPU one.
 *
 * `?gpu=webgpu` in the URL picks the WebGPU renderer, `?gpu=webgl` the WebGL one; the choice is
 * remembered (localStorage `farlight.renderer`). WebGL is the default until the port is done. With
 * WebGPU asked for but not available (no `navigator.gpu`, or no adapter), it falls back to WebGL.
 */

const KEY = 'farlight.renderer';

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** The canvas's preferred format (bgra8unorm on most platforms). */
  format: GPUTextureFormat;
  /** Optional features we asked for and got. */
  timestamps: boolean;
}

/** The renderer asked for: the URL's `?gpu=`, else the remembered choice, else WebGL. */
export function wantWebGpu(): boolean {
  const q = new URLSearchParams(location.search).get('gpu');
  try {
    if (q === 'webgpu' || q === 'webgl') localStorage.setItem(KEY, q);
    return (q ?? localStorage.getItem(KEY)) === 'webgpu';
  } catch {
    return q === 'webgpu';
  }
}

/** The GPU device, or null (with why, in the console) if WebGPU isn't there. */
export async function initGpu(): Promise<Gpu | null> {
  if (!navigator.gpu) {
    console.warn('WebGPU: not supported by this browser · using WebGL');
    return null;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    console.warn('WebGPU: no adapter · using WebGL');
    return null;
  }
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  device.lost.then((info) => console.error(`WebGPU device lost: ${info.reason} · ${info.message}`));
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', (e as GPUUncapturedErrorEvent).error.message));
  return { adapter, device, format: navigator.gpu.getPreferredCanvasFormat(), timestamps };
}
