const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];
const KIB = 1024;

export const formatBytes = (bytes: number): string => {
  if (bytes <= 0) {
    return "0 B";
  }
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(KIB)), BYTE_UNITS.length - 1);
  return `${(bytes / KIB ** i).toFixed(2)} ${BYTE_UNITS[i]}`;
};

/** `YYYY-MM-DD HH:MM:SS` (UTC), or "Unknown" for 0. */
export const formatDate = (timestamp: number): string => {
  if (!timestamp) {
    return "Unknown";
  }
  return new Date(timestamp).toISOString().replace("T", " ").slice(0, 19);
};
