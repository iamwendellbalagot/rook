export function createSingleFlight() {
  const pending = new Map();

  return function singleFlight(key, load) {
    return load();
  };
}
