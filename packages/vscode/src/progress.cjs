async function runWithCancellation(token, task, progress = { report() {} }) {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const disposable = token.onCancellationRequested(() => controller.abort());
  try {
    return await task({ progress, signal: controller.signal });
  } finally {
    disposable.dispose();
  }
}

module.exports = { runWithCancellation };
