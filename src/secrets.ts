/**
 * File-permission hardening for the files that hold secrets (F-23).
 *
 * `config.json` carries the downstream API token, `credentials.json` carries the
 * upstream Command Code keys, and `accounts.json` names them. Every write used a
 * bare `writeFile(path, data, 'utf8')`, which creates files with mode `0o666 & ~umask`
 * — commonly `0o644`, i.e. world-readable. On a shared Unix host that hands the
 * keys to every local account. The audit measured exactly that: `config.json`,
 * `credentials.json`, `accounts.json` and `access.log` all at `0o666`.
 *
 * The mode is set on the TEMP file that is then renamed into place, so the secret
 * never exists on disk with wider permissions than intended — a `chmod` after the
 * rename would leave a window where it did. Note that the mode is applied exactly
 * as given: Node does not mask it with the umask when `mode` is explicit, so this
 * yields `0o600` even under a permissive umask.
 *
 * Windows ignores the mode bits (Node maps them onto the read-only attribute only),
 * so `hardenFile` is best-effort there and never throws: the platform's ACLs are
 * what protect the file, and failing to start because of a no-op would be worse
 * than the no-op. On Unix the startup pass matters because a file written before
 * this fix keeps its old permissions until something rewrites it.
 */

/** Owner read/write only. */
export const SECRET_FILE_MODE = 0o600

/** Directory mode for the data dir: owner-only traversal, no group or other. */
export const SECRET_DIR_MODE = 0o700

/**
 * Shrinks the permissions of an existing file to `SECRET_FILE_MODE`.
 *
 * Best-effort and silent: a missing file is not an error (it will be created with
 * the right mode later), and a platform that ignores mode bits is not an error
 * either. Only the owner can be harmed by a failure here, and refusing to boot over
 * it would turn a hardening measure into an outage.
 *
 * @param path absolute path of the file to harden
 * @param label name used in the message when hardening fails
 * @param chmod injected for tests; defaults to `fs.chmod`
 */
export async function hardenFile(
  path: string,
  label: string,
  chmod: (path: string, mode: number) => Promise<void> = defaultChmod,
): Promise<void> {
  try {
    await chmod(path, SECRET_FILE_MODE)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      // Reported, not thrown: an operator on an unusual filesystem should be able
      // to see that hardening did not apply without the bridge refusing to run.
      process.stderr.write(`[cmdgo] 无法收紧 ${label} 权限(${path}):${code ?? String(error)}\n`)
    }
  }
}

/** `fs.chmod`, resolved lazily so the platform module loads only when needed. */
async function defaultChmod(path: string, mode: number): Promise<void> {
  const { chmod } = await import('node:fs/promises')
  await chmod(path, mode)
}
