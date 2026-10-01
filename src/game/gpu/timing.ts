/**
 * GPU time per pass for the performance overlay (debug/Perf.ts), from WebGPU timestamp queries
 * (the 'timestamp-query' feature, when the adapter has it): each timed pass writes a timestamp at
 * its start and end; after the frame they're resolved, copied to a mappable buffer and read back
 * asynchronously (one frame's worth in flight), then reported to the overlay for the frame they
 * belong to. While the overlay is shown the scene is split into several passes (sky, bodies,
 * stations and ships, transparent) so their times show separately.
 */
const MAX_PASSES = 24;

export class GpuTimer {
  private readonly set: GPUQuerySet;
  private readonly resolveBuf: GPUBuffer;
  private readonly readBuf: GPUBuffer;
  private labels: string[] = [];
  private busy = false;
  private frameLabels: string[] | null = null;
  private frameSlot = 0;

  constructor(
    device: GPUDevice,
    /** Where results go: the frame's slot and each pass's label and ms. */
    private readonly report: (slot: number, parts: [string, number][]) => void,
  ) {
    this.set = device.createQuerySet({ type: 'timestamp', count: MAX_PASSES * 2 });
    this.resolveBuf = device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuf = device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  }

  /** Start a frame: false while the last one's results are still being read. */
  begin() {
    this.labels = [];
    return !this.busy;
  }

  /** Timestamp writes for a pass labelled `label` (undefined if not timing this frame or out of slots). */
  pass(label: string, on: boolean): GPUComputePassTimestampWrites | undefined {
    if (!on || this.busy || this.labels.length >= MAX_PASSES) return undefined;
    const i = this.labels.length;
    this.labels.push(label);
    return { querySet: this.set, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  /** At the end of the frame's encoding: resolve the timestamps written. */
  end(enc: GPUCommandEncoder, slot: number) {
    if (this.busy || !this.labels.length) return;
    const n = this.labels.length * 2;
    enc.resolveQuerySet(this.set, 0, n, this.resolveBuf, 0);
    enc.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, n * 8);
    this.frameLabels = this.labels;
    this.frameSlot = slot;
  }

  /** After the frame's submit: read them back and report. */
  submitted() {
    const labels = this.frameLabels;
    if (!labels) return;
    this.frameLabels = null;
    this.busy = true;
    const slot = this.frameSlot;
    this.readBuf.mapAsync(GPUMapMode.READ).then(
      () => {
        const t = new BigUint64Array(this.readBuf.getMappedRange().slice(0, labels.length * 16));
        this.readBuf.unmap();
        this.busy = false;
        const parts: [string, number][] = labels.map((l, i) => [l, t[i * 2 + 1] > t[i * 2] ? Number(t[i * 2 + 1] - t[i * 2]) / 1e6 : 0]);
        this.report(slot, parts);
      },
      () => (this.busy = false),
    );
  }

  dispose() {
    this.set.destroy();
    this.resolveBuf.destroy();
    this.readBuf.destroy();
  }
}
