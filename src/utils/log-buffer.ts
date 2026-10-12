export class LogBuffer {
  private lines: string[] = [];
  private start = 0;
  private max: number;

  constructor(max: number) {
    this.max = max;
  }

  push(line: string) {
    if (this.lines.length < this.max) {
      this.lines.push(line);
    } else {
      this.lines[this.start] = line;
      this.start = (this.start + 1) % this.max;
    }
  }

  // oldest -> newest
  toArray(): string[] {
    return [...this.lines.slice(this.start), ...this.lines.slice(0, this.start)];
  }

  clear() {
    this.lines = [];
    this.start = 0;
  }
}
