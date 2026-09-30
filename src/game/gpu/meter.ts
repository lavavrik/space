/**
 * The exposure meter in WebGPU (render/exposure.ts has the why): a compute pass (meter.wgsl) averages
 * the resolved HDR frame over 64 px cells, and the cells are copied to a mappable buffer and read
 * back asynchronously, one read in flight at a time, so the GPU never stalls. The reading carries the
 * exposure the frame was drawn at (its tag).
 */
import { METER_WGSL } from './shaders';

type Reading = { data: Float32Array; w: number; h: number; tag: number };

export class Meter {
  private readonly pipe: GPUComputePipeline;
  private cells: GPUBuffer | null = null;
  private read: GPUBuffer | null = null;
  private group: GPUBindGroup | null = null;
  private w = 0;
  private h = 0;
  /** A copy was encoded this frame; after submit, map it. */
  private pending: { tag: number } | null = null;
  private inFlight = false;
  private landed: Reading | null = null;

  constructor(private readonly device: GPUDevice) {
    const module = device.createShaderModule({ label: 'meter', code: METER_WGSL });
    this.pipe = device.createComputePipeline({ label: 'meter', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  /** The frame's size changed: `hdr` is the new resolved frame. */
  resize(hdr: GPUTexture, W: number, H: number) {
    this.cells?.destroy();
    this.read?.destroy();
    this.w = Math.ceil(W / 64);
    this.h = Math.ceil(H / 64);
    const size = this.w * this.h * 16;
    this.cells = this.device.createBuffer({ label: 'meter cells', size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.read = this.device.createBuffer({ label: 'meter read', size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    this.group = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: hdr.createView() },
        { binding: 1, resource: { buffer: this.cells } },
      ],
    });
    this.inFlight = false;
    this.pending = null;
  }

  /** Meter the frame (after the scene pass) if no read is in flight; `tag`: the exposure it was drawn at. */
  encode(enc: GPUCommandEncoder, tag: number) {
    if (this.inFlight || !this.group || !this.cells || !this.read) return;
    const pass = enc.beginComputePass({ label: 'meter' });
    pass.setPipeline(this.pipe);
    pass.setBindGroup(0, this.group);
    pass.dispatchWorkgroups(this.w, this.h);
    pass.end();
    enc.copyBufferToBuffer(this.cells, 0, this.read, 0, this.w * this.h * 16);
    this.pending = { tag };
  }

  /** After the frame's submit: start mapping what was copied. */
  submitted() {
    if (!this.pending || !this.read) return;
    const { tag } = this.pending;
    const read = this.read,
      w = this.w,
      h = this.h;
    this.pending = null;
    this.inFlight = true;
    read.mapAsync(GPUMapMode.READ).then(
      () => {
        if (read !== this.read) return; // resized meanwhile
        this.landed = { data: new Float32Array(read.getMappedRange().slice(0)), w, h, tag };
        read.unmap();
        this.inFlight = false;
      },
      () => {
        this.inFlight = false; // (destroyed on resize)
      },
    );
  }

  /** The reading that has landed since the last call, if any. */
  collect() {
    const r = this.landed;
    this.landed = null;
    return r;
  }

  dispose() {
    this.cells?.destroy();
    this.read?.destroy();
  }
}
