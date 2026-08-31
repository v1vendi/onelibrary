/**
 * Resolving a stored path against a dropped device.
 *
 * The database records device-relative POSIX paths -- `/Contents/Artist/Track.mp3`
 * -- while a device dropped onto the page arrives as a map keyed by whatever
 * the browser reported, lowercased. Those two very nearly agree, and the ways
 * they do not are the whole reason this module exists:
 *
 *   - the stored path has a leading slash the map keys do not;
 *   - a device dropped as a *folder* carries that folder's name as a prefix on
 *     every key, so nothing matches exactly;
 *   - exFAT preserves case without distinguishing it, so matching is case-blind.
 *
 * Every part of the page that opens a file off the device goes through here --
 * the deck, the artwork, the analysis files, the validator -- so that what the
 * validator reports as present is exactly what the player can load. Two rules
 * that drifted apart would let the report call a track healthy by a resolution
 * the deck does not share.
 */

/** A stored path, in the form the file map is keyed by. */
export const devicePath = (stored) => String(stored || '').replace(/^\//, '').toLowerCase();

/**
 * Build a lookup over a dropped device: stored path -> File, or null.
 *
 * Indexed by basename rather than scanned. The folder-prefix case above means
 * a miss on the exact key is normal, not exceptional, and the obvious fallback
 * -- scan every key for one ending in the stored path -- is O(files) per
 * lookup. That is invisible for one deck load and quietly quadratic across a
 * whole library, which is the shape the validator has. Grouping by basename
 * first reduces the scan to the handful of files sharing a name.
 */
export function deviceFileIndex(files) {
  const byBasename = new Map();
  for (const path of files.keys()) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    const bucket = byBasename.get(base);
    if (bucket) bucket.push(path);
    else byBasename.set(base, [path]);
  }
  return (storedPath) => {
    const rel = devicePath(storedPath);
    if (!rel) return null;
    const exact = files.get(rel);
    if (exact) return exact;
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    for (const path of byBasename.get(base) || []) {
      if (path.endsWith(rel)) return files.get(path);
    }
    return null;
  };
}
