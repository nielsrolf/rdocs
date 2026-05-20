export function getRequestOrigin(request: Request): string {
  const headers = request.headers;
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  const forwardedProto =
    headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.replace(":", "");
  if (forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }
  return new URL(request.url).origin;
}
