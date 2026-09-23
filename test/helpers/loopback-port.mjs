/**
 * Binds a fixture server to a loopback port that Node's built-in `fetch` will actually use.
 *
 * ## Why letting the OS choose a port is not good enough
 *
 * Asking the OS for a free port — `listen` with port `0` — looks like the obviously
 * correct choice, and it is what every fixture in this suite used to do. The OS assigns
 * from the machine's **dynamic port range**, and that range is a machine setting, not a
 * fixed default. On the machine this was diagnosed on:
 *
 *     > netsh int ipv4 show dynamicport tcp
 *     Start Port : 1024    Number of Ports : 13977        (i.e. 1024-15000)
 *
 * That range overlaps the **"bad port" list** that `fetch` refuses as a matter of policy:
 * ports the fetch spec blocks because they are historically associated with unsafe or
 * unwanted services (1, 7, 9, 21, 25, 53, 110, 143, 389, 587, 6000, 6665-6669, 6679,
 * 10080, …). When a stub happens to land on one of those, undici refuses to connect and
 * every request the bridge makes to it fails **before a single byte leaves the process**:
 *
 *     TypeError: fetch failed
 *       cause: Error: bad port
 *
 * The bridge correctly classifies that as TRANSPORT / 502. The test then fails claiming the
 * bridge mishandled a healthy upstream:
 *
 *     a clean end without finish-step is the answer, not a 502
 *     received 502 {"code":"TRANSPORT","message":"Command Code 请求失败：fetch failed"}
 *
 * ## Why retrying cannot fix it
 *
 * This is a policy refusal, not a flaky socket, so a retry re-refuses. That was measured
 * rather than assumed: across 100 runs of `params.test.mjs`, every occurrence carried
 * `bad port` as the underlying cause, and a retry wrapper absorbed **zero** of them. The
 * only fix is to stop binding ports that `fetch` may not use.
 *
 * ## The rule
 *
 * Every port on the blocked list is `<= 10080`, so any port above that is always reachable.
 * Rather than embedding a list that would go stale, this binds explicitly well above it and
 * retries only on `EADDRINUSE` — which also covers two test processes racing for the same
 * port, or a run against a machine whose ephemeral range sits somewhere unexpected.
 */

/** Comfortably above the highest blocked port (10080) and above common ephemeral ranges. */
const LOWEST_PORT = 20_000
const HIGHEST_PORT = 60_000

/** Resolves once the server is listening, or rejects with the bind error. */
function bind(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolve(server.address().port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * Listens on a loopback port that `fetch` will accept, and returns the port.
 *
 * @param {import('node:net').Server} server an unlistened server
 * @param {{ attempts?: number }} [options]
 * @returns {Promise<number>} the bound port
 */
export async function listenOnFetchablePort(server, { attempts = 50 } = {}) {
  const span = HIGHEST_PORT - LOWEST_PORT
  let lastError
  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = LOWEST_PORT + Math.floor(Math.random() * span)
    try {
      return await bind(server, port)
    } catch (error) {
      lastError = error
      const code = error?.code
      // A taken port is expected and retryable; anything else is a real problem.
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    }
  }
  throw new Error(`could not bind a fetchable loopback port in ${attempts} attempts: `
    + `${lastError?.code ?? lastError?.message}`)
}

/** Highest port the fetch spec's blocked list covers; anything above is reachable. */
export const HIGHEST_BLOCKED_PORT = 10_080
