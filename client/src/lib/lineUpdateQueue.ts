// Serialises edits per import line (#48). Every edit is sent only after the previous one for the
// same line has settled, so the server cannot apply them out of order, and only the response to
// the newest edit is applied, so a slow earlier response can never overwrite a later one.
// Lines are independent of each other and run concurrently.
export interface LineUpdateQueue<Fields> {
  enqueue(lineId: number, fields: Fields): Promise<void>;
  // Resolves once every edit queued so far has settled; rejects if a line's latest edit failed
  // and was not since replaced by a successful one, so a commit never proceeds on stale server state.
  drain(): Promise<void>;
}

export function createLineUpdateQueue<Fields, Row>({
  send,
  onOptimistic,
  onSettled,
  onError,
}: {
  send: (lineId: number, fields: Fields) => Promise<Row>;
  // Applied synchronously so inputs follow the user before the server answers.
  onOptimistic: (lineId: number, fields: Fields) => void;
  // The authoritative row, only once no newer edit for the line is outstanding.
  onSettled: (lineId: number, row: Row) => void;
  // A failed edit, with whether it was the line's last outstanding one (a good moment to resync).
  onError: (lineId: number, err: unknown, isLatest: boolean) => void;
}): LineUpdateQueue<Fields> {
  const tails = new Map<number, Promise<void>>();
  const outstanding = new Map<number, number>();
  const failed = new Set<number>();

  return {
    enqueue(lineId, fields) {
      onOptimistic(lineId, fields);
      outstanding.set(lineId, (outstanding.get(lineId) ?? 0) + 1);
      const run = (tails.get(lineId) ?? Promise.resolve()).then(async () => {
        let result: { row: Row } | { err: unknown };
        try {
          result = { row: await send(lineId, fields) };
        } catch (err) {
          result = { err };
        }
        const left = (outstanding.get(lineId) ?? 1) - 1;
        if (left === 0) outstanding.delete(lineId);
        else outstanding.set(lineId, left);
        if ('err' in result) {
          if (left === 0) failed.add(lineId);
          onError(lineId, result.err, left === 0);
        } else {
          if (left === 0) failed.delete(lineId);
          if (left === 0) onSettled(lineId, result.row);
        }
      });
      tails.set(lineId, run);
      return run;
    },
    async drain() {
      await Promise.all([...tails.values()]);
      if (failed.size) throw new Error('Some changes could not be saved, so the import was reloaded from the server. Review it and try again.');
    },
  };
}
