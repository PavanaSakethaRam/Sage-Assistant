/** Pure URL policy shared with the renderer; main remains the authority. */
export function validateExternalUrl(value: string): string {
  if (
    value.length > 2048 ||
    /[\u0000-\u0020\u007F-\u009F]/u.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f|8[0-9a-f]|9[0-9a-f])/i.test(value)
  )
    throw new TypeError("Invalid external URL");
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new TypeError("Invalid external URL");
  return url.href;
}
