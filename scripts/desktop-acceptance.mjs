// A displayed delta is not proof that the runtime successfully settled its run.
export async function runOutcome(result, expectedText) {
  try { return (await result).finalText === expectedText ? 'completed' : 'wrong-result'; }
  catch { return 'failed'; }
}
