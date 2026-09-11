/**
 * Pure parsers for the Copilot CLI's device-code login output.
 *
 * Kept dependency-free and separate from the plugin glue so the parsers can be
 * unit-tested without a harness, a network, or an OAuth round trip.
 *
 * The CLI prints the same facts on two channels with slightly different
 * wording; both are handled:
 *   stdout: "To authenticate, visit https://github.com/login/device and enter code E5EF-722C"
 *   stderr: "Failed to copy to clipboard. Please visit https://github.com/login/device and enter the code E5EF-722C manually."
 * and reports the account once the human finishes:
 *   "Signed in successfully as octocat."
 */

/**
 * The verification page and the user code from the CLI's device-code banner.
 * @param text - everything read from the login process so far.
 * @returns the page and code, or undefined while neither has appeared.
 */
export function parseDeviceCode(text) {
  const match = /(https:\/\/\S*?\/login\/device)[^\n]*?\bcode\s+([A-Za-z0-9][A-Za-z0-9-]*)/i.exec(text)
  return match === null ? undefined : { url: match[1], code: match[2] }
}

/**
 * The account name the CLI reports after a successful sign-in.
 * @param text - everything read from the login process so far.
 * @returns the login, or undefined before the success line appears.
 */
export function parseSignedInLogin(text) {
  const match = /Signed in successfully as\s+(\S+)/i.exec(text)
  return match === undefined || match === null ? undefined : match[1].replace(/[\s.]+$/, '')
}
