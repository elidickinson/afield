/** Poll `check` until it returns something truthy, and return that. */
export const until = async (check, what, ms = 5_000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
}
