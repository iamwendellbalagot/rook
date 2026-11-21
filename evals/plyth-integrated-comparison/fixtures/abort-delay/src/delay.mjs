export function delay(ms, signal) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
