import { fstatSync } from 'node:fs';

/**
 * True when stdout (`fd`, default 1) feeds ANOTHER PROCESS — a pipe (FIFO) or
 * a socket — so a downstream command's `$?` masks shrk's. False for a TTY, a
 * plain file redirect (`shrk check boundaries > out.log`), `/dev/null`, or an
 * fd that cannot be stat'ed.
 *
 * Round 13: the "stdout is piped" note keyed on `!process.stdout.isTTY`, which
 * is true for a file redirect too — `… > log 2>&1; echo $?` printed exit 1
 * correctly and still wrote "note: stdout is piped — $? reflects the
 * downstream command" into the log, where there was no downstream command.
 */
export function isStdoutPipe(fd: number = 1): boolean {
  try {
    const st = fstatSync(fd);
    return st.isFIFO() || st.isSocket();
  } catch {
    return false;
  }
}
