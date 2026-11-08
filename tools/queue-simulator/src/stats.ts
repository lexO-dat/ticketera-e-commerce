/** Latencias en ms: percentiles por el método del rango más cercano. */
export class Latencies {
  private readonly samples: number[] = [];

  add(ms: number): void {
    this.samples.push(ms);
  }

  get count(): number {
    return this.samples.length;
  }

  percentile(p: number): number {
    if (this.samples.length === 0) return 0;
    const sorted = [...this.samples].sort((a, b) => a - b);
    const rank = Math.ceil((p / 100) * sorted.length);
    return Math.round(sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!);
  }

  summary(): { n: number; p50: number; p95: number; p99: number; max: number } {
    return {
      n: this.count,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      max: this.percentile(100),
    };
  }
}

/** Contadores con nombre. */
export class Counters {
  private readonly values = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.values.set(name, (this.values.get(name) ?? 0) + by);
  }

  get(name: string): number {
    return this.values.get(name) ?? 0;
  }

  toJSON(): Record<string, number> {
    return Object.fromEntries([...this.values].sort(([a], [b]) => a.localeCompare(b)));
  }
}
