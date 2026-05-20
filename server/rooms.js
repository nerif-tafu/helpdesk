export function roomSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function findRoomByParam(param, rooms) {
  if (!param || !rooms.length) return null;
  const decoded = decodeURIComponent(String(param).trim());
  if (rooms.includes(decoded)) return decoded;
  const slug = roomSlug(decoded);
  return rooms.find((r) => roomSlug(r) === slug) || null;
}
