export interface HasPosition {
  x: number;
  y: number;
}

export class SpatialHash<T extends HasPosition> {
  private buckets = new Map<number, T[]>();
  constructor(private readonly cellSize: number) {}

  private key(x: number, y: number): number {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);
    return cx * 73856093 ^ cy * 19349663;
  }

  insert(item: T) {
    const k = this.key(item.x, item.y);
    let arr = this.buckets.get(k);
    if (!arr) {
      arr = [];
      this.buckets.set(k, arr);
    }
    arr.push(item);
  }

  queryRadius(x: number, y: number, radius: number, out: T[] = []): T[] {
    const minCx = Math.floor((x - radius) / this.cellSize);
    const maxCx = Math.floor((x + radius) / this.cellSize);
    const minCy = Math.floor((y - radius) / this.cellSize);
    const maxCy = Math.floor((y + radius) / this.cellSize);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const k = (cx * 73856093) ^ (cy * 19349663);
        const arr = this.buckets.get(k);
        if (!arr) continue;
        for (const it of arr) out.push(it);
      }
    }
    return out;
  }

  clear() {
    this.buckets.clear();
  }
}
