/**
 * The GPU device (docs/webgpu.md). The game renders with WebGPU only; without it (no
 * `navigator.gpu`, or no adapter) it can't run, and says so (ui/hooks/useGame.ts).
 */

export interface Gpu {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** The canvas's preferred format (bgra8unorm on most platforms). */
  format: GPUTextureFormat;
  /** Optional features we asked for and got: GPU timing for the performance overlay. */
  timestamps: boolean;
}

/** The GPU device, or why there isn't one. */
export async function initGpu(): Promise<Gpu | string> {
  if (!navigator.gpu) return 'This browser has no WebGPU.';
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return 'WebGPU found no graphics adapter.';
  const timestamps = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({ requiredFeatures: timestamps ? ['timestamp-query'] : [] });
  device.lost.then((info) => console.error(`WebGPU device lost: ${info.reason} · ${info.message}`));
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', (e as GPUUncapturedErrorEvent).error.message));
  return { adapter, device, format: navigator.gpu.getPreferredCanvasFormat(), timestamps };
}
