export class LatestTaskGate {
  private generation = 0;

  public begin(): number {
    this.generation += 1;
    return this.generation;
  }

  public invalidate(): void {
    this.generation += 1;
  }

  public isCurrent(token: number): boolean {
    return token === this.generation;
  }
}
