import { exec, ExecOptions } from "child_process";

/**
 * Async wrapper around child_process.exec.
 *
 * Returns a Promise of {stdout, stderr}. On error, the rejected error carries
 * stdout/stderr properties (matching execSync's throw behavior) so callers can
 * inspect partial output even on failure.
 */
export function execAsync(
  command: string,
  options?: ExecOptions & { encoding?: BufferEncoding },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    exec(command, { ...options, encoding: options?.encoding ?? "utf-8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout: stdout as string, stderr: stderr as string });
      }
    });
  });
}
