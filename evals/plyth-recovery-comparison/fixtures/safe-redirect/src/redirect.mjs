export function isSafeRedirect(location, baseUrl) {
  return location.startsWith("/");
}
