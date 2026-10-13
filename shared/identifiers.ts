export function doiIdentifier(value: string): string {
  if (!/^https?:\/\/(?:dx\.)?doi\.org\//i.test(value)) return value;
  const path = new URL(value).pathname.slice(1);
  try { return decodeURIComponent(path); } catch { return path; }
}
