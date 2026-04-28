export type CdpCommandOutcome<TResult> =
  | {
      ok: true;
      value: TResult;
    }
  | {
      ok: false;
    };

export function withCdpCommandTimeout<TResult>(
  task: Promise<TResult>,
  timeoutMs: number
): Promise<CdpCommandOutcome<TResult>> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  return Promise.race<CdpCommandOutcome<TResult>>([
    task.then(
      (value) => ({
        ok: true,
        value
      }),
      () => ({
        ok: false
      })
    ),
    new Promise<CdpCommandOutcome<TResult>>((resolve) => {
      timer = setTimeout(
        () => {
          resolve({ ok: false });
        },
        Math.max(0, timeoutMs)
      );
    })
  ]).finally(() => {
    if (timer !== null) {
      clearTimeout(timer);
    }
  });
}
